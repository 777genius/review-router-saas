import { setOperatorHostedAccountState } from "./hosted-pool-operator-account-state.js";
import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "@reviewrouter/platform-db";
import {
  assertWorkspaceFeatureEntitlement,
  PrismaEntitlementRepository,
} from "@reviewrouter/features-entitlements";
import {
  createPrismaHostedAccountPoolAdapters,
  createWorkspaceDefaultPool,
  CredentialEnvelopeVault,
  fingerprintCodexAuthJson,
  hostedAccountId,
  hostedPoolId,
  workspaceId,
  operatorImportHostedAccount,
  reconnectHostedAccount,
  resolveHostedCodexKeyring,
  PrismaHostedCodexSessionPersistence,
  PrismaHostedCodexMutationFence,
} from "@reviewrouter/features-hosted-account-pool";
import { assertHostedCodexProductionReadiness } from "@reviewrouter/platform-config";
import {
  createHostedPoolOperatorAuthorization,
  prismaHostedPoolOperatorMembership,
  readHostedPoolOperatorScope,
} from "./hosted-pool-operator-authorization.js";
import type {
  HostedPoolOperatorCommand,
  HostedPoolOperatorDependencies,
} from "./hosted-pool-operator-routes.js";

export type HostedPoolOperatorConnect = (input: {
  workspaceId: string;
  operatorId: string;
  repository: string;
  expectedRevision: number | null;
}) => Promise<unknown>;

