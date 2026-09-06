import { randomUUID } from "node:crypto";
import {
  bindRepositoryToDefaultPool,
  createPrismaHostedAccountPoolAdapters,
  createWorkspaceDefaultPool,
  CredentialEnvelopeVault,
  hostedAccountId,
  hostedBindingId,
  hostedPoolId,
  importAndEnrollHostedCodexAccount,
  repositoryId,
  resolveHostedCodexKeyring,
  setHostedAccountAvailability,
  switchRepositoryToRepositoryOwnedRotating,
  workspaceId,
  type RepositoryReviewConfigurationAuthModeAuthority,
} from "@reviewrouter/features-hosted-account-pool";
import { switchRepositoryConfigurationAuthMode } from "@reviewrouter/features-workflow-provisioning";
export { switchRepositoryConfigurationAuthMode } from "@reviewrouter/features-workflow-provisioning";
import type { PrismaClient } from "@reviewrouter/platform-db";
import { assertHostedCodexProductionReadiness } from "@reviewrouter/platform-config";
import type { HostedPoolDashboardMutationPort } from "./hosted-pool-dashboard";

export function createPrismaHostedPoolDashboardMutationPort(input: {
  readonly prisma: PrismaClient;
  readonly env: Readonly<Record<string, string | undefined>>;
}): HostedPoolDashboardMutationPort {
  const createAdapters = () => {
    assertHostedCodexProductionReadiness(input.env, "web");
    const databaseIncarnation =
      input.env.REVIEW_ROUTER_HOSTED_CODEX_DATABASE_INCARNATION?.trim();
    const encodedPepper =
      input.env.REVIEW_ROUTER_HOSTED_CODEX_FINGERPRINT_PEPPER?.trim();
    if (!databaseIncarnation)
      throw new Error("hosted_codex_database_incarnation_missing");
    const databaseResourceIdentity =
      input.env.REVIEW_ROUTER_HOSTED_CODEX_DATABASE_RESOURCE_IDENTITY?.trim();
    if (!databaseResourceIdentity || databaseResourceIdentity.length < 16) {
      throw new Error("hosted_codex_database_resource_identity_invalid");
    }
    if (!encodedPepper)
      throw new Error("hosted_codex_fingerprint_pepper_missing");
    const fingerprintPepper = Buffer.from(encodedPepper, "base64");
    if (
      fingerprintPepper.byteLength < 32 ||
      fingerprintPepper.toString("base64") !== encodedPepper
    ) {
      throw new Error("hosted_codex_fingerprint_pepper_invalid");
    }
    const keyring = resolveHostedCodexKeyring({
      env: input.env,
      purpose: "enrollment",
    });
    return createPrismaHostedAccountPoolAdapters({
      prisma: input.prisma,
      vault: new CredentialEnvelopeVault(keyring, "relay"),
      databaseIncarnation,
      databaseResourceIdentity,
      fingerprintPepper,
      configurationAuthority: createRepositoryConfigurationAuthority(),
    });
  };

  return {
    async importAccount(command) {
      const adapters = createAdapters();
      const authJson = command.authJson;
      const commandWorkspaceId = workspaceId(command.workspaceId);
      try {
        const pool = await createWorkspaceDefaultPool(
          {
            id: hostedPoolId(randomUUID()),
            workspaceId: commandWorkspaceId,
            now: command.requestedAt,
          },
          adapters.pools,
        );
        await importAndEnrollHostedCodexAccount(
          {
            workspaceId: commandWorkspaceId,
            poolId: pool.id,
            accountId: hostedAccountId(randomUUID()),
            label: command.label,
            priority: command.priority,
            expectedPoolRevision: pool.revision,
            authJsonBytes: authJson,
            requestedAt: command.requestedAt,
          },
          { credentialEnrollment: adapters.credentialEnrollment },
        );
      } finally {
        authJson.fill(0);
      }
    },

    async setAccountState(command) {
      const adapters = createAdapters();
      const account = await adapters.accounts.findById(
        hostedAccountId(command.accountId),
      );
      const pool = account
        ? await adapters.pools.findById(account.poolId)
        : null;
      if (
        !account ||
        !pool ||
        pool.workspaceId !== workspaceId(command.workspaceId)
      )
        throw new Error("hosted_account_not_found");
      await setHostedAccountAvailability(
        {
          accountId: hostedAccountId(command.accountId),
          expectedHealthVersion: command.expectedVersion,
          availability:
            command.state === "healthy"
              ? { status: "healthy" }
              : {
                  status: "paused",
                  reason: "Paused by a workspace administrator",
                },
          now: command.requestedAt,
        },
        adapters.accounts,
      );
    },

    async setRepositorySource(command) {
      const adapters = createAdapters();
      const commandRepositoryId = repositoryId(command.repositoryId);
      const commandWorkspaceId = workspaceId(command.workspaceId);
      if (command.source === "hosted_workspace_pool") {
        const binding = await bindRepositoryToDefaultPool(
          {
            bindingId: hostedBindingId(randomUUID()),
            repositoryId: commandRepositoryId,
            workspaceId: commandWorkspaceId,
            expectedRevision:
              command.expectedVersion === 0 ? null : command.expectedVersion,
            now: command.requestedAt,
          },
          { pools: adapters.pools, bindings: adapters.bindings },
        );
        return {
          activation: binding.status === "active" ? "active" : "pending",
          bindingId: String(binding.bindingId),
          bindingRevision: binding.revision,
        };
      } else {
        if (command.expectedVersion < 1)
          throw new Error("hosted_pool_binding_revision_conflict");
        await switchRepositoryToRepositoryOwnedRotating(
          {
            repositoryId: commandRepositoryId,
            workspaceId: commandWorkspaceId,
            expectedBindingRevision: command.expectedVersion,
            now: command.requestedAt,
          },
          {
            bindings: adapters.bindings,
            authModeSwitch: adapters.authModeSwitch,
          },
        );
      }
      return { activation: "pending" };
    },
  };
}

export function createRepositoryConfigurationAuthority(): RepositoryReviewConfigurationAuthModeAuthority {
  return {
    async switchToRepositoryOwnedRotating(input) {
      return switchRepositoryConfigurationAuthMode({
        transaction: input.transaction,
        workspaceId: input.workspaceId,
        repositoryId: input.repositoryId,
        authMode: "codex_subscription_oauth_rotating",
      });
    },
  };
}