export function createHostedPoolOperatorComposition(input: {
  readonly prisma: PrismaClient;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly credentialSha256: string;
  readonly connect?: HostedPoolOperatorConnect;
}): HostedPoolOperatorDependencies | undefined {
  const scope = readHostedPoolOperatorScope(input.env);
  if (!scope) return undefined;
  const prisma = input.prisma;
  const membership = prismaHostedPoolOperatorMembership(prisma);
  const authorize = createHostedPoolOperatorAuthorization({
    scope,
    membership,
    credentialSha256: input.credentialSha256,
  });
  const assertEntitled: HostedPoolOperatorDependencies["assertEntitled"] = (
    scope,
  ) =>
    assertWorkspaceFeatureEntitlement(
      {
        workspaceId: scope.workspaceId,
        actor: scope.operatorId,
        feature: "hosted_codex_pool",
      },
      { entitlements: new PrismaEntitlementRepository(prisma) },
    );
  const custody = () => {
    assertHostedCodexProductionReadiness(input.env, "api");
    const databaseIncarnation =
      input.env.REVIEW_ROUTER_HOSTED_CODEX_DATABASE_INCARNATION?.trim();
    const databaseResourceIdentity =
      input.env.REVIEW_ROUTER_HOSTED_CODEX_DATABASE_RESOURCE_IDENTITY?.trim();
    const encoded =
      input.env.REVIEW_ROUTER_HOSTED_CODEX_FINGERPRINT_PEPPER?.trim() ?? "";
    const fingerprintPepper = Buffer.from(encoded, "base64");
    if (
      !databaseIncarnation ||
      !databaseResourceIdentity ||
      databaseResourceIdentity.length < 16 ||
      fingerprintPepper.length < 32 ||
      fingerprintPepper.toString("base64") !== encoded
    )
      throw new Error("hosted_pool_custody_configuration_invalid");
    const keyring = resolveHostedCodexKeyring({
      env: input.env,
      purpose: "enrollment",
    });
    const vault = new CredentialEnvelopeVault(keyring, "relay");
    return {
      databaseIncarnation,
      databaseResourceIdentity,
      fingerprintPepper,
      vault,
      adapters: createPrismaHostedAccountPoolAdapters({
        prisma,
        vault,
        databaseIncarnation,
        databaseResourceIdentity,
        fingerprintPepper,
      }),
      persistence: new PrismaHostedCodexSessionPersistence(
        prisma,
        vault,
        databaseIncarnation,
        databaseResourceIdentity,
        fingerprintPepper,
        input.env.NODE_ENV === "production" ? keyring.currentKeyId : undefined,
      ),
    };
  };
  return {
    authorize,
    assertEntitled,
    async status(scope) {
      // Read-only selects: no enrollment, cooldown normalization or activation.
      const pool = await prisma.hostedCodexPool.findFirst({
        where: {
          workspaceId: scope.workspaceId,
          isDefault: true,
          tombstonedAt: null,
        },
        select: { id: true, status: true, revision: true },
      });
      const accounts = pool
        ? await prisma.hostedCodexAccount.findMany({
            where: {
              workspaceId: scope.workspaceId,
              poolId: pool.id,
              tombstonedAt: null,
            },
            select: {
              id: true,
              label: true,
              state: true,
              cooldownUntil: true,
              activeGeneration: true,
              healthVersion: true,
            },
            orderBy: { id: "asc" },
          })
        : [];
      const repos = await prisma.repositoryConnection.findMany({
        where: {
          workspaceId: scope.workspaceId,
          provider: "github",
          selected: true,
          archived: false,
          installation: { workspaceId: scope.workspaceId, status: "active" },
        },
        select: {
          id: true,
          fullName: true,
          visibility: true,
          provisioning: {
            orderBy: { updatedAt: "desc" },
            take: 1,
            select: { pullRequestUrl: true },
          },
        },
        orderBy: { id: "asc" },
      });
      const repositories = [];
      for (const repo of repos) {
        const binding = await prisma.hostedCodexRepositoryBinding.findFirst({
          where: {
            repositoryConnectionId: repo.id,
            workspaceId: scope.workspaceId,
            tombstonedAt: null,
          },
          select: { id: true, poolId: true, revision: true, status: true },
        });
        repositories.push({
          id: repo.id,
          fullName: repo.fullName,
          eligible: ["public", "private", "internal"].includes(repo.visibility),
          bindingId: binding?.id ?? null,
          bindingRevision: binding ? safeNumber(binding.revision) : null,
          bindingState: binding?.status ?? null,
          poolId: binding?.poolId ?? null,
          setupPrUrl: repo.provisioning[0]?.pullRequestUrl ?? null,
        });
      }
      return {
        pool: pool ? { ...pool, revision: safeNumber(pool.revision) } : null,
        accounts: accounts.map((a) => ({
          id: a.id,
          label: a.label,
          availability: a.state,
          cooldownUntil: a.cooldownUntil,
          generation:
            a.activeGeneration === null ? null : safeNumber(a.activeGeneration),
          healthVersion: safeNumber(a.healthVersion),
        })),
        repositories,
      };
    },
    async execute(scope, command: HostedPoolOperatorCommand, auth) {
      // Recheck immediately before dispatch; no cached browser session or token-derived workspace.
      if (!(await membership.isCurrentAdmin(scope, scope.workspaceId)))
        throw new Error("hosted_pool_operator_forbidden");
      if (command.action === "connect") {
        if (!input.connect)
          throw new Error("hosted_pool_connect_composition_unavailable");
        return input.connect({
          workspaceId: scope.workspaceId,
          operatorId: scope.operatorId,
          repository: command.input.repository,
          expectedRevision: command.input.expectedRevision,
        });
      }
      const { adapters, fingerprintPepper, persistence } = custody();
      const id = workspaceId(scope.workspaceId);
      if (command.action === "import") {
        if (!auth) throw new Error("hosted_pool_auth_invalid");
        const pool = await createWorkspaceDefaultPool(
          { id: hostedPoolId(randomUUID()), workspaceId: id, now: new Date() },
          adapters.pools,
        );
        return operatorImportHostedAccount(
          {
            workspaceId: id,
            poolId: pool.id,
            accountId: hostedAccountId(randomUUID()),
            label: command.input.label,
            priority: 0,
            expectedPoolRevision: pool.revision,
            authJsonBytes: auth,
            requestedAt: new Date(),
          },
          {
            ...adapters,
            fingerprint: (bytes) =>
              fingerprintCodexAuthJson(bytes, fingerprintPepper),
          },
        );
      }
      const scoped = await prisma.hostedCodexAccount.findFirst({
        where: {
          id: command.input.accountId,
          workspaceId: scope.workspaceId,
          tombstonedAt: null,
          pool: {
            workspaceId: scope.workspaceId,
            isDefault: true,
            status: "active",
            tombstonedAt: null,
          },
        },
        select: { id: true },
      });
      if (!scoped) throw new Error("hosted_pool_operator_forbidden");
      const account = await adapters.accounts.findById(
        hostedAccountId(scoped.id),
      );
      const pool = account
        ? await adapters.pools.findById(account.poolId)
        : null;
      if (!account || !pool || pool.workspaceId !== id || !pool.isDefault)
        throw new Error("hosted_pool_operator_forbidden");
      if (command.action === "replace") {
        if (!auth) throw new Error("hosted_pool_auth_invalid");
        const fences = new PrismaHostedCodexMutationFence(prisma);
        return reconnectHostedAccount(
          {
            workspaceId: id,
            poolId: pool.id,
            accountId: account.id,
            expectedGeneration: command.input.expectedGeneration,
            expectedHealthVersion: command.input.expectedHealthVersion,
            authJsonBytes: auth,
          },
          {
            accounts: adapters.accounts,
            validate: (bytes) => ({
              fingerprint: fingerprintCodexAuthJson(bytes, fingerprintPepper),
              generationHash: createHash("sha256").update(bytes).digest("hex"),
            }),
            acquire: async (accountId) => {
              const lease = await fences.acquire({
                accountId,
                runId: `operator:${randomUUID()}`,
                attempt: 1,
                ttlMs: 30000,
                restoredGenerationHash: "operator-reconnect",
              });
              if (lease.status !== "granted")
                throw new Error("hosted_pool_reconnect_busy");
              return lease.leaseId;
            },
            release: (leaseId) =>
              fences.release({
                leaseId,
                reason: "operator_reconnect_finished",
              }),
            commit: (command) => persistence.reconnect(command),
          },
        );
      }
      return setOperatorHostedAccountState({
        prisma,
        workspaceId: scope.workspaceId,
        accountId: account.id,
        operatorId: scope.operatorId,
        action: command.action,
        expectedHealthVersion: command.input.expectedHealthVersion,
      });
    },
  };
}

function safeNumber(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0)
    throw new Error("hosted_pool_version_invalid");
  return number;
}
