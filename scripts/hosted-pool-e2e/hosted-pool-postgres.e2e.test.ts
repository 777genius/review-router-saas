import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CredentialEnvelopeVault,
  EnvCredentialKeyring,
  FetchHostedCodexStreamingRelay,
  HostedCodexSessionStore,
  HostedCodexMutationFenceLeaseStore,
  HostedCodexSessionRuntime,
  PrismaHostedAccountRepository,
  PrismaHostedCodexMutationFence,
  PrismaHostedCodexRelayAuthorization,
  PrismaHostedCodexRestoreReconciler,
  PrismaHostedCodexSessionPersistence,
  PrismaHostedCodexUpstreamEffectLedger,
  PrismaHostedCredentialEnrollment,
  PrismaHostedPoolBindingRepository,
  PrismaHostedPoolRepository,
  PrismaHostedCommentTokenMintLedger as BasePrismaHostedCommentTokenMintLedger,
  PrismaInvocationGrantRepository,
  createDefaultHostedAccountPool,
  failoverCurrentRelayRequestBeforeEffect,
  hostedAccountId,
  hostedBindingId,
  hostedCodexCommentTokenPath,
  hostedCodexGrantPath,
  hostedCodexResponsesPath,
  hostedPoolId,
  invocationGrantId,
  invocationId,
  issueHostedPoolInvocationGrant,
  registerHostedCodexRelayRoutes,
  recordHostedPoolProviderResponseStarted,
  recordHostedPoolSuccessfulProviderResponse,
  reconcileExpiredInvocationGrants,
  relayRequestId,
  repositoryId,
  workspaceId,
  type HostedCodexUpstreamEffectLease,
  type InvocationGrantCapabilityPort,
} from "../../packages/features/hosted-account-pool/src/index";
import { createPrismaClient } from "../../packages/platform/db/src/index";
import { HostedCodexCommentTokenIssuer } from "../../apps/api/src/hosted-codex-comment-token-composition";
import { createRenderHostedPoolControlPort } from "../hosted-pool-production-control";
import {
  checkedMintTemporalFixture,
  runHostedPoolFixtureTeardown,
} from "./hosted-pool-postgres-fixture-contract";

const databaseUrl = process.env.REVIEW_ROUTER_HOSTED_POOL_E2E_DATABASE_URL;
const custodyDatabaseUrl =
  process.env.REVIEW_ROUTER_HOSTED_POOL_E2E_CUSTODY_DATABASE_URL;
const apiDatabaseUrl =
  process.env.REVIEW_ROUTER_HOSTED_POOL_E2E_API_DATABASE_URL;
if (!databaseUrl) throw new Error("hosted_pool_e2e_database_url_required");
if (!custodyDatabaseUrl)
  throw new Error("hosted_pool_e2e_custody_database_url_required");
if (!apiDatabaseUrl)
  throw new Error("hosted_pool_e2e_api_database_url_required");
const parsedDatabaseUrl = new URL(databaseUrl);
if (
  !["127.0.0.1", "localhost"].includes(parsedDatabaseUrl.hostname) ||
  !parsedDatabaseUrl.pathname.startsWith("/reviewrouter_hosted_pool_e2e_")
) {
  throw new Error("hosted_pool_e2e_database_must_be_disposable_loopback");
}

const prisma = createPrismaClient({ databaseUrl, poolMax: 12 });
const custodyPrisma = createPrismaClient({
  databaseUrl: custodyDatabaseUrl,
  poolMax: 8,
});
const apiPrisma = createPrismaClient({
  databaseUrl: apiDatabaseUrl,
  poolMax: 2,
});
class PrismaHostedCommentTokenMintLedger extends BasePrismaHostedCommentTokenMintLedger {
  constructor(
    _prisma: Parameters<typeof createPrismaClient>[0] extends never
      ? never
      : unknown,
    testHooks?: ConstructorParameters<
      typeof BasePrismaHostedCommentTokenMintLedger
    >[1],
  ) {
    super(custodyPrisma, testHooks);
  }
}
const now = new Date();
const workspace = workspaceId("workspace-e2e");
const pool = hostedPoolId("pool-e2e");
const repository = repositoryId("repository-e2e");
const installation = "installation-e2e";
const binding = hostedBindingId("binding-e2e");
const databaseIncarnation = "disposable-postgres-e2e-incarnation";
const databaseResourceIdentity = "disposable-postgres-e2e-resource";
const keyringEnv = {
  REVIEW_ROUTER_HOSTED_CODEX_KEK_CURRENT_ID: "e2e-kek",
  REVIEW_ROUTER_HOSTED_CODEX_KEK_KEYRING_JSON: JSON.stringify({
    "e2e-kek": Buffer.alloc(32, 17).toString("base64"),
  }),
};
const vault = new CredentialEnvelopeVault(new EnvCredentialKeyring(keyringEnv));
const ledger = new PrismaInvocationGrantRepository(prisma);
const grantCapabilities = deterministicCapability("relay");
const apps: Array<ReturnType<typeof Fastify>> = [];

beforeAll(async () => {
  await prisma.$connect();
  await custodyPrisma.$connect();
  await apiPrisma.$connect();
  await transitionRuntimeGate("active", "postgres_e2e_activation");
  await prisma.workspace.create({
    data: { id: workspace, slug: "hosted-pool-e2e", name: "Hosted pool E2E" },
  });
  await prisma.gitHubInstallation.create({
    data: {
      id: installation,
      workspaceId: workspace,
      githubInstallationId: 900001n,
      accountLogin: "disposable-e2e",
      accountType: "Organization",
      repositorySelection: "selected",
      status: "active",
    },
  });
  await prisma.repositoryConnection.create({
    data: {
      id: repository,
      workspaceId: workspace,
      provider: "github",
      externalRepositoryId: "900002",
      installationId: installation,
      githubRepositoryId: 900002n,
      owner: "disposable-e2e",
      name: "private-fixture",
      fullName: "disposable-e2e/private-fixture",
      defaultBranch: "main",
      visibility: "private",
      selected: true,
      archived: false,
    },
  });
  await new PrismaHostedPoolRepository(prisma).insertDefault(
    createDefaultHostedAccountPool({ id: pool, workspaceId: workspace, now }),
  );
  const enrollment = new PrismaHostedCredentialEnrollment(
    prisma,
    vault,
    databaseIncarnation,
    databaseResourceIdentity,
    Buffer.alloc(32, 29),
  );
  await enrollment.importCodexAuth({
    workspaceId: workspace,
    poolId: pool,
    accountId: hostedAccountId("account-primary"),
    label: "Primary",
    priority: 0,
    expectedPoolRevision: 1,
    authJsonBytes: validAuthJson(
      "primary",
      "primary-access",
      "primary-refresh",
    ),
    now,
  });
  await enrollment.importCodexAuth({
    workspaceId: workspace,
    poolId: pool,
    accountId: hostedAccountId("account-backup"),
    label: "Backup",
    priority: 1,
    expectedPoolRevision: 2,
    authJsonBytes: validAuthJson("backup", "backup-access", "backup-refresh"),
    now,
  });
  await prisma.hostedCodexRepositoryBinding.create({
    data: {
      id: binding,
      workspaceId: workspace,
      poolId: pool,
      repositoryConnectionId: repository,
      status: "active",
      revision: 1n,
      stateVersion: 1n,
      workflowPath: ".github/workflows/reviewrouter.yml",
      workflowActionRef: `reviewrouter/action@${"a".repeat(40)}`,
      workflowSourceCommitSha: "b".repeat(40),
      workflowSourceBlobSha: "c".repeat(40),
      workflowSourceSha256: "d".repeat(64),
      workflowSemanticSha256: "e".repeat(64),
      workflowSourceTrust: "trusted_default_branch_revision",
      attestedGithubRepositoryId: 900002n,
      attestedBindingRevision: 1n,
      activatedAt: now,
    },
  });
}, 120_000);

afterAll(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await prisma.$disconnect();
  await custodyPrisma.$disconnect();
  await apiPrisma.$disconnect();
}, 120_000);

describe("hosted pool production adapters on disposable PostgreSQL 17", () => {
  it("preserves mint-lock execute authority only for custody after runtime ACL convergence", async () => {
    const privileges = await prisma.$queryRawUnsafe<
      Array<{ principal: string; canExecute: boolean }>
    >(`
      SELECT principal,
        has_function_privilege(
          principal,
          'public.hosted_codex_lock_comment_token_mint(text)',
          'EXECUTE'
        ) AS "canExecute"
      FROM unnest(ARRAY[
        'public',
        'reviewrouter_api',
        'reviewrouter_web',
        'reviewrouter_worker',
        'reviewrouter_codex_effect_authority',
        'reviewrouter_comment_token_custody'
      ]) principal
      ORDER BY principal
    `);
    expect(privileges).toEqual([
      { principal: "public", canExecute: false },
      { principal: "reviewrouter_api", canExecute: false },
      { principal: "reviewrouter_codex_effect_authority", canExecute: false },
      { principal: "reviewrouter_comment_token_custody", canExecute: true },
      { principal: "reviewrouter_web", canExecute: false },
      { principal: "reviewrouter_worker", canExecute: false },
    ]);
    await expect(
      custodyPrisma.$queryRawUnsafe<Array<{ locked: boolean }>>(
        `SELECT public.hosted_codex_lock_comment_token_mint('acl-convergence-probe-missing') AS locked`,
      ),
    ).resolves.toEqual([{ locked: false }]);
    await expect(
      apiPrisma.$queryRawUnsafe(
        `SELECT public.hosted_codex_lock_comment_token_mint('acl-convergence-probe-missing')`,
      ),
    ).rejects.toThrow(/permission denied/iu);
  });

  it("recovers stale mint states globally oldest-first in one bounded starvation-free batch", async () => {
    const mintLedger = new PrismaHostedCommentTokenMintLedger(prisma);
    const mintIds = {
      prepared: "comment-mint-startup-recovery-prepared",
      dispatching: "comment-mint-startup-recovery-dispatching",
      outcomeUnknown: "comment-mint-startup-recovery-outcome-unknown",
    } as const;
    const grantIds = (Object.keys(mintIds) as Array<keyof typeof mintIds>).map(
      (label) => invocationGrantId(`grant-startup-recovery-${label}`),
    );
    const createMint = async (
      label: keyof typeof mintIds,
      state: "prepared" | "dispatching" | "outcome_unknown",
    ) => {
      const issued = await issueGrant(`startup-recovery-${label}`);
      const ownerIdHash = sha256(`startup-recovery-owner:${label}`);
      const callerNow = new Date();
      const prepared = await mintLedger.prepare({
        mintId: mintIds[label],
        purpose: "initial",
        ownerIdHash,
        logicalKeyHash: sha256(`startup-recovery-logical:${label}`),
        requestFingerprintHash: sha256(`startup-recovery-fingerprint:${label}`),
        grantId: issued.grant.id,
        bindingId: binding,
        bindingVersion: 1,
        now: callerNow,
        leaseExpiresAt: new Date(callerNow.getTime() + 30_000),
      });
      if (prepared.state !== "prepared")
        throw new Error("postgres_e2e_startup_recovery_prepare_failed");
      if (state !== "prepared") {
        const dispatchNow = new Date();
        await mintLedger.authorizeDispatch({
          mintId: prepared.mintId,
          ownerIdHash,
          now: dispatchNow,
          dispatchAuthorizedUntil: new Date(dispatchNow.getTime() + 15_000),
          unsafeUntil: new Date(dispatchNow.getTime() + 61 * 60_000),
        });
        if (state === "outcome_unknown")
          await mintLedger.finalizeOutcomeUnknown({
            mintId: prepared.mintId,
            ownerIdHash,
            now: new Date(),
            errorCode: "postgres_e2e_simulated_ambiguous_outcome",
          });
      }
    };

    try {
      await createMint("prepared", "prepared");
      await createMint("dispatching", "dispatching");
      await createMint("outcomeUnknown", "outcome_unknown");

      await expect(
        custodyPrisma.$queryRawUnsafe(
          `SELECT * FROM public.hosted_codex_mutate_comment_token_mint('recover_stale','{}'::jsonb)`,
        ),
      ).rejects.toThrow(/hosted_codex_comment_token_recovery_batch_invalid/iu);
      await expect(mintLedger.recoverStale({ limit: 3 })).resolves.toBe(0);

      const newerPreparedEligibility = new Date(Date.now() - 10 * 60_000);
      const olderDispatchLease = new Date(Date.now() - 40 * 60_000);
      const olderDispatchAuthorization = new Date(Date.now() - 30 * 60_000);
      const olderDispatchEligibility = new Date(Date.now() - 20 * 60_000);
      const oldestOutcomeEligibility = new Date(Date.now() - 30 * 60_000);
      const outcomeUnknownTemporalShape = checkedMintTemporalFixture({
        dispatchAuthorizedUntil: new Date(Date.now() - 40 * 60_000),
        unsafeUntil: oldestOutcomeEligibility,
      });
      await prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(
          `SET LOCAL session_replication_role = 'replica'`,
        );
        await transaction.hostedCodexCommentTokenMint.update({
          where: { id: mintIds.prepared },
          data: { leaseExpiresAt: newerPreparedEligibility },
        });
        await transaction.hostedCodexCommentTokenMint.update({
          where: { id: mintIds.dispatching },
          data: {
            leaseExpiresAt: olderDispatchLease,
            dispatchAuthorizedUntil: olderDispatchAuthorization,
            unsafeUntil: olderDispatchEligibility,
          },
        });
        await transaction.hostedCodexCommentTokenMint.update({
          where: { id: mintIds.outcomeUnknown },
          data: outcomeUnknownTemporalShape,
        });
      });

      const states = () =>
        prisma.hostedCodexCommentTokenMint.findMany({
          where: { id: { in: Object.values(mintIds) } },
          orderBy: { id: "asc" },
          select: {
            id: true,
            state: true,
            providerAttempt: true,
            terminalEvidenceHash: true,
          },
        });

      await expect(mintLedger.recoverStale({ limit: 1 })).resolves.toBe(1);
      await expect(states()).resolves.toEqual([
        expect.objectContaining({
          id: mintIds.dispatching,
          state: "dispatching",
        }),
        expect.objectContaining({
          id: mintIds.outcomeUnknown,
          state: "expired",
          providerAttempt: 1,
          terminalEvidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
        expect.objectContaining({ id: mintIds.prepared, state: "prepared" }),
      ]);

      await expect(mintLedger.recoverStale({ limit: 1 })).resolves.toBe(1);
      await expect(states()).resolves.toEqual([
        expect.objectContaining({
          id: mintIds.dispatching,
          state: "outcome_unknown",
          providerAttempt: 1,
          terminalEvidenceHash: null,
        }),
        expect.objectContaining({
          id: mintIds.outcomeUnknown,
          state: "expired",
        }),
        expect.objectContaining({ id: mintIds.prepared, state: "prepared" }),
      ]);

      await expect(mintLedger.recoverStale({ limit: 1 })).resolves.toBe(1);
      await expect(mintLedger.recoverStale({ limit: 1 })).resolves.toBe(1);
      await expect(mintLedger.recoverStale({ limit: 1 })).resolves.toBe(0);
      await expect(states()).resolves.toEqual([
        expect.objectContaining({
          id: mintIds.dispatching,
          state: "expired",
          providerAttempt: 1,
          terminalEvidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
        expect.objectContaining({
          id: mintIds.outcomeUnknown,
          state: "expired",
          providerAttempt: 1,
          terminalEvidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
        expect.objectContaining({
          id: mintIds.prepared,
          state: "failed_no_token",
          providerAttempt: 0,
          terminalEvidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
      ]);
      await expect(
        prisma.hostedCodexCommentTokenMint.count({
          where: { id: { in: Object.values(mintIds) }, state: "expired" },
        }),
      ).resolves.toBe(2);
    } finally {
      await runHostedPoolFixtureTeardown(
        () =>
          cleanupCommentTokenMintFixtures({
            mintIds: Object.values(mintIds),
            grantIds,
          }),
        () =>
          restoreRuntimeGateActive(
            "postgres_e2e_startup_recovery_fixture_restore",
          ),
      );
    }
  });

  it("expires elapsed revoke-pending custody and unblocks closure reactivation", async () => {
    const issuedMintId = "comment-mint-security-elapsed-revoke-pending";
    const stalePreparedId = "comment-mint-mixed-stale-prepared";
    const grantIds = [
      invocationGrantId("grant-security-elapsed-revoke-pending"),
      invocationGrantId("grant-elapsed-revoke-pending-mixed-prepared"),
    ];
    try {
      const issued = await createIssuedMint("elapsed-revoke-pending");
      const stalePreparedGrant = await issueGrant(
        "elapsed-revoke-pending-mixed-prepared",
      );
      await issued.ledger.prepare({
        mintId: stalePreparedId,
        purpose: "initial",
        ownerIdHash: sha256("mixed-stale-prepared-owner"),
        logicalKeyHash: sha256(stalePreparedId),
        requestFingerprintHash: sha256(`fingerprint:${stalePreparedId}`),
        grantId: stalePreparedGrant.grant.id,
        bindingId: binding,
        bindingVersion: 1,
        now: new Date(),
        leaseExpiresAt: new Date(Date.now() + 30_000),
      });
      await issued.ledger.stageRevocation({
        mintId: issued.mintId,
        tokenHash: issued.tokenHash,
        tokenExpiresAt: issued.tokenExpiresAt,
        now: new Date(),
        errorCode: "postgres_e2e_elapsed_revoke_pending",
      });
      const closed = await transitionRuntimeGate(
        "closed",
        "postgres_e2e_elapsed_revoke_pending_close",
      );
      await createElapsedTestRuntimeClosure({
        id: `runtime-closure-${closed.revision}`,
        gateRevision: closed.revision,
        closedAuthzEpoch: closed.authzEpoch,
        actorHash: sha256("postgres-e2e-elapsed-revoke-pending"),
        reasonHash: sha256("postgres-e2e-elapsed-revoke-pending"),
        legacyBarrier: true,
        legacyUnsafeUntil: new Date(Date.now() + 61 * 60_000),
      });
      const elapsedTemporalShape = checkedMintTemporalFixture({
        dispatchAuthorizedUntil: new Date(Date.now() - 90_000),
        tokenExpiresAt: new Date(Date.now() - 120_000),
        unsafeUntil: new Date(Date.now() - 60_000),
      });
      await prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(
          `SET LOCAL session_replication_role = 'replica'`,
        );
        await transaction.hostedCodexCommentTokenMint.update({
          where: { id: issued.mintId },
          data: {
            ...elapsedTemporalShape,
            leaseExpiresAt: new Date(0),
          },
        });
        await transaction.hostedCodexCommentTokenMint.update({
          where: { id: stalePreparedId },
          data: { leaseExpiresAt: new Date(Date.now() - 30_000) },
        });
      });

      await expect(
        transitionRuntimeGate(
          "active",
          "postgres_e2e_elapsed_revoke_pending_too_early",
        ),
      ).rejects.toThrow("hosted_codex_runtime_closure_unsafe");
      await expect(issued.ledger.recoverStale({ limit: 1 })).resolves.toBe(1);
      await expect(
        prisma.hostedCodexCommentTokenMint.findUniqueOrThrow({
          where: { id: stalePreparedId },
          select: { state: true },
        }),
      ).resolves.toEqual({ state: "prepared" });
      await expect(
        prisma.hostedCodexCommentTokenMint.findUniqueOrThrow({
          where: { id: issued.mintId },
          select: {
            state: true,
            terminalEvidenceHash: true,
            revocationEvidenceHash: true,
            secretCiphertext: true,
            secretEncryptedDataKey: true,
          },
        }),
      ).resolves.toEqual({
        state: "expired",
        terminalEvidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        revocationEvidenceHash: null,
        secretCiphertext: null,
        secretEncryptedDataKey: null,
      });
      await expect(issued.ledger.recoverStale({ limit: 1 })).resolves.toBe(1);
      await expect(
        transitionRuntimeGate(
          "active",
          "postgres_e2e_elapsed_revoke_pending_reactivate",
        ),
      ).resolves.toMatchObject({ status: "active" });
    } finally {
      await runHostedPoolFixtureTeardown(
        () =>
          cleanupCommentTokenMintFixtures({
            mintIds: [issuedMintId, stalePreparedId],
            grantIds,
          }),
        () =>
          restoreRuntimeGateActive(
            "postgres_e2e_elapsed_revoke_pending_fixture_restore",
          ),
      );
    }
  });

  it("runs real grant, relay ledgers, comment capability, parallel inference, and replay fences", async () => {
    let grantIssueError: unknown;
    let activeUpstreams = 0;
    let maximumActiveUpstreams = 0;
    let upstreamCalls = 0;
    const relayErrors: Array<{
      readonly phase: string;
      readonly error: unknown;
    }> = [];
    let releaseParallel: (() => void) | undefined;
    const parallelStarted = new Promise<void>((resolve) => {
      releaseParallel = resolve;
    });
    const parallelSafetyTimer = setTimeout(() => releaseParallel?.(), 90_000);
    const runtime = {
      ensureFreshSession: vi.fn(async () => ({
        accessToken: "fake-provider-access-token",
        chatgptAccountId: "fake-chatgpt-account",
        credentialGeneration:
          await activeCredentialGeneration("account-primary"),
      })),
      classifyFailure: vi.fn(() => ({ code: "unknown" })),
    } as unknown as HostedCodexSessionRuntime;
    const fakeUpstreamFetch = vi.fn(
      async (_url: string | URL, init?: RequestInit) => {
        upstreamCalls += 1;
        activeUpstreams += 1;
        maximumActiveUpstreams = Math.max(
          maximumActiveUpstreams,
          activeUpstreams,
        );
        if (activeUpstreams === 2) releaseParallel?.();
        await parallelStarted;
        activeUpstreams -= 1;
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe(
          "Bearer fake-provider-access-token",
        );
        expect(headers.get("chatgpt-account-id")).toBe("fake-chatgpt-account");
        const upstreamBody =
          init?.body instanceof Uint8Array
            ? Buffer.from(init.body).toString("utf8")
            : String(init?.body);
        expect(upstreamBody).toContain('"store":false');
        return new Response(
          'data: {"type":"response.completed"}\n\ndata: [DONE]\n\n',
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        );
      },
    );
    const commentTokenCalls = vi.fn(async () => ({
      token: "fake-comment-token",
      repository: "disposable-e2e/private-fixture",
      expiresAt: new Date(Date.now() + 60_000),
      permissions: {
        contents: "read" as const,
        pullRequests: "write" as const,
        issues: "write" as const,
        statuses: "write" as const,
      },
    }));
    const prepareCommentToken = vi.fn(async (input) => ({
      send: async ({ signal }: { readonly signal?: AbortSignal }) =>
        commentTokenCalls({ ...input, signal }),
    }));
    const app = Fastify({ logger: false });
    apps.push(app);
    const realAuthorization = new PrismaHostedCodexRelayAuthorization(prisma);
    const realRelay = new FetchHostedCodexStreamingRelay(
      runtime,
      ledger,
      fakeUpstreamFetch as typeof fetch,
    );
    const realCommentTokens = new HostedCodexCommentTokenIssuer({
      prisma,
      mintLedger: new PrismaHostedCommentTokenMintLedger(prisma),
      commentTokens: {
        issueCommentToken: commentTokenCalls,
        prepareCommentToken,
      },
      clock: { now: () => new Date() },
      secretVault: {
        async prepareSeal() {
          return {
            capture: (token: string) => testSecretEnvelope(token),
            destroy() {},
          };
        },
        async seal({ token }) {
          return {
            ciphertext: Buffer.from(token),
            encryptedDataKey: Buffer.from("test-key"),
            iv: Buffer.from("test-iv"),
            authTag: Buffer.from("test-tag"),
            keyId: "test-key",
            aadHash: "a".repeat(64),
          };
        },
        async open({ envelope }) {
          return Buffer.from(envelope.ciphertext);
        },
      },
    });
    await registerHostedCodexRelayRoutes(app, {
      enabled: true,
      grants: {
        issue: async (request) => {
          let issued: Awaited<ReturnType<typeof issueGrant>>;
          try {
            issued = await issueGrant(`route-${request.providerInstanceId}`);
          } catch (error) {
            grantIssueError = error;
            throw error;
          }
          return {
            protocolVersion: 1,
            grant: issued.plaintextToken,
            relayUrl: hostedCodexResponsesPath,
            invocationLeaseId: issued.grant.id,
            runtimeConfigVersion: 1,
            runtimeEnv: { REVIEW_PROVIDERS: "codex/gpt-5.5" },
            repository: "disposable-e2e/private-fixture",
            commentToken: "initial-comment-token",
            commentTokenRefreshCapability: issued.commentRefreshPlaintextToken,
            grantExpiresAt: issued.grant.budget.expiresAt.toISOString(),
            policy: { maxRequests: 4, maxRequestBodyBytes: 16_384 },
          };
        },
      },
      commentTokens: {
        issue: async (input) => {
          try {
            return await realCommentTokens.issue(input);
          } catch (error) {
            relayErrors.push({ phase: "comment-refresh", error });
            throw error;
          }
        },
      },
      authorization: {
        authorize: async (input) => {
          try {
            return await realAuthorization.authorize(input);
          } catch (error) {
            relayErrors.push({ phase: "authorize/admit", error });
            throw error;
          }
        },
      },
      relay: {
        open: async (input) => {
          try {
            return await realRelay.open(input);
          } catch (error) {
            relayErrors.push({ phase: "open/hash/start", error });
            throw error;
          }
        },
      },
    });
    await app.listen({ host: "127.0.0.1", port: 0 });

    const grants = await Promise.all([
      requestGrant(app.listeningOrigin, "parallel-a", () => grantIssueError),
      requestGrant(app.listeningOrigin, "parallel-b", () => grantIssueError),
    ]);
    const responses = await Promise.all(
      grants.map((grant, index) =>
        fetch(`${app.listeningOrigin}${hostedCodexResponsesPath}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${grant.grant}`,
            accept: "text/event-stream",
            "content-type": "application/json",
            "idempotency-key": `relay-${index + 1}`,
            "x-reviewrouter-request-ordinal": "1",
          },
          body: JSON.stringify({ input: `turn-${index + 1}` }),
        }),
      ),
    );
    if (responses.some((response) => response.status !== 200)) {
      clearTimeout(parallelSafetyTimer);
      throw new Error(
        `relay route failed: ${relayErrors
          .map(({ phase, error }) => `${phase}: ${errorStack(error)}`)
          .join(" | ")}`,
      );
    }
    clearTimeout(parallelSafetyTimer);
    await Promise.all(responses.map((response) => response.text()));
    expect(maximumActiveUpstreams).toBe(2);
    expect(runtime.ensureFreshSession).toHaveBeenCalledTimes(2);

    const replay = await fetch(
      `${app.listeningOrigin}${hostedCodexResponsesPath}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${grants[0]!.grant}`,
          accept: "text/event-stream",
          "content-type": "application/json",
          "idempotency-key": "relay-1",
          "x-reviewrouter-request-ordinal": "1",
        },
        body: JSON.stringify({ input: "changed replay body" }),
      },
    );
    expect(replay.status).not.toBe(200);
    expect(upstreamCalls).toBe(2);

    const sequential = await fetch(
      `${app.listeningOrigin}${hostedCodexResponsesPath}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${grants[0]!.grant}`,
          accept: "text/event-stream",
          "content-type": "application/json",
          "idempotency-key": "relay-sequential-2", // gitleaks:allow -- disposable test identifier
          "x-reviewrouter-request-ordinal": "2",
        },
        body: JSON.stringify({ input: "proven-complete next turn" }),
      },
    );
    expect(sequential.status).toBe(200);
    await sequential.text();
    expect(upstreamCalls).toBe(3);

    const refreshed = await fetch(
      `${app.listeningOrigin}${hostedCodexCommentTokenPath}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${grants[0]!.commentTokenRefreshCapability}`,
          "content-type": "application/json",
          "idempotency-key": "comment-refresh-1",
        },
        body: JSON.stringify({
          invocationLeaseId: grants[0]!.invocationLeaseId,
          bindingId: binding,
          bindingVersion: 1,
        }),
      },
    );
    if (refreshed.status !== 200) {
      throw new Error(
        `comment refresh failed: ${relayErrors
          .map(({ phase, error }) => `${phase}: ${errorStack(error)}`)
          .join(" | ")}`,
      );
    }
    const refreshedBody = await refreshed.json();
    const commentReplay = await fetch(
      `${app.listeningOrigin}${hostedCodexCommentTokenPath}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${grants[0]!.commentTokenRefreshCapability}`,
          "content-type": "application/json",
          "idempotency-key": "comment-refresh-1",
        },
        body: JSON.stringify({
          invocationLeaseId: grants[0]!.invocationLeaseId,
          bindingId: binding,
          bindingVersion: 1,
        }),
      },
    );
    expect(commentReplay.status).toBe(200);
    await expect(commentReplay.json()).resolves.toEqual(refreshedBody);
    expect(commentTokenCalls).toHaveBeenCalledTimes(1);

    const persisted = await prisma.hostedCodexInvocationGrant.findMany({
      include: { relayRequests: true, commentRefreshCapability: true },
    });
    expect(persisted).toHaveLength(2);
    expect(
      persisted.every((grant) => grant.activeAccountId === "account-primary"),
    ).toBe(true);
    expect(
      persisted.every((grant) => grant.firstSuccessfulResponseAt !== null),
    ).toBe(true);
    expect(
      persisted
        .flatMap((grant) => grant.relayRequests)
        .every((request) => request.status === "succeeded"),
    ).toBe(true);
    const responseStartedGrant = await issueGrant("response-start-fence");
    const responseStartedAuthorization = await realAuthorization.authorize({
      opaqueGrant: responseStartedGrant.plaintextToken,
      requestOrdinal: 1,
      idempotencyKey: "response-start-fence-request",
      requestBytes: 128,
    });
    await ledger.recordRequestHash({
      grantId: responseStartedGrant.grant.id,
      requestId: responseStartedAuthorization.requestId,
      requestHash: sha256("response-start-fence-body"),
    });
    await recordHostedPoolProviderResponseStarted(
      {
        grantId: responseStartedGrant.grant.id,
        requestId: relayRequestId(responseStartedAuthorization.requestId),
        startedAt: new Date(),
      },
      ledger,
    );
    const failoverAfterResponseStart =
      await failoverCurrentRelayRequestBeforeEffect(
        {
          grantId: responseStartedGrant.grant.id,
          requestId: relayRequestId(responseStartedAuthorization.requestId),
          failure: "rate_limited",
          effectFence: "before_refresh_or_upstream_effect",
          cooldownUntil: new Date(Date.now() + 60_000),
          now: new Date(),
        },
        ledger,
      );
    expect(failoverAfterResponseStart).toMatchObject({
      status: "denied",
      reason: "successful_response_fence",
      grant: expect.objectContaining({
        id: responseStartedGrant.grant.id,
        activeAccountId: hostedAccountId("account-primary"),
      }),
    });
    const liveCommentMint =
      await prisma.hostedCodexCommentTokenMint.findFirstOrThrow({
        where: { grantId: grants[0]!.invocationLeaseId, state: "issued" },
        select: { id: true, tokenHash: true, tokenExpiresAt: true },
      });
    const cleanupMintLedger = new PrismaHostedCommentTokenMintLedger(prisma);
    await cleanupMintLedger.stageRevocation({
      mintId: liveCommentMint.id,
      tokenHash: liveCommentMint.tokenHash!,
      tokenExpiresAt: liveCommentMint.tokenExpiresAt!,
      now: new Date(),
      errorCode: "postgres_e2e_fixture_cleanup",
    });
    await finalizeTrustedRevocation(
      cleanupMintLedger,
      liveCommentMint.id,
      liveCommentMint.tokenHash!,
      "postgres-e2e-fixture-revocation",
    );
  }, 120_000);

  it("atomically normalizes one expired cooldown across authorization and session readers", async () => {
    const authorization = new PrismaHostedCodexRelayAuthorization(prisma);
    const persistence = new PrismaHostedCodexSessionPersistence(
      prisma,
      vault,
      databaseIncarnation,
      databaseResourceIdentity,
      Buffer.alloc(32, 29),
    );
    const expired = await prisma.hostedCodexAccount.update({
      where: { id: "account-primary" },
      data: {
        state: "cooldown",
        cooldownUntil: new Date(Date.now() - 60_000),
        healthVersion: { increment: 1 },
      },
    });
    const issued = await issueGrant("expired-cooldown-normalization");
    expect(issued.grant).toMatchObject({
      primaryAccountId: hostedAccountId("account-primary"),
      backupAccountId: hostedAccountId("account-backup"),
    });

    const authorizationReads = [
      authorization.authorize({
        opaqueGrant: issued.plaintextToken,
        requestOrdinal: 1,
        idempotencyKey: "expired-cooldown-authorization",
        requestBytes: 64,
      }),
    ];
    const sessionReads = Array.from({ length: 12 }, () =>
      persistence.read("account-primary"),
    );
    const raced = await Promise.allSettled([
      ...authorizationReads,
      ...sessionReads,
    ]);
    const failureIndex = raced.findIndex(
      (result) => result.status === "rejected",
    );
    if (failureIndex !== -1) {
      const failure = raced[failureIndex] as PromiseRejectedResult;
      throw new Error(
        `expired cooldown ${failureIndex < authorizationReads.length ? "authorization" : "session"} race failed`,
        { cause: failure.reason },
      );
    }
    const authorized = raced.slice(0, authorizationReads.length);
    const sessions = raced.slice(authorizationReads.length);
    expect(authorized).toHaveLength(1);
    expect(
      sessions.every(
        (result) => result.status === "fulfilled" && result.value !== null,
      ),
    ).toBe(true);

    const normalized = await prisma.hostedCodexAccount.findUniqueOrThrow({
      where: { id: "account-primary" },
    });
    expect(normalized).toMatchObject({
      state: "healthy",
      cooldownUntil: null,
      healthVersion: expired.healthVersion + 1n,
    });

    const freshGrant = await issueGrant("fresh-cooldown-rejection");
    const fresh = await prisma.hostedCodexAccount.update({
      where: { id: "account-primary" },
      data: {
        state: "cooldown",
        cooldownUntil: new Date(Date.now() + 60_000),
        healthVersion: { increment: 1 },
      },
    });
    await expect(
      authorization.authorize({
        opaqueGrant: freshGrant.plaintextToken,
        requestOrdinal: 1,
        idempotencyKey: "fresh-cooldown-authorization",
        requestBytes: 64,
      }),
    ).rejects.toThrow("hosted_grant_authority_mismatch");
    await expect(persistence.read("account-primary")).rejects.toThrow(
      "hosted_codex_account_not_servable",
    );
    expect(
      await prisma.hostedCodexAccount.findUniqueOrThrow({
        where: { id: "account-primary" },
      }),
    ).toMatchObject({
      state: "cooldown",
      healthVersion: fresh.healthVersion,
    });
    await prisma.hostedCodexAccount.update({
      where: { id: "account-primary" },
      data: {
        state: "healthy",
        cooldownUntil: null,
        healthVersion: { increment: 1 },
      },
    });
  }, 120_000);

  it("terminalizes a dropped upstream response after exactly one call and denies every replay or later ordinal", async () => {
    const issued = await issueGrant("dropped-response-terminalization");
    const authorization = new PrismaHostedCodexRelayAuthorization(prisma, true);
    let upstreamCalls = 0;
    const runtime = {
      ensureFreshSession: vi.fn(async () => ({
        accessToken: "dropped-response-access-token",
        chatgptAccountId: "dropped-response-account",
        credentialGeneration:
          await activeCredentialGeneration("account-primary"),
      })),
      classifyFailure: vi.fn(() => ({ code: "unknown" })),
    } as unknown as HostedCodexSessionRuntime;
    const relay = new FetchHostedCodexStreamingRelay(
      runtime,
      ledger,
      vi.fn(async () => {
        upstreamCalls += 1;
        throw new Error("dropped-upstream-response");
      }) as typeof fetch,
      { failoverEnabled: true },
    );
    const admitted = await authorization.authorize({
      opaqueGrant: issued.plaintextToken,
      requestOrdinal: 1,
      idempotencyKey: "dropped-response-idempotency",
      requestBytes: Buffer.byteLength('{"input":"drop"}'),
    });
    await expect(
      relay.open({
        authorization: admitted,
        body: Readable.from(Buffer.from('{"input":"drop"}')),
        contentType: "application/json",
        accept: "text/event-stream",
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow("dropped-upstream-response");
    expect(upstreamCalls).toBe(1);
    const [request, grant, attempts, capability] = await Promise.all([
      prisma.hostedCodexRelayRequest.findUniqueOrThrow({
        where: { id: admitted.requestId },
      }),
      prisma.hostedCodexInvocationGrant.findUniqueOrThrow({
        where: { id: issued.grant.id },
      }),
      prisma.hostedCodexUpstreamEffectAttempt.findMany({
        where: { relayRequestId: admitted.requestId },
      }),
      prisma.hostedCodexCommentRefreshCapability.findUniqueOrThrow({
        where: { grantId: issued.grant.id },
      }),
    ]);
    expect(request.status).toBe("terminal_unknown");
    expect(grant).toMatchObject({ status: "revoked", inFlight: 0 });
    expect(grant.revokedAt).not.toBeNull();
    expect(capability.revokedAt).not.toBeNull();
    expect(attempts).toMatchObject([
      { state: "terminal_unknown", attemptOrdinal: 1 },
    ]);
    await expect(
      authorization.authorize({
        opaqueGrant: issued.plaintextToken,
        requestOrdinal: 2,
        idempotencyKey: "later-ordinal-denied",
        requestBytes: 16,
      }),
    ).rejects.toThrow("hosted_grant_invalid");
    await expect(
      authorization.authorize({
        opaqueGrant: issued.plaintextToken,
        requestOrdinal: 1,
        idempotencyKey: "dropped-response-idempotency",
        requestBytes: 16,
      }),
    ).rejects.toThrow("hosted_grant_invalid");
    expect(upstreamCalls).toBe(1);
  });

  it("recovers exact prepared-effect failover after commit acknowledgement is lost", async () => {
    const issued = await issueGrant("failover-commit-ambiguity");
    const authorization = new PrismaHostedCodexRelayAuthorization(prisma, true);
    const admitted = await authorization.authorize({
      opaqueGrant: issued.plaintextToken,
      requestOrdinal: 1,
      idempotencyKey: "failover-commit-ambiguity",
      requestBytes: 64,
    });
    const requestHash = sha256("failover-commit-ambiguity-body");
    await ledger.recordRequestHash({
      grantId: issued.grant.id,
      requestId: admitted.requestId,
      requestHash,
    });
    const effects = new PrismaHostedCodexUpstreamEffectLedger(prisma);
    const effect = await effects.prepare({
      relayRequestId: admitted.requestId,
      grantId: issued.grant.id,
      workspaceId: workspace,
      poolId: pool,
      accountId: "account-primary",
      credentialGeneration: await activeCredentialGeneration("account-primary"),
      requestHash,
    });
    const terminalEvidenceHash = sha256("failover-commit-ambiguity-evidence");
    const originalTransaction = prisma.$transaction.bind(prisma);
    const transactionSpy = vi.spyOn(prisma as never, "$transaction" as never);
    transactionSpy.mockImplementationOnce(async (...args: unknown[]) => {
      await (originalTransaction as (...args: unknown[]) => Promise<unknown>)(
        ...args,
      );
      throw new Error("failover-commit-acknowledgement-lost");
    });
    try {
      await expect(
        failoverCurrentRelayRequestBeforeEffect(
          {
            grantId: issued.grant.id,
            requestId: relayRequestId(admitted.requestId),
            failure: "credential_invalid",
            effectFence: "before_refresh_or_upstream_effect",
            cooldownUntil: null,
            now: new Date(),
            effect: {
              ...effects.authority(effect),
              sourceState: "prepared",
              terminalState: "failed_no_effect",
              terminalEvidenceHash,
              errorCode: "credential_invalid",
            },
          },
          ledger,
        ),
      ).resolves.toMatchObject({
        status: "switched",
        grant: { activeAccountId: hostedAccountId("account-backup") },
      });
    } finally {
      transactionSpy.mockRestore();
    }
    await expect(
      prisma.hostedCodexUpstreamEffectAttempt.findUniqueOrThrow({
        where: { id: effect.attemptId },
      }),
    ).resolves.toMatchObject({
      state: "failed_no_effect",
      terminalEvidenceHash,
    });
    const successor = await effects.prepare({
      relayRequestId: admitted.requestId,
      grantId: issued.grant.id,
      workspaceId: workspace,
      poolId: pool,
      accountId: "account-backup",
      credentialGeneration: await activeCredentialGeneration("account-backup"),
      requestHash,
    });
    await effects.markDispatching(successor);
    let recoveryClock = new Date(Date.now() + 29_000);
    const recoveryEffects = new PrismaHostedCodexUpstreamEffectLedger(
      prisma,
      () => recoveryClock,
    );
    await recoveryEffects.heartbeat(successor);
    recoveryClock = new Date(recoveryClock.getTime() + 2_000);
    expect(await recoveryEffects.sweepExpired()).toBe(0);
    await expect(
      prisma.hostedCodexRelayRequest.findUniqueOrThrow({
        where: { id: admitted.requestId },
      }),
    ).resolves.toMatchObject({ status: "processing" });
    await recoveryEffects.finish(successor, {
      state: "terminal_unknown",
      errorCode: "live-successor-test-complete",
      evidence: "older-no-effect-attempt-cannot-terminalize-live-successor",
    });
    await expect(
      prisma.hostedCodexInvocationGrant.findUniqueOrThrow({
        where: { id: issued.grant.id },
      }),
    ).resolves.toMatchObject({ inFlight: 0, status: "revoked" });
    await prisma.hostedCodexAccount.update({
      where: { id: "account-primary" },
      data: {
        state: "healthy",
        cooldownUntil: null,
        healthVersion: { increment: 1 },
      },
    });
  });

  it("binds each upstream attempt to the exact active credential generation", async () => {
    const issued = await issueGrant("effect-generation-binding");
    const authorization = new PrismaHostedCodexRelayAuthorization(prisma);
    const admitted = await authorization.authorize({
      opaqueGrant: issued.plaintextToken,
      requestOrdinal: 1,
      idempotencyKey: "effect-generation-binding",
      requestBytes: 64,
    });
    const requestHash = sha256("effect-generation-binding-body");
    await ledger.recordRequestHash({
      grantId: issued.grant.id,
      requestId: admitted.requestId,
      requestHash,
    });
    const effects = new PrismaHostedCodexUpstreamEffectLedger(prisma);
    const activeGeneration =
      await activeCredentialGeneration("account-primary");

    await expect(
      effects.prepare({
        relayRequestId: admitted.requestId,
        grantId: issued.grant.id,
        workspaceId: workspace,
        poolId: pool,
        accountId: "account-primary",
        credentialGeneration: activeGeneration + 1,
        requestHash,
      }),
    ).rejects.toThrow("hosted_codex_credential_generation_changed");

    const effect = await effects.prepare({
      relayRequestId: admitted.requestId,
      grantId: issued.grant.id,
      workspaceId: workspace,
      poolId: pool,
      accountId: "account-primary",
      credentialGeneration: activeGeneration,
      requestHash,
    });
    await expect(
      prisma.hostedCodexUpstreamEffectAttempt.findUniqueOrThrow({
        where: { id: effect.attemptId },
      }),
    ).resolves.toMatchObject({
      credentialGeneration: BigInt(activeGeneration),
    });
    await expect(
      prisma.hostedCodexUpstreamEffectAttempt.update({
        where: { id: effect.attemptId },
        data: { credentialGeneration: null },
      }),
    ).rejects.toThrow("hosted_codex_effect_attempt_generation_immutable");
    await effects.finish(effect, {
      state: "failed_no_effect",
      errorCode: "generation-binding-test-complete",
      evidence: "generation-binding-test-complete",
    });
    await prisma.hostedCodexRelayRequest.update({
      where: { id: admitted.requestId },
      data: {
        status: "failed",
        responseBytes: 0,
        errorCode: "generation-binding-test-complete",
        completedAt: new Date(),
      },
    });
  });

  it("takes over an expired mutation fence and rejects racing late-owner mutations", async () => {
    const fences = new PrismaHostedCodexMutationFence(prisma);
    const persistence = new PrismaHostedCodexSessionPersistence(
      prisma,
      vault,
      databaseIncarnation,
      databaseResourceIdentity,
      Buffer.alloc(32, 29),
    );
    const store = new HostedCodexSessionStore(persistence);
    const restored = await store.read({
      providerInstanceId: "account-primary",
    });
    expect(restored?.generation).toBe(1);
    const acquired = await fences.acquire({
      accountId: "account-primary",
      runId: "refresh-a",
      attempt: 1,
      ttlMs: 1_000,
      restoredGenerationHash: restored!.generationHash,
    });
    expect(acquired.status).toBe("granted");
    const blocked = await fences.acquire({
      accountId: "account-primary",
      runId: "refresh-b",
      attempt: 1,
      ttlMs: 1_000,
      restoredGenerationHash: restored!.generationHash,
    });
    expect(blocked.status).toBe("denied");
    if (acquired.status !== "granted") throw new Error("fence_not_granted");
    const originalFence =
      await prisma.hostedCodexMutationFence.findUniqueOrThrow({
        where: { accountId: "account-primary" },
      });
    expect(originalFence.ownerIdHash).toBe(sha256(acquired.leaseId));

    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(0, acquired.expiresAt.getTime() - Date.now() + 100),
      ),
    );
    const successor = await fences.acquire({
      accountId: "account-primary",
      runId: "refresh-successor-after-ttl",
      attempt: 1,
      ttlMs: 30_000,
      restoredGenerationHash: restored!.generationHash,
    });
    expect(successor.status).toBe("granted");
    if (successor.status !== "granted")
      throw new Error("successor_fence_denied");

    const successorFence =
      await prisma.hostedCodexMutationFence.findUniqueOrThrow({
        where: { accountId: "account-primary" },
      });
    expect(successorFence.fenceEpoch).toBe(originalFence.fenceEpoch + 1n);
    expect(successorFence.ownerIdHash).toBe(sha256(successor.leaseId));
    expect(successorFence.expiresAt).toEqual(successor.expiresAt);

    const captureFenceRejection = async (operation: Promise<unknown>) => {
      try {
        await operation;
      } catch (error) {
        return error;
      }
      throw new Error("expected_stale_fence_rejection");
    };
    const [
      lateWriteError,
      lateFinalizeError,
      lateReleaseError,
      successorFinalize,
    ] = await Promise.all([
      captureFenceRejection(
        store.write({
          providerInstanceId: "account-primary",
          expectedGeneration: restored!.generation,
          nextArtifact: restored!.artifact,
          idempotencyKey: "expired-owner-late-write",
          leaseId: acquired.leaseId,
        }),
      ),
      captureFenceRejection(
        fences.finalize({
          leaseId: acquired.leaseId,
          restoredGenerationHash: restored!.generationHash,
        }),
      ),
      captureFenceRejection(
        fences.release({
          leaseId: acquired.leaseId,
          reason: "expired-owner-late-release",
        }),
      ),
      fences.finalize({
        leaseId: successor.leaseId,
        restoredGenerationHash: restored!.generationHash,
      }),
    ]);
    for (const error of [lateWriteError, lateFinalizeError, lateReleaseError]) {
      expect(error).toMatchObject({
        message: "hosted_codex_mutation_fence_invalid",
      });
    }
    expect(successorFinalize).toMatchObject({ leaseId: successor.leaseId });
    const successorWrite = await store.write({
      providerInstanceId: "account-primary",
      expectedGeneration: restored!.generation,
      nextArtifact: restored!.artifact,
      idempotencyKey: "successor-authoritative-write",
      leaseId: successor.leaseId,
    });
    expect(successorWrite).toMatchObject({
      status: "accepted",
      generation: restored!.generation + 1,
    });

    const current = await store.read({ providerInstanceId: "account-primary" });
    expect(current?.generation).toBe(restored!.generation + 1);
    const authoritativeFence =
      await prisma.hostedCodexMutationFence.findUniqueOrThrow({
        where: { accountId: "account-primary" },
      });
    expect(authoritativeFence).toMatchObject({
      fenceEpoch: successorFence.fenceEpoch,
      ownerIdHash: successorFence.ownerIdHash,
      expectedGeneration: successorFence.expectedGeneration,
      expiresAt: successorFence.expiresAt,
      releasedAt: null,
      releaseReason: null,
    });
    await expect(
      store.write({
        providerInstanceId: "account-primary",
        expectedGeneration: current!.generation,
        nextArtifact: current!.artifact,
        idempotencyKey: "expired-owner-after-successor-commit",
        leaseId: acquired.leaseId,
      }),
    ).rejects.toThrow("hosted_codex_mutation_fence_invalid");

    await fences.release({
      leaseId: successor.leaseId,
      reason: "successor-complete",
    });
    const finalFence = await prisma.hostedCodexMutationFence.findUniqueOrThrow({
      where: { accountId: "account-primary" },
    });
    expect(finalFence.ownerIdHash).toBeNull();
    expect(finalFence.fenceEpoch).toBe(successorFence.fenceEpoch);
  });

  it("recovers upstream crash phases conservatively with renewable leases and exact counters", async () => {
    let clock = new Date();
    const effects = new PrismaHostedCodexUpstreamEffectLedger(
      prisma,
      () => clock,
    );
    const authorization = new PrismaHostedCodexRelayAuthorization(prisma);
    const prepareRequest = async (suffix: string) => {
      const issued = await issueGrant(`effect-${suffix}`);
      const admitted = await authorization.authorize({
        opaqueGrant: issued.plaintextToken,
        requestOrdinal: 1,
        idempotencyKey: `effect-${suffix}`,
        requestBytes: 64,
      });
      const requestHash = sha256(`effect-body-${suffix}`);
      await ledger.recordRequestHash({
        grantId: issued.grant.id,
        requestId: admitted.requestId,
        requestHash,
      });
      return {
        issued,
        admitted,
        requestHash,
        resume: () =>
          authorization.authorize({
            opaqueGrant: issued.plaintextToken,
            requestOrdinal: 1,
            idempotencyKey: `effect-${suffix}`,
            requestBytes: 64,
          }),
        prepare: async () =>
          effects.prepare({
            relayRequestId: admitted.requestId,
            grantId: issued.grant.id,
            workspaceId: workspace,
            poolId: pool,
            accountId: "account-primary",
            credentialGeneration:
              await activeCredentialGeneration("account-primary"),
            requestHash,
            leaseMs: 5_000,
          }),
      };
    };

    const duplicate = await prepareRequest("duplicate-reservation");
    const duplicateRace = await Promise.allSettled([
      duplicate.prepare(),
      duplicate.prepare(),
    ]);
    const duplicateWinners = duplicateRace.filter(
      (
        result,
      ): result is PromiseFulfilledResult<HostedCodexUpstreamEffectLease> =>
        result.status === "fulfilled",
    );
    const duplicateLosers = duplicateRace.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(duplicateWinners).toHaveLength(1);
    expect(duplicateWinners[0]!.value.attemptOrdinal).toBe(1);
    expect(duplicateLosers).toHaveLength(1);
    expect(String(duplicateLosers[0]!.reason)).toContain(
      "hosted_codex_effect_reservation_deferred",
    );
    expect(
      await prisma.hostedCodexUpstreamEffectAttempt.count({
        where: { relayRequestId: duplicate.admitted.requestId },
      }),
    ).toBe(1);
    clock = new Date();
    await effects.finish(duplicateWinners[0]!.value, {
      state: "terminal_unknown",
      errorCode: "duplicate-reservation-test-complete",
      evidence: "only-one-provider-attempt-reserved",
    });

    const ambiguousReservation = await prepareRequest(
      "reservation-commit-ambiguity",
    );
    const originalTransaction = prisma.$transaction.bind(prisma);
    const transactionSpy = vi.spyOn(prisma as never, "$transaction" as never);
    transactionSpy.mockImplementationOnce(async (...args: unknown[]) => {
      await (originalTransaction as (...args: unknown[]) => Promise<unknown>)(
        ...args,
      );
      throw new Error("reservation-commit-acknowledgement-lost");
    });
    let recoveredReservation: HostedCodexUpstreamEffectLease;
    try {
      recoveredReservation = await ambiguousReservation.prepare();
    } finally {
      transactionSpy.mockRestore();
    }
    expect(recoveredReservation!.attemptOrdinal).toBe(1);
    expect(
      await prisma.hostedCodexUpstreamEffectAttempt.count({
        where: { relayRequestId: ambiguousReservation.admitted.requestId },
      }),
    ).toBe(1);
    clock = new Date();
    await effects.finish(recoveredReservation!, {
      state: "terminal_unknown",
      errorCode: "reservation-commit-ambiguity-test-complete",
      evidence: "reservation-recovered-by-deterministic-identity",
    });

    const unreadableReservation = await prepareRequest(
      "reservation-reconciliation-read-failure",
    );
    clock = new Date();
    const unreadableTransaction = prisma.$transaction.bind(prisma);
    const unreadableTransactionSpy = vi.spyOn(
      prisma as never,
      "$transaction" as never,
    );
    const reconciliationReadSpy = vi.spyOn(
      prisma.hostedCodexUpstreamEffectAttempt,
      "findFirst",
    );
    unreadableTransactionSpy.mockImplementationOnce(
      async (...args: unknown[]) => {
        await (
          unreadableTransaction as (...args: unknown[]) => Promise<unknown>
        )(...args);
        throw new Error("reservation-commit-acknowledgement-lost");
      },
    );
    reconciliationReadSpy.mockRejectedValueOnce(
      new Error("reservation-reconciliation-read-unavailable"),
    );
    try {
      await expect(unreadableReservation.prepare()).rejects.toThrow(
        "hosted_codex_effect_reservation_outcome_unknown",
      );
    } finally {
      unreadableTransactionSpy.mockRestore();
      reconciliationReadSpy.mockRestore();
    }
    await expect(unreadableReservation.prepare()).rejects.toThrow(
      "hosted_codex_effect_reservation_deferred",
    );
    await expect(
      prisma.hostedCodexRelayRequest.findUniqueOrThrow({
        where: { id: unreadableReservation.admitted.requestId },
      }),
    ).resolves.toMatchObject({ status: "processing" });
    clock = new Date(clock.getTime() + 5_001);
    expect(await effects.sweepExpired()).toBe(1);
    await expect(
      prisma.hostedCodexRelayRequest.findUniqueOrThrow({
        where: { id: unreadableReservation.admitted.requestId },
      }),
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "upstream_dispatch_not_started",
    });
    await expect(
      prisma.hostedCodexInvocationGrant.findUniqueOrThrow({
        where: { id: unreadableReservation.issued.grant.id },
      }),
    ).resolves.toMatchObject({ inFlight: 0 });

    const beforeSend = await prepareRequest("before-send");
    const firstPrepared = await beforeSend.prepare();
    clock = new Date(clock.getTime() + 5_001);
    expect(await effects.sweepExpired()).toBe(1);
    expect(
      await prisma.hostedCodexUpstreamEffectAttempt.findUniqueOrThrow({
        where: { id: firstPrepared.attemptId },
      }),
    ).toMatchObject({ state: "failed_no_effect", attemptOrdinal: 1 });
    await beforeSend.resume();
    const retry = await beforeSend.prepare();
    expect(retry.fenceEpoch).toBe(2n);
    await effects.finish(retry, {
      state: "terminal_unknown",
      errorCode: "test_terminal_unknown",
      evidence: "no-provider-reconciliation",
    });
    clock = new Date(clock.getTime() + 30_001);
    await effects.sweepExpired();

    const afterSend = await prepareRequest("after-send");
    const dispatched = await afterSend.prepare();
    await effects.markDispatching(dispatched);
    clock = new Date(clock.getTime() + 30_001);
    expect(await effects.sweepExpired()).toBeGreaterThanOrEqual(1);
    await expect(afterSend.prepare()).rejects.toThrow(
      "hosted_codex_effect_request_invalid",
    );

    const longRunning = await prepareRequest("heartbeat");
    const live = await longRunning.prepare();
    await effects.markDispatching(live);
    for (let heartbeat = 0; heartbeat < 20; heartbeat += 1) {
      clock = new Date(clock.getTime() + 20_000);
      await effects.heartbeat(live);
    }
    await effects.markResponseStarted(live, "provider-response-opaque");
    await effects.finish(live, {
      state: "terminal_unknown",
      errorCode: "midstream_outcome_unknown",
      evidence: "response-started-without-provider-reconciliation",
    });
    clock = new Date(clock.getTime() + 30_001);
    await effects.sweepExpired();

    for (const subject of [beforeSend, afterSend, longRunning]) {
      const [request, grant] = await Promise.all([
        prisma.hostedCodexRelayRequest.findUniqueOrThrow({
          where: { id: subject.admitted.requestId },
        }),
        prisma.hostedCodexInvocationGrant.findUniqueOrThrow({
          where: { id: subject.issued.grant.id },
        }),
      ]);
      expect(request.status).toBe("terminal_unknown");
      expect(grant).toMatchObject({ requestCount: 1, inFlight: 0 });
    }
    expect(
      await prisma.hostedCodexUpstreamEffectAttempt.findMany({
        where: { relayRequestId: beforeSend.admitted.requestId },
        orderBy: { attemptOrdinal: "asc" },
      }),
    ).toMatchObject([
      { attemptOrdinal: 1, state: "failed_no_effect" },
      { attemptOrdinal: 2, state: "terminal_unknown" },
    ]);
  });

  it("does not let a full page of superseded terminal attempts starve a latest orphan", async () => {
    const issued = await issueGrant("terminal-orphan-page-starvation", {
      maxRequests: 101,
      maxConcurrentRequests: 101,
    });
    let clock = new Date();
    const requestIds = Array.from(
      { length: 101 },
      (_, index) => `starvation-request-${String(index).padStart(3, "0")}`,
    );
    await prisma.hostedCodexRelayRequest.createMany({
      data: requestIds.map((id, index) => ({
        id,
        grantId: issued.grant.id,
        ordinal: index + 1,
        idempotencyKeyHash: sha256(`starvation-request-key-${index}`),
        requestHash: sha256(`starvation-request-body-${index}`),
        status: "processing",
        requestBytes: 64,
        startedAt: clock,
        updatedAt: clock,
      })),
    });
    const credentialGeneration = BigInt(
      await activeCredentialGeneration("account-primary"),
    );
    await prisma.hostedCodexUpstreamEffectAttempt.createMany({
      data: requestIds.flatMap((relayRequestId, index) => {
        const requestHash = sha256(`starvation-request-body-${index}`);
        const predecessor = {
          id:
            index === 100
              ? "zz-starvation-latest-orphan"
              : `starvation-predecessor-${String(index).padStart(3, "0")}`,
          relayRequestId,
          grantId: issued.grant.id,
          workspaceId: workspace,
          poolId: pool,
          accountId: "account-primary",
          credentialGeneration,
          attemptOrdinal: 1,
          requestHash,
          idempotencyKeyHash: sha256(
            `${relayRequestId}\u0000account-primary\u00001`,
          ),
          state: "failed_no_effect" as const,
          ownerIdHash: sha256(`starvation-owner-${index}-1`),
          fenceEpoch: 1n,
          heartbeatAt: clock,
          leaseExpiresAt: new Date(clock.getTime() + 5_000),
          completedAt: clock,
          terminalEvidenceHash: sha256(`starvation-evidence-${index}`),
          errorCode: "starvation-predecessor",
          createdAt: clock,
          updatedAt: clock,
        };
        if (index === 100) return [predecessor];
        return [
          predecessor,
          {
            ...predecessor,
            id: `starvation-successor-${String(index).padStart(3, "0")}`,
            attemptOrdinal: 2,
            idempotencyKeyHash: sha256(
              `${relayRequestId}\u0000account-primary\u00002`,
            ),
            state: "prepared" as const,
            ownerIdHash: sha256(`starvation-owner-${index}-2`),
            fenceEpoch: 2n,
            leaseExpiresAt: new Date(clock.getTime() + 120_000),
            completedAt: null,
            terminalEvidenceHash: null,
            errorCode: null,
          },
        ];
      }),
    });
    const effects = new PrismaHostedCodexUpstreamEffectLedger(
      prisma,
      () => clock,
    );
    clock = new Date(clock.getTime() + 30_001);
    expect(await effects.sweepExpired(100)).toBe(1);
    await expect(
      prisma.hostedCodexRelayRequest.findUniqueOrThrow({
        where: { id: requestIds[100]! },
      }),
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "upstream_dispatch_not_started",
    });
    await expect(
      prisma.hostedCodexInvocationGrant.findUniqueOrThrow({
        where: { id: issued.grant.id },
      }),
    ).resolves.toMatchObject({ inFlight: 100 });

    clock = new Date(clock.getTime() + 90_000);
    expect(await effects.sweepExpired(100)).toBe(100);
    await expect(
      prisma.hostedCodexInvocationGrant.findUniqueOrThrow({
        where: { id: issued.grant.id },
      }),
    ).resolves.toMatchObject({ inFlight: 0 });
  });

  it("terminalizes atomically when response-start persistence fails after the POST", async () => {
    const issued = await issueGrant("response-start-persistence-race");
    const authorization = new PrismaHostedCodexRelayAuthorization(prisma);
    const admitted = await authorization.authorize({
      opaqueGrant: issued.plaintextToken,
      requestOrdinal: 1,
      idempotencyKey: "response-start-persistence-race",
      requestBytes: Buffer.byteLength('{"input":"race"}'),
    });
    const markStarted = vi
      .spyOn(ledger, "markStarted")
      .mockRejectedValueOnce(new Error("mark-response-started-write-failed"));
    try {
      const relay = new FetchHostedCodexStreamingRelay(
        {
          ensureFreshSession: vi.fn(async () => ({
            accessToken: "response-start-access",
            chatgptAccountId: "response-start-account",
            credentialGeneration:
              await activeCredentialGeneration("account-primary"),
          })),
          classifyFailure: vi.fn(() => ({ code: "unknown" })),
        } as unknown as HostedCodexSessionRuntime,
        ledger,
        vi.fn(
          async () =>
            new Response("ok", {
              status: 200,
              headers: { "x-request-id": "response-start-provider-id" },
            }),
        ) as typeof fetch,
      );
      await expect(
        relay.open({
          authorization: admitted,
          body: Readable.from(Buffer.from('{"input":"race"}')),
          contentType: "application/json",
          accept: "text/event-stream",
          abortSignal: new AbortController().signal,
        }),
      ).rejects.toThrow("mark-response-started-write-failed");
    } finally {
      markStarted.mockRestore();
    }
    const [request, grant, capability, effect] = await Promise.all([
      prisma.hostedCodexRelayRequest.findUniqueOrThrow({
        where: { id: admitted.requestId },
      }),
      prisma.hostedCodexInvocationGrant.findUniqueOrThrow({
        where: { id: issued.grant.id },
      }),
      prisma.hostedCodexCommentRefreshCapability.findUniqueOrThrow({
        where: { grantId: issued.grant.id },
      }),
      prisma.hostedCodexUpstreamEffectAttempt.findFirstOrThrow({
        where: { relayRequestId: admitted.requestId },
      }),
    ]);
    expect(request.status).toBe("terminal_unknown");
    expect(effect.state).toBe("terminal_unknown");
    expect(grant.status).toBe("revoked");
    expect(capability.revokedAt).not.toBeNull();
  });

  it("enforces output budgets before forwarding and never fails over on overflow", async () => {
    const issued = await issueGrant("output-budget", {
      maxResponseBytes: 4,
      maxOutputTokens: 128,
    });
    const authorization = new PrismaHostedCodexRelayAuthorization(prisma, true);
    const admitted = await authorization.authorize({
      opaqueGrant: issued.plaintextToken,
      requestOrdinal: 1,
      idempotencyKey: "output-budget",
      requestBytes: Buffer.byteLength(
        '{"input":"bounded","max_output_tokens":64}',
      ),
    });
    let pull = 0;
    let cancelled = false;
    let providerRequest: Record<string, unknown> | undefined;
    let providerRequestBytes: Uint8Array | undefined;
    const upstreamBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(
          pull++ === 0 ? Buffer.from("1234") : Buffer.from("overflow"),
        );
      },
      cancel() {
        cancelled = true;
      },
    });
    const relay = new FetchHostedCodexStreamingRelay(
      {
        ensureFreshSession: vi.fn(async () => ({
          accessToken: "output-budget-access",
          chatgptAccountId: "output-budget-account",
          credentialGeneration:
            await activeCredentialGeneration("account-primary"),
        })),
        classifyFailure: vi.fn(() => ({ code: "unknown" })),
      } as unknown as HostedCodexSessionRuntime,
      ledger,
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        providerRequestBytes = init?.body as Uint8Array;
        providerRequest = JSON.parse(
          Buffer.from(providerRequestBytes).toString("utf8"),
        ) as Record<string, unknown>;
        return new Response(upstreamBody, { status: 200 });
      }) as unknown as typeof fetch,
      { failoverEnabled: true },
    );
    const requestBody = Buffer.from(
      '{"input":"bounded","max_output_tokens":64}',
    );
    const response = await relay.open({
      authorization: admitted,
      body: Readable.from(requestBody),
      contentType: "application/json",
      accept: "text/event-stream",
      abortSignal: new AbortController().signal,
    });
    expect(providerRequest).toMatchObject({
      model: admitted.model,
      store: false,
      max_output_tokens: 64,
    });
    expect(providerRequestBytes!.every((byte) => byte === 0)).toBe(true);
    let observed = "";
    await expect(async () => {
      for await (const chunk of response.body) observed += chunk.toString();
    }).rejects.toThrow("hosted_codex_provider_response_bytes_exceeded");
    expect(observed).toBe("1234");
    await vi.waitFor(() => expect(cancelled).toBe(true));
    const [request, effect, grant] = await Promise.all([
      prisma.hostedCodexRelayRequest.findUniqueOrThrow({
        where: { id: admitted.requestId },
      }),
      prisma.hostedCodexUpstreamEffectAttempt.findFirstOrThrow({
        where: { relayRequestId: admitted.requestId },
      }),
      prisma.hostedCodexInvocationGrant.findUniqueOrThrow({
        where: { id: issued.grant.id },
      }),
    ]);
    expect(request).toMatchObject({
      status: "terminal_unknown",
      errorCode: "provider_response_bytes_exceeded",
    });
    expect(effect).toMatchObject({
      state: "terminal_unknown",
      errorCode: "provider_response_bytes_exceeded",
    });
    expect(grant).toMatchObject({
      activeAccountId: "account-primary",
      failoverCount: 0,
      status: "revoked",
      inFlight: 0,
    });
  });

  it("renews the effect lease throughout a logically longer-than-30-second response stream", async () => {
    let clock = new Date();
    const effects = new PrismaHostedCodexUpstreamEffectLedger(
      prisma,
      () => clock,
    );
    let orphanedCandidates: number;
    do {
      orphanedCandidates = await effects.sweepExpired();
    } while (orphanedCandidates !== 0);
    const issued = await issueGrant("long-response-heartbeat");
    const authorization = new PrismaHostedCodexRelayAuthorization(prisma);
    const admitted = await authorization.authorize({
      opaqueGrant: issued.plaintextToken,
      requestOrdinal: 1,
      idempotencyKey: "long-response-heartbeat",
      requestBytes: Buffer.byteLength('{"input":"long"}'),
    });
    let chunks = 0;
    const chunkGates = Array.from({ length: 3 }, () =>
      Promise.withResolvers<void>(),
    );
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (chunks === 3) {
          controller.close();
          return;
        }
        await chunkGates[chunks]!.promise;
        controller.enqueue(Buffer.from(`chunk-${chunks}`));
        chunks += 1;
      },
    });
    const relay = new FetchHostedCodexStreamingRelay(
      {
        ensureFreshSession: vi.fn(async () => ({
          accessToken: "long-response-access",
          chatgptAccountId: "long-response-account",
          credentialGeneration:
            await activeCredentialGeneration("account-primary"),
        })),
        classifyFailure: vi.fn(() => ({ code: "unknown" })),
      } as unknown as HostedCodexSessionRuntime,
      ledger,
      vi.fn(async () => new Response(body, { status: 200 })) as typeof fetch,
      {
        failoverEnabled: false,
        now: () => clock,
        heartbeatIntervalMs: 5,
        effects,
      },
    );
    const response = await relay.open({
      authorization: admitted,
      body: Readable.from(Buffer.from('{"input":"long"}')),
      contentType: "application/json",
      accept: "text/event-stream",
      abortSignal: new AbortController().signal,
    });
    const read = readAll(response.body);
    for (const gate of chunkGates) {
      const before =
        await prisma.hostedCodexUpstreamEffectAttempt.findFirstOrThrow({
          where: { relayRequestId: admitted.requestId },
          select: { id: true, leaseExpiresAt: true, state: true },
        });
      expect(before.state).toBe("response_started");
      clock = new Date(before.leaseExpiresAt.getTime() - 1);
      await vi.waitFor(
        async () => {
          const renewed =
            await prisma.hostedCodexUpstreamEffectAttempt.findUniqueOrThrow({
              where: { id: before.id },
              select: { leaseExpiresAt: true, state: true },
            });
          expect(renewed.state).toBe("response_started");
          expect(renewed.leaseExpiresAt.getTime()).toBeGreaterThan(
            before.leaseExpiresAt.getTime(),
          );
        },
        { interval: 5, timeout: 2_000 },
      );
      // Cross the lease boundary captured before renewal. The exact live
      // attempt must remain unsweepable after its heartbeat extends the lease.
      clock = new Date(before.leaseExpiresAt.getTime() + 1);
      expect(await effects.sweepExpired()).toBe(0);
      gate.resolve();
    }
    await read;
    expect(chunks).toBe(3);
    const [request, attempts] = await Promise.all([
      prisma.hostedCodexRelayRequest.findUniqueOrThrow({
        where: { id: admitted.requestId },
      }),
      prisma.hostedCodexUpstreamEffectAttempt.findMany({
        where: { relayRequestId: admitted.requestId },
      }),
    ]);
    expect(request).toMatchObject({ status: "succeeded" });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ state: "succeeded" });
  });

  it("rechecks quarantine and revocation at both prepare and dispatch boundaries", async () => {
    const authorization = new PrismaHostedCodexRelayAuthorization(prisma);
    const effects = new PrismaHostedCodexUpstreamEffectLedger(prisma);
    const first = await issueGrant("authority-recheck-quarantine");
    const second = await issueGrant("authority-recheck-revocation");
    const admit = async (
      issued: Awaited<ReturnType<typeof issueGrant>>,
      suffix: string,
    ) => {
      const admitted = await authorization.authorize({
        opaqueGrant: issued.plaintextToken,
        requestOrdinal: 1,
        idempotencyKey: suffix,
        requestBytes: 64,
      });
      const requestHash = sha256(`authority-recheck-${suffix}`);
      await ledger.recordRequestHash({
        grantId: issued.grant.id,
        requestId: admitted.requestId,
        requestHash,
      });
      return { admitted, requestHash };
    };
    const firstRequest = await admit(first, "quarantine");
    const secondRequest = await admit(second, "revocation");
    const preparedBeforeQuarantine = await effects.prepare({
      relayRequestId: firstRequest.admitted.requestId,
      grantId: first.grant.id,
      workspaceId: workspace,
      poolId: pool,
      accountId: "account-primary",
      credentialGeneration: await activeCredentialGeneration("account-primary"),
      requestHash: firstRequest.requestHash,
    });
    await prisma.hostedCodexAccount.update({
      where: { id: "account-primary" },
      data: {
        state: "restore_quarantined",
        healthVersion: { increment: 1 },
      },
    });
    await expect(
      effects.markDispatching(preparedBeforeQuarantine),
    ).rejects.toThrow("hosted_codex_effect_authority_revoked");
    await expect(
      effects.prepare({
        relayRequestId: secondRequest.admitted.requestId,
        grantId: second.grant.id,
        workspaceId: workspace,
        poolId: pool,
        accountId: "account-primary",
        credentialGeneration:
          await activeCredentialGeneration("account-primary"),
        requestHash: secondRequest.requestHash,
      }),
    ).rejects.toThrow("hosted_codex_effect_authority_revoked");
    await prisma.hostedCodexAccount.update({
      where: { id: "account-primary" },
      data: { state: "healthy", healthVersion: { increment: 1 } },
    });
    const preparedBeforeRevocation = await effects.prepare({
      relayRequestId: secondRequest.admitted.requestId,
      grantId: second.grant.id,
      workspaceId: workspace,
      poolId: pool,
      accountId: "account-primary",
      credentialGeneration: await activeCredentialGeneration("account-primary"),
      requestHash: secondRequest.requestHash,
    });
    await prisma.hostedCodexInvocationGrant.update({
      where: { id: second.grant.id },
      data: { status: "revoked", revokedAt: new Date() },
    });
    await expect(
      effects.markDispatching(preparedBeforeRevocation),
    ).rejects.toThrow("hosted_codex_effect_authority_revoked");
  });

  it("closes live dispatch and keeps stale grants revoked across gate reopen", async () => {
    const authorization = new PrismaHostedCodexRelayAuthorization(prisma);
    const effects = new PrismaHostedCodexUpstreamEffectLedger(prisma);
    const streaming = await issueGrant("runtime-gate-stream");
    const stale = await issueGrant("runtime-gate-stale");
    const admitted = await authorization.authorize({
      opaqueGrant: streaming.plaintextToken,
      requestOrdinal: 1,
      idempotencyKey: "runtime-gate-stream",
      requestBytes: 64,
    });
    const requestHash = sha256("runtime-gate-stream");
    await ledger.recordRequestHash({
      grantId: streaming.grant.id,
      requestId: admitted.requestId,
      requestHash,
    });
    const effect = await effects.prepare({
      relayRequestId: admitted.requestId,
      grantId: streaming.grant.id,
      workspaceId: workspace,
      poolId: pool,
      accountId: "account-primary",
      credentialGeneration: await activeCredentialGeneration("account-primary"),
      requestHash,
    });
    await effects.markDispatching(effect);

    const closed = await transitionRuntimeGate("closed", "postgres_e2e_kill");
    await expect(effects.heartbeat(effect)).rejects.toThrow(
      "hosted_codex_effect_authority_revoked",
    );
    await expect(
      effects.markResponseStarted(effect, "provider-after-kill"),
    ).rejects.toThrow("hosted_codex_effect_authority_revoked");
    await expect(
      authorization.authorize({
        opaqueGrant: stale.plaintextToken,
        requestOrdinal: 1,
        idempotencyKey: "runtime-gate-closed",
        requestBytes: 64,
      }),
    ).rejects.toThrow("hosted_grant_authority_mismatch");
    await effects.finish(effect, {
      state: "terminal_unknown",
      errorCode: "runtime_gate_closed",
      evidence: "postgres-e2e-runtime-gate-close",
    });

    const reopened = await transitionRuntimeGate(
      "active",
      "postgres_e2e_reopen",
    );
    expect(reopened.authzEpoch).toBe(closed.authzEpoch + 1n);
    await expect(
      authorization.authorize({
        opaqueGrant: stale.plaintextToken,
        requestOrdinal: 1,
        idempotencyKey: "runtime-gate-aba",
        requestBytes: 64,
      }),
    ).rejects.toThrow("hosted_grant_authority_mismatch");
    const fresh = await issueGrant("runtime-gate-fresh");
    expect(fresh.grant.runtimeAuthzEpoch).toBe(reopened.authzEpoch);
    await prisma.hostedCodexInvocationGrant.updateMany({
      where: {
        id: { in: [stale.grant.id, fresh.grant.id] },
        status: { in: ["issued", "exhausted"] },
      },
      data: { status: "revoked", revokedAt: new Date() },
    });
  });

  it("uses a monotonic database timestamp for concurrent and emergency gate transitions", async () => {
    const initial = await prisma.hostedCodexRuntimeGate.findUniqueOrThrow({
      where: { id: "global" },
    });
    const equal = initial.changedAt;
    const regressed = new Date(initial.changedAt.getTime() - 60_000);
    const close = (reasonCode: string, changedAt: Date) =>
      prisma.hostedCodexRuntimeGate.updateMany({
        where: { id: "global", revision: initial.revision },
        data: {
          status: "closed",
          authzEpoch: { increment: 1 },
          revision: { increment: 1 },
          reasonCode,
          changedAt,
          changedByHash: sha256(reasonCode),
        },
      });

    const competing = await Promise.all([
      close("postgres_e2e_equal_close", equal),
      close("postgres_e2e_regressed_close", regressed),
    ]);
    expect(competing.map(({ count }) => count).sort()).toEqual([0, 1]);
    const closed = await prisma.hostedCodexRuntimeGate.findUniqueOrThrow({
      where: { id: "global" },
    });
    expect(closed.changedAt.getTime()).toBeGreaterThan(
      initial.changedAt.getTime(),
    );

    const reopened = await transitionRuntimeGate(
      "active",
      "postgres_e2e_regressed_reopen",
      regressed,
    );
    expect(reopened.changedAt.getTime()).toBeGreaterThan(
      closed.changedAt.getTime(),
    );
    const emergency = await transitionRuntimeGate(
      "closed",
      "postgres_e2e_emergency_close",
      reopened.changedAt,
    );
    expect(emergency.changedAt.getTime()).toBeGreaterThan(
      reopened.changedAt.getTime(),
    );
    await transitionRuntimeGate("active", "postgres_e2e_test_restore");
  });

  it("proves prepare consumption and attempt creation contend before emergency close", async () => {
    const issued = await issueGrant("mint-race-prepare-first");
    let prepared!: () => void;
    let release!: () => void;
    const preparedInsideTransaction = new Promise<void>((resolve) => {
      prepared = resolve;
    });
    const releasePrepare = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate = new PrismaHostedCommentTokenMintLedger(prisma, {
      afterPrepare: async () => {
        prepared();
        await releasePrepare;
      },
    });
    const ownerIdHash = sha256("mint-race-owner-1");
    const attemptId = "comment-mint-race-prepare-first";
    const requestIdHash = sha256("mint-race-request-1");
    const prepare = gate.prepare({
      mintId: attemptId,
      purpose: "refresh",
      logicalKeyHash: sha256(attemptId),
      requestFingerprintHash: sha256(`fingerprint:${attemptId}`),
      ownerIdHash,
      grantId: issued.grant.id,
      bindingId: binding,
      bindingVersion: 1,
      presentedTokenHash: sha256(issued.commentRefreshPlaintextToken),
      requestIdHash,
      now: new Date(),
      leaseExpiresAt: new Date(Date.now() + 30_000),
    });
    await preparedInsideTransaction;
    let closeSettled = false;
    const close = transitionRuntimeGate(
      "closed",
      "postgres_e2e_mint_prepare_first_close",
    ).then((value) => {
      closeSettled = true;
      return value;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closeSettled).toBe(false);
    release();
    await expect(prepare).resolves.toMatchObject({
      mintId: attemptId,
      state: "prepared",
    });
    await close;
    expect(
      await prisma.hostedCodexCommentRefreshUse.count({
        where: { grantId: issued.grant.id },
      }),
    ).toBe(1);
    expect(
      await prisma.hostedCodexCommentTokenMint.count({
        where: { id: attemptId },
      }),
    ).toBe(1);
    await expect(
      gate.authorizeDispatch({
        mintId: attemptId,
        ownerIdHash,
        now: new Date(),
        dispatchAuthorizedUntil: new Date(Date.now() + 15_000),
        unsafeUntil: new Date(Date.now() + 61 * 60_000),
      }),
    ).rejects.toThrow("hosted_comment_mint_dispatch_conflict");
    await prisma.hostedCodexCommentTokenMint.update({
      where: { id: attemptId },
      data: {
        state: "failed_no_token",
        completedAt: new Date(),
        terminalEvidenceHash: sha256("closed-before-dispatch"),
        revision: { increment: 1 },
      },
    });
    await transitionRuntimeGate(
      "active",
      "postgres_e2e_mint_prepare_first_restore",
    );
  });

  it("proves a committed emergency close defeats a contending mint prepare", async () => {
    const issued = await issueGrant("mint-race-close-first");
    const current = await prisma.hostedCodexRuntimeGate.findUniqueOrThrow({
      where: { id: "global" },
    });
    let closedInside!: () => void;
    let release!: () => void;
    const closedInsideTransaction = new Promise<void>((resolve) => {
      closedInside = resolve;
    });
    const releaseClose = new Promise<void>((resolve) => {
      release = resolve;
    });
    const close = prisma.$transaction(async (transaction) => {
      await transaction.hostedCodexRuntimeGate.update({
        where: { id: "global" },
        data: {
          status: "closed",
          authzEpoch: { increment: 1 },
          revision: { increment: 1 },
          reasonCode: "postgres_e2e_mint_close_first",
          changedAt: new Date(),
          changedByHash: sha256("postgres-e2e-close-first"),
        },
      });
      closedInside();
      await releaseClose;
    });
    await closedInsideTransaction;
    const gate = new PrismaHostedCommentTokenMintLedger(prisma);
    let prepareSettled = false;
    const prepare = gate
      .prepare({
        mintId: "comment-mint-race-close-first",
        purpose: "refresh",
        logicalKeyHash: sha256("comment-mint-race-close-first"),
        requestFingerprintHash: sha256(
          "fingerprint:comment-mint-race-close-first",
        ),
        ownerIdHash: sha256("mint-race-owner-2"),
        grantId: issued.grant.id,
        bindingId: binding,
        bindingVersion: 1,
        presentedTokenHash: sha256(issued.commentRefreshPlaintextToken),
        requestIdHash: sha256("mint-race-request-2"),
        now: new Date(),
        leaseExpiresAt: new Date(Date.now() + 30_000),
      })
      .finally(() => {
        prepareSettled = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(prepareSettled).toBe(false);
    release();
    await close;
    await expect(prepare).rejects.toThrow(
      "hosted_comment_mint_authority_mismatch",
    );
    expect(
      await prisma.hostedCodexCommentRefreshUse.count({
        where: { grantId: issued.grant.id },
      }),
    ).toBe(0);
    expect(
      await prisma.hostedCodexCommentTokenMint.count({
        where: { grantId: issued.grant.id },
      }),
    ).toBe(0);
    const closed = await prisma.hostedCodexRuntimeGate.findUniqueOrThrow({
      where: { id: "global" },
    });
    expect(closed.authzEpoch).toBe(current.authzEpoch + 1n);
    await transitionRuntimeGate(
      "active",
      "postgres_e2e_mint_close_first_restore",
    );
  });

  it("proves dispatch releases the gate before network and close fences finalize", async () => {
    const issued = await issueGrant("mint-race-dispatch-first");
    const ledger = new PrismaHostedCommentTokenMintLedger(prisma);
    const mintId = "comment-mint-race-dispatch-first";
    const ownerIdHash = sha256("mint-race-dispatch-owner");
    const prepared = await ledger.prepare({
      mintId,
      purpose: "refresh",
      logicalKeyHash: sha256(mintId),
      requestFingerprintHash: sha256(`fingerprint:${mintId}`),
      ownerIdHash,
      grantId: issued.grant.id,
      bindingId: binding,
      bindingVersion: 1,
      presentedTokenHash: sha256(issued.commentRefreshPlaintextToken),
      requestIdHash: sha256("mint-race-dispatch-request"),
      now: new Date(),
      leaseExpiresAt: new Date(Date.now() + 30_000),
    });
    if (prepared.state !== "prepared")
      throw new Error("postgres_e2e_prepare_failed");
    await ledger.authorizeDispatch({
      mintId,
      ownerIdHash,
      now: new Date(),
      dispatchAuthorizedUntil: new Date(Date.now() + 15_000),
      unsafeUntil: new Date(Date.now() + 61 * 60_000),
    });
    // Represents a hanging provider call: close must not wait on any ledger transaction.
    const closed = await transitionRuntimeGate(
      "closed",
      "postgres_e2e_dispatch_first_close",
    );
    const closure = await createElapsedTestRuntimeClosure({
      id: `runtime-closure-${closed.revision}`,
      gateRevision: closed.revision,
      closedAuthzEpoch: closed.authzEpoch,
      actorHash: sha256("postgres-e2e-dispatch-first"),
      reasonHash: sha256("postgres_e2e_dispatch_first_close"),
      legacyBarrier: true,
      legacyUnsafeUntil: new Date(0),
    });
    await expect(
      prisma.hostedCodexRuntimeClosure.update({
        where: { id: closure.id },
        data: {
          state: "complete",
          completedAt: new Date(),
          revision: { increment: 1 },
        },
      }),
    ).rejects.toThrow("hosted_codex_runtime_closure_unsafe");
    const tokenHash = sha256("dispatch-first-token");
    await expect(
      ledger.finalizeKnownToken({
        mintId,
        ownerIdHash,
        fenceEpoch: prepared.fenceEpoch,
        tokenHash,
        tokenExpiresAt: new Date(Date.now() + 60_000),
        secretEnvelope: testSecretEnvelope("dispatch-first-token"),
        now: new Date(),
      }),
    ).resolves.toBe("revoke_pending");
    await expect(
      prisma.hostedCodexRuntimeClosure.update({
        where: { id: closure.id },
        data: {
          state: "complete",
          completedAt: new Date(),
          revision: { increment: 1 },
        },
      }),
    ).rejects.toThrow("hosted_codex_runtime_closure_unsafe");
    await finalizeTrustedRevocation(ledger, mintId, tokenHash, "trusted-204");
    await prisma.hostedCodexRuntimeClosure.update({
      where: { id: closure.id },
      data: {
        state: "complete",
        completedAt: new Date(),
        revision: { increment: 1 },
      },
    });
    await transitionRuntimeGate(
      "active",
      "postgres_e2e_dispatch_first_restore",
    );
  });

  it("makes a finalize-first token block closure until trusted revocation", async () => {
    const issued = await issueGrant("mint-race-finalize-first");
    const mintLedger = new PrismaHostedCommentTokenMintLedger(prisma);
    const mintId = "comment-mint-race-finalize-first";
    const ownerIdHash = sha256("mint-race-finalize-first-owner");
    const prepared = await mintLedger.prepare({
      mintId,
      purpose: "initial",
      logicalKeyHash: sha256(mintId),
      requestFingerprintHash: sha256(`fingerprint:${mintId}`),
      ownerIdHash,
      grantId: issued.grant.id,
      bindingId: binding,
      bindingVersion: 1,
      now: new Date(),
      leaseExpiresAt: new Date(Date.now() + 30_000),
    });
    if (prepared.state !== "prepared")
      throw new Error("postgres_e2e_prepare_failed");
    await mintLedger.authorizeDispatch({
      mintId,
      ownerIdHash,
      now: new Date(),
      dispatchAuthorizedUntil: new Date(Date.now() + 15_000),
      unsafeUntil: new Date(Date.now() + 61 * 60_000),
    });
    const tokenHash = sha256("finalize-first-token");
    await expect(
      mintLedger.finalizeKnownToken({
        mintId,
        ownerIdHash,
        fenceEpoch: prepared.fenceEpoch,
        tokenHash,
        tokenExpiresAt: new Date(Date.now() + 60_000),
        secretEnvelope: testSecretEnvelope("finalize-first-token"),
        now: new Date(),
      }),
    ).resolves.toBe("issued");
    const closed = await transitionRuntimeGate(
      "closed",
      "postgres_e2e_finalize_first_close",
    );
    const closure = await createElapsedTestRuntimeClosure({
      id: `runtime-closure-${closed.revision}`,
      gateRevision: closed.revision,
      closedAuthzEpoch: closed.authzEpoch,
      actorHash: sha256("postgres-e2e-finalize-first"),
      reasonHash: sha256("postgres_e2e_finalize_first_close"),
      legacyBarrier: true,
      legacyUnsafeUntil: new Date(0),
    });
    await expect(
      prisma.hostedCodexRuntimeClosure.update({
        where: { id: closure.id },
        data: {
          state: "complete",
          completedAt: new Date(),
          revision: { increment: 1 },
        },
      }),
    ).rejects.toThrow("hosted_codex_runtime_closure_unsafe");
    const claims = await mintLedger.claimRevocations({
      ownerIdHash: sha256("finalize-first-revoker"),
      now: new Date(Date.now() + 1),
      leaseExpiresAt: new Date(Date.now() + 30_001),
      limit: 1,
    });
    expect(claims).toHaveLength(1);
    await mintLedger.finalizeRevoked({
      mintId,
      tokenHash,
      ownerIdHash: claims[0]!.ownerIdHash,
      fenceEpoch: claims[0]!.fenceEpoch,
      now: new Date(),
      evidenceHash: sha256("trusted-finalize-first-revocation"),
      receipt: trustedRevocationReceipt,
    });
    await expect(
      prisma.hostedCodexRuntimeClosure.update({
        where: { id: closure.id },
        data: {
          state: "complete",
          completedAt: new Date(),
          revision: { increment: 1 },
        },
      }),
    ).resolves.toMatchObject({ state: "complete" });
    await transitionRuntimeGate(
      "active",
      "postgres_e2e_finalize_first_restore",
    );
  });

  it("keeps remote-success-local-unknown retry and closure blocked through the provider bound", async () => {
    const issued = await issueGrant("mint-outcome-unknown");
    const mintLedger = new PrismaHostedCommentTokenMintLedger(prisma);
    const mintId = "comment-mint-outcome-unknown";
    const ownerIdHash = sha256("mint-outcome-unknown-owner");
    const requestIdHash = sha256("mint-outcome-unknown-request");
    const prepareInput = {
      mintId,
      purpose: "refresh" as const,
      logicalKeyHash: sha256(mintId),
      requestFingerprintHash: sha256(`fingerprint:${mintId}`),
      ownerIdHash,
      grantId: issued.grant.id,
      bindingId: binding,
      bindingVersion: 1,
      presentedTokenHash: sha256(issued.commentRefreshPlaintextToken),
      requestIdHash,
      now: new Date(),
      leaseExpiresAt: new Date(Date.now() + 30_000),
    };
    const prepared = await mintLedger.prepare(prepareInput);
    if (prepared.state !== "prepared")
      throw new Error("postgres_e2e_prepare_failed");
    await mintLedger.authorizeDispatch({
      mintId,
      ownerIdHash,
      now: new Date(),
      dispatchAuthorizedUntil: new Date(Date.now() + 15_000),
      unsafeUntil: new Date(Date.now() + 61 * 60_000),
    });
    await mintLedger.finalizeOutcomeUnknown({
      mintId,
      ownerIdHash,
      now: new Date(),
      errorCode: "provider_response_lost",
    });
    await expect(mintLedger.prepare(prepareInput)).resolves.toEqual({
      mintId,
      state: "outcome_unknown",
    });
    await expect(
      prisma.hostedCodexCommentTokenMint.findUniqueOrThrow({
        where: { id: mintId },
        select: { providerAttempt: true },
      }),
    ).resolves.toEqual({ providerAttempt: 1 });
    const closed = await transitionRuntimeGate(
      "closed",
      "postgres_e2e_outcome_unknown_close",
    );
    const closure = await createElapsedTestRuntimeClosure({
      id: `runtime-closure-${closed.revision}`,
      gateRevision: closed.revision,
      closedAuthzEpoch: closed.authzEpoch,
      actorHash: sha256("postgres-e2e-outcome-unknown"),
      reasonHash: sha256("postgres_e2e_outcome_unknown_close"),
      legacyBarrier: true,
      legacyUnsafeUntil: new Date(0),
    });
    await expect(
      prisma.hostedCodexRuntimeClosure.update({
        where: { id: closure.id },
        data: {
          state: "complete",
          completedAt: new Date(),
          revision: { increment: 1 },
        },
      }),
    ).rejects.toThrow("hosted_codex_runtime_closure_unsafe");
    await expect(
      prisma.hostedCodexCommentTokenMint.update({
        where: { id: mintId },
        data: {
          state: "expired",
          completedAt: new Date(),
          terminalEvidenceHash: sha256("premature-expiry"),
          revision: { increment: 1 },
        },
      }),
    ).rejects.toThrow("hosted_codex_comment_token_mint_transition_invalid");
    // Test-only cleanup cannot wait for the provider upper bound in wall time.
    await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(
        `SET LOCAL session_replication_role = 'replica'`,
      );
      await transaction.hostedCodexCommentTokenMint.update({
        where: { id: mintId },
        data: {
          state: "expired",
          completedAt: new Date(),
          terminalEvidenceHash: sha256("provider-bound-simulated"),
          revision: { increment: 1 },
        },
      });
    });
    await prisma.hostedCodexRuntimeClosure.update({
      where: { id: closure.id },
      data: {
        state: "complete",
        completedAt: new Date(),
        revision: { increment: 1 },
      },
    });
    await transitionRuntimeGate(
      "active",
      "postgres_e2e_outcome_unknown_restore",
    );
  });

  it("resumes one durable closure after a control-process crash without advancing the gate twice", async () => {
    const closed = await transitionRuntimeGate(
      "closed",
      "postgres_e2e_closure_crash",
    );
    await createElapsedTestRuntimeClosure({
      id: `runtime-closure-${closed.revision}`,
      gateRevision: closed.revision,
      closedAuthzEpoch: closed.authzEpoch,
      actorHash: sha256("postgres-e2e-closure-crash"),
      reasonHash: sha256("postgres_e2e_closure_crash"),
      legacyBarrier: true,
      legacyUnsafeUntil: new Date(0),
    });
    const control = createRenderHostedPoolControlPort({
      apiKey: "unused-postgres-e2e-key",
      serviceIds: ["unused-api", "unused-web"],
      databaseUrl,
      fetchImpl: vi.fn(),
    });
    try {
      const observed = await control.readRuntimeGate();
      await control.ensureRuntimeClosure?.(
        observed,
        "postgres_e2e_closure_resume",
        sha256("postgres-e2e-closure-resumer"),
      );
      // Represents a new control process repeating the same resume after crash.
      await control.ensureRuntimeClosure?.(
        observed,
        "postgres_e2e_closure_resume",
        sha256("postgres-e2e-closure-resumer"),
      );
      await expect(control.readRuntimeGate()).resolves.toEqual(observed);
      await expect(
        prisma.hostedCodexRuntimeClosure.findMany({
          where: { gateRevision: closed.revision },
          select: { state: true, revision: true },
        }),
      ).resolves.toEqual([{ state: "draining", revision: 1n }]);
      await control.completeRuntimeClosure?.(observed);
    } finally {
      await control.disconnect();
    }
    await transitionRuntimeGate("active", "postgres_e2e_closure_crash_restore");
  });

  it("rejects forged future closures and rechecks closure safety during activation", async () => {
    const closed = await transitionRuntimeGate(
      "closed",
      "postgres_e2e_closure_insert_guard",
    );
    await expect(
      prisma.hostedCodexRuntimeClosure.create({
        data: {
          id: `forged-future-closure-${closed.revision}`,
          gateRevision: closed.revision + 1n,
          closedAuthzEpoch: closed.authzEpoch,
          actorHash: sha256("forged-future-closure"),
          reasonHash: sha256("forged-future-closure"),
          legacyBarrier: false,
          legacyUnsafeUntil: new Date(0),
        },
      }),
    ).rejects.toThrow("hosted_codex_runtime_closure_insert_invalid");
    await expect(
      prisma.hostedCodexRuntimeClosure.create({
        data: {
          id: `forged-drained-closure-${closed.revision}`,
          gateRevision: closed.revision,
          closedAuthzEpoch: closed.authzEpoch,
          actorHash: sha256("forged-drained-closure"),
          reasonHash: sha256("forged-drained-closure"),
          state: "complete",
          completedAt: new Date(),
          legacyBarrier: false,
          legacyUnsafeUntil: new Date(0),
        },
      }),
    ).rejects.toThrow("hosted_codex_runtime_closure_insert_invalid");
    const closure = await createElapsedTestRuntimeClosure({
      id: `runtime-closure-${closed.revision}`,
      gateRevision: closed.revision,
      closedAuthzEpoch: closed.authzEpoch,
      actorHash: sha256("activation-safety"),
      reasonHash: sha256("activation-safety"),
      legacyBarrier: true,
      legacyUnsafeUntil: new Date(0),
    });
    await prisma.hostedCodexRuntimeClosure.update({
      where: { id: closure.id },
      data: {
        state: "complete",
        completedAt: new Date(),
        revision: { increment: 1 },
      },
    });
    await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(
        `SET LOCAL session_replication_role = 'replica'`,
      );
      await transaction.hostedCodexRuntimeClosure.update({
        where: { id: closure.id },
        data: {
          legacyBarrier: true,
          legacyUnsafeUntil: new Date(Date.now() + 61 * 60_000),
        },
      });
    });
    await expect(
      transitionRuntimeGate("active", "unsafe_state_complete_activation"),
    ).rejects.toThrow("hosted_codex_runtime_closure_incomplete");
    await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(
        `SET LOCAL session_replication_role = 'replica'`,
      );
      await transaction.hostedCodexRuntimeClosure.update({
        where: { id: closure.id },
        data: { legacyBarrier: false, legacyUnsafeUntil: new Date(0) },
      });
    });
    await transitionRuntimeGate("active", "safe_activation_after_recheck");
  });

  it("keeps dispatch barriers immutable and rejects revoked state without evidence", async () => {
    const issued = await issueGrant("mint-guard-adversarial");
    const mintLedger = new PrismaHostedCommentTokenMintLedger(prisma);
    const mintId = "comment-mint-guard-adversarial";
    const ownerIdHash = sha256("mint-guard-adversarial-owner");
    const prepared = await mintLedger.prepare({
      mintId,
      purpose: "initial",
      logicalKeyHash: sha256(mintId),
      requestFingerprintHash: sha256(`fingerprint:${mintId}`),
      ownerIdHash,
      grantId: issued.grant.id,
      bindingId: binding,
      bindingVersion: 1,
      now: new Date(),
      leaseExpiresAt: new Date(Date.now() + 30_000),
    });
    if (prepared.state !== "prepared")
      throw new Error("postgres_e2e_prepare_failed");
    await mintLedger.authorizeDispatch({
      mintId,
      ownerIdHash,
      now: new Date(),
      dispatchAuthorizedUntil: new Date(Date.now() + 15_000),
      unsafeUntil: new Date(Date.now() + 61 * 60_000),
    });
    const dispatching =
      await prisma.hostedCodexCommentTokenMint.findUniqueOrThrow({
        where: { id: mintId },
      });
    await expect(
      prisma.hostedCodexCommentTokenMint.update({
        where: { id: mintId },
        data: {
          unsafeUntil: new Date(dispatching.unsafeUntil!.getTime() - 1),
          revision: { increment: 1 },
        },
      }),
    ).rejects.toThrow(
      "hosted_codex_comment_token_mint_identity_or_revision_invalid",
    );
    const tokenHash = sha256("mint-guard-adversarial-token");
    await mintLedger.stageRevocation({
      mintId,
      tokenHash,
      tokenExpiresAt: new Date(Date.now() + 60_000),
      secretEnvelope: testSecretEnvelope("mint-guard-adversarial-token"),
      now: new Date(),
      errorCode: "adversarial-revocation-stage",
    });
    await expect(
      prisma.hostedCodexCommentTokenMint.update({
        where: { id: mintId },
        data: {
          state: "revoked",
          completedAt: new Date(),
          revision: { increment: 1 },
        },
      }),
    ).rejects.toThrow();
    await finalizeTrustedRevocation(
      mintLedger,
      mintId,
      tokenHash,
      "trusted-revocation-evidence",
    );
  });

  it("detects same-timestamp installation selection and repository rebinding races", async () => {
    const secondInstallation = "installation-e2e-rebind";
    await prisma.gitHubInstallation.create({
      data: {
        id: secondInstallation,
        workspaceId: workspace,
        githubInstallationId: 900099n,
        accountLogin: "disposable-e2e-rebind",
        accountType: "Organization",
        repositorySelection: "selected",
        status: "active",
      },
    });
    const cases = ["selection", "repository-rebind"] as const;
    try {
      for (const authorityCase of cases) {
        const issued = await issueGrant(`same-timestamp-${authorityCase}`);
        const mintLedger = new PrismaHostedCommentTokenMintLedger(prisma);
        const mintId = `comment-mint-same-timestamp-${authorityCase}`;
        const ownerIdHash = sha256(`owner-${authorityCase}`);
        const prepared = await mintLedger.prepare({
          mintId,
          purpose: "initial",
          logicalKeyHash: sha256(mintId),
          requestFingerprintHash: sha256(`fingerprint:${mintId}`),
          ownerIdHash,
          grantId: issued.grant.id,
          bindingId: binding,
          bindingVersion: 1,
          now: new Date(),
          leaseExpiresAt: new Date(Date.now() + 30_000),
        });
        if (prepared.state !== "prepared")
          throw new Error("postgres_e2e_prepare_failed");
        await mintLedger.authorizeDispatch({
          mintId,
          ownerIdHash,
          now: new Date(),
          dispatchAuthorizedUntil: new Date(Date.now() + 15_000),
          unsafeUntil: new Date(Date.now() + 61 * 60_000),
        });
        if (authorityCase === "selection") {
          const timestamp = await prisma.gitHubInstallation.findUniqueOrThrow({
            where: { id: installation },
            select: { updatedAt: true },
          });
          await prisma.$executeRaw`
            UPDATE "GitHubInstallation"
            SET "repositorySelection" = 'all', "updatedAt" = ${timestamp.updatedAt}
            WHERE "id" = ${installation}
          `;
        } else {
          const timestamp = await prisma.repositoryConnection.findUniqueOrThrow(
            { where: { id: repository }, select: { updatedAt: true } },
          );
          await prisma.$executeRaw`
            UPDATE "RepositoryConnection"
            SET "installationId" = ${secondInstallation}, "updatedAt" = ${timestamp.updatedAt}
            WHERE "id" = ${repository}
          `;
        }
        const tokenHash = sha256(`token-${authorityCase}`);
        await expect(
          mintLedger.finalizeKnownToken({
            mintId,
            ownerIdHash,
            fenceEpoch: prepared.fenceEpoch,
            tokenHash,
            tokenExpiresAt: new Date(Date.now() + 60_000),
            secretEnvelope: testSecretEnvelope(`token-${authorityCase}`),
            now: new Date(),
          }),
        ).resolves.toBe("revoke_pending");
        if (authorityCase === "selection") {
          await prisma.$executeRaw`
            UPDATE "GitHubInstallation" SET "repositorySelection" = 'selected'
            WHERE "id" = ${installation}
          `;
        } else {
          await prisma.$executeRaw`
            UPDATE "RepositoryConnection" SET "installationId" = ${installation}
            WHERE "id" = ${repository}
          `;
        }
        await finalizeTrustedRevocation(
          mintLedger,
          mintId,
          tokenHash,
          `rebound-token-revoked-${authorityCase}`,
        );
      }
    } finally {
      await prisma.repositoryConnection.update({
        where: { id: repository },
        data: { installationId: installation },
      });
      await prisma.gitHubInstallation.delete({
        where: { id: secondInstallation },
      });
    }
  });

  it("rejects stale repository authority and gives parallel revokers one fenced claim", async () => {
    const issued = await issueGrant("mint-authority-revocation-race");
    const mintLedger = new PrismaHostedCommentTokenMintLedger(prisma);
    const staleMintId = "comment-mint-stale-repository-authority";
    const staleOwner = sha256("stale-repository-owner");
    await mintLedger.prepare({
      mintId: staleMintId,
      purpose: "initial",
      logicalKeyHash: sha256(staleMintId),
      requestFingerprintHash: sha256(`fingerprint:${staleMintId}`),
      ownerIdHash: staleOwner,
      grantId: issued.grant.id,
      bindingId: binding,
      bindingVersion: 1,
      now: new Date(),
      leaseExpiresAt: new Date(Date.now() + 30_000),
    });
    await prisma.repositoryConnection.update({
      where: { id: repository },
      data: { selected: false },
    });
    await expect(
      mintLedger.authorizeDispatch({
        mintId: staleMintId,
        ownerIdHash: staleOwner,
        now: new Date(),
        dispatchAuthorizedUntil: new Date(Date.now() + 15_000),
        unsafeUntil: new Date(Date.now() + 61 * 60_000),
      }),
    ).rejects.toThrow("hosted_comment_mint_dispatch_conflict");
    await prisma.hostedCodexCommentTokenMint.update({
      where: { id: staleMintId },
      data: {
        state: "failed_no_token",
        completedAt: new Date(),
        terminalEvidenceHash: sha256("stale-authority-before-dispatch"),
        revision: { increment: 1 },
      },
    });
    await prisma.repositoryConnection.update({
      where: { id: repository },
      data: { selected: true },
    });

    const liveIssued = await issueGrant("mint-authority-revocation-live");
    const liveMintId = "comment-mint-authority-revocation-live";
    const liveOwner = sha256("authority-revocation-live-owner");
    const prepared = await mintLedger.prepare({
      mintId: liveMintId,
      purpose: "initial",
      logicalKeyHash: sha256(liveMintId),
      requestFingerprintHash: sha256(`fingerprint:${liveMintId}`),
      ownerIdHash: liveOwner,
      grantId: liveIssued.grant.id,
      bindingId: binding,
      bindingVersion: 1,
      now: new Date(),
      leaseExpiresAt: new Date(Date.now() + 30_000),
    });
    if (prepared.state !== "prepared")
      throw new Error("postgres_e2e_prepare_failed");
    await mintLedger.authorizeDispatch({
      mintId: liveMintId,
      ownerIdHash: liveOwner,
      now: new Date(),
      dispatchAuthorizedUntil: new Date(Date.now() + 15_000),
      unsafeUntil: new Date(Date.now() + 61 * 60_000),
    });
    const tokenHash = sha256("authority-revocation-live-token");
    await expect(
      mintLedger.finalizeKnownToken({
        mintId: liveMintId,
        ownerIdHash: liveOwner,
        fenceEpoch: prepared.fenceEpoch,
        tokenHash,
        tokenExpiresAt: new Date(Date.now() + 60_000),
        secretEnvelope: testSecretEnvelope("authority-revocation-live-token"),
        now: new Date(),
      }),
    ).resolves.toBe("issued");

    // Ordinary request accounting is not an authorization mutation.
    await prisma.hostedCodexInvocationGrant.update({
      where: { id: liveIssued.grant.id },
      data: { requestCount: { increment: 1 }, revision: { increment: 1 } },
    });
    await expect(
      prisma.hostedCodexCommentTokenMint.findUniqueOrThrow({
        where: { id: liveMintId },
        select: { state: true },
      }),
    ).resolves.toEqual({ state: "issued" });

    await prisma.repositoryConnection.update({
      where: { id: repository },
      data: { archived: true },
    });
    const claimNow = new Date(Date.now() + 1);
    const claims = await Promise.all([
      mintLedger.claimRevocations({
        ownerIdHash: sha256("revoker-a"),
        now: claimNow,
        leaseExpiresAt: new Date(claimNow.getTime() + 30_000),
        limit: 1,
      }),
      new PrismaHostedCommentTokenMintLedger(prisma).claimRevocations({
        ownerIdHash: sha256("revoker-b"),
        now: claimNow,
        leaseExpiresAt: new Date(claimNow.getTime() + 30_000),
        limit: 1,
      }),
    ]);
    const claimed = claims.flat();
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ mintId: liveMintId, tokenHash });
    await mintLedger.finalizeRevoked({
      mintId: liveMintId,
      tokenHash,
      ownerIdHash: claimed[0]!.ownerIdHash,
      fenceEpoch: claimed[0]!.fenceEpoch,
      now: new Date(),
      evidenceHash: sha256("trusted-provider-revocation"),
      receipt: trustedRevocationReceipt,
    });
    await prisma.repositoryConnection.update({
      where: { id: repository },
      data: { archived: false },
    });
  });

  it("persists fair revocation backoff across restart and reclaims an expired lease", async () => {
    const ledger = new PrismaHostedCommentTokenMintLedger(prisma);
    const fixtures = ["revocation-fairness-a", "revocation-fairness-b"].map(
      (label) => ({
        mintId: `comment-mint-security-${label}`,
        grantId: invocationGrantId(`grant-security-${label}`),
      }),
    );
    const repositoryState = await prisma.repositoryConnection.findUniqueOrThrow(
      {
        where: { id: repository },
        select: { archived: true, selected: true, updatedAt: true },
      },
    );
    try {
      const first = await createIssuedMint("revocation-fairness-a");
      const second = await createIssuedMint("revocation-fairness-b");
      await prisma.repositoryConnection.update({
        where: { id: repository },
        data: { archived: true },
      });
      const firstOwner = sha256("revocation-fairness-first-worker");
      const firstClaim = await ledger.claimRevocations({
        ownerIdHash: firstOwner,
        now: new Date(),
        leaseExpiresAt: new Date(Date.now() + 2_000),
        limit: 1,
      });
      expect(firstClaim).toHaveLength(1);
      expect(firstClaim[0]!.mintId).toBe(first.mintId);
      await ledger.releaseRevocation({
        mintId: first.mintId,
        ownerIdHash: firstOwner,
        fenceEpoch: firstClaim[0]!.fenceEpoch,
        now: new Date(),
        errorCode: "provider_revoke_ambiguous",
      });
      zeroTestEnvelope(firstClaim[0]!.secretEnvelope);

      const deferred =
        await prisma.hostedCodexCommentTokenMint.findUniqueOrThrow({
          where: { id: first.mintId },
          select: { nextRevocationAt: true, revocationFailureCount: true },
        });
      expect(deferred.revocationFailureCount).toBe(1);
      expect(deferred.nextRevocationAt.getTime()).toBeGreaterThan(Date.now());

      // A new process sees the persisted delay and reaches the healthy row
      // immediately instead of allowing the first failure to monopolize work.
      const restarted = new PrismaHostedCommentTokenMintLedger(prisma);
      const secondOwner = sha256("revocation-fairness-restarted-worker");
      const secondClaim = await restarted.claimRevocations({
        ownerIdHash: secondOwner,
        now: new Date(),
        leaseExpiresAt: new Date(Date.now() + 2_000),
        limit: 2,
      });
      expect(secondClaim.map((claim) => claim.mintId)).toEqual([second.mintId]);
      await restarted.finalizeRevoked({
        mintId: second.mintId,
        tokenHash: second.tokenHash,
        ownerIdHash: secondOwner,
        fenceEpoch: secondClaim[0]!.fenceEpoch,
        now: new Date(),
        evidenceHash: sha256("revocation-fairness-second-revoked"),
        receipt: trustedRevocationReceipt,
      });
      zeroTestEnvelope(secondClaim[0]!.secretEnvelope);

      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.max(0, deferred.nextRevocationAt.getTime() - Date.now()) + 50,
        ),
      );
      const leaseOwner = sha256("revocation-fairness-crashed-worker");
      const leased = await restarted.claimRevocations({
        ownerIdHash: leaseOwner,
        now: new Date(),
        leaseExpiresAt: new Date(Date.now() + 750),
        limit: 1,
      });
      expect(leased.map((claim) => claim.mintId)).toEqual([first.mintId]);
      zeroTestEnvelope(leased[0]!.secretEnvelope);
      await expect(
        new PrismaHostedCommentTokenMintLedger(prisma).claimRevocations({
          ownerIdHash: sha256("revocation-fairness-early-restart"),
          now: new Date(),
          leaseExpiresAt: new Date(Date.now() + 2_000),
          limit: 1,
        }),
      ).resolves.toEqual([]);

      await new Promise((resolve) => setTimeout(resolve, 800));
      const finalOwner = sha256("revocation-fairness-post-expiry-worker");
      const reclaimed = await new PrismaHostedCommentTokenMintLedger(
        prisma,
      ).claimRevocations({
        ownerIdHash: finalOwner,
        now: new Date(),
        leaseExpiresAt: new Date(Date.now() + 2_000),
        limit: 1,
      });
      expect(reclaimed.map((claim) => claim.mintId)).toEqual([first.mintId]);
      expect(reclaimed[0]!.fenceEpoch).toBeGreaterThan(leased[0]!.fenceEpoch);
      await ledger.finalizeRevoked({
        mintId: first.mintId,
        tokenHash: first.tokenHash,
        ownerIdHash: finalOwner,
        fenceEpoch: reclaimed[0]!.fenceEpoch,
        now: new Date(),
        evidenceHash: sha256("revocation-fairness-first-revoked"),
        receipt: trustedRevocationReceipt,
      });
      zeroTestEnvelope(reclaimed[0]!.secretEnvelope);
    } finally {
      await cleanupCommentTokenMintFixtures({
        mintIds: fixtures.map((fixture) => fixture.mintId),
        grantIds: fixtures.map((fixture) => fixture.grantId),
        restoreRepository: repositoryState,
      });
    }
  });

  it("never finalizes stale binding, pool, repository, or installation authority as issued", async () => {
    const cases = [
      {
        name: "binding",
        invalidate: () =>
          prisma.hostedCodexRepositoryBinding.update({
            where: { id: binding },
            data: { status: "paused", stateVersion: { increment: 1 } },
          }),
        restore: () =>
          prisma.hostedCodexRepositoryBinding.update({
            where: { id: binding },
            data: { status: "active", stateVersion: { increment: 1 } },
          }),
      },
      {
        name: "pool",
        invalidate: () =>
          prisma.hostedCodexPool.update({
            where: { id: pool },
            data: { status: "paused" },
          }),
        restore: () =>
          prisma.hostedCodexPool.update({
            where: { id: pool },
            data: { status: "active" },
          }),
      },
      {
        name: "repository",
        invalidate: () =>
          prisma.repositoryConnection.update({
            where: { id: repository },
            data: { selected: false },
          }),
        restore: () =>
          prisma.repositoryConnection.update({
            where: { id: repository },
            data: { selected: true },
          }),
      },
      {
        name: "installation",
        invalidate: () =>
          prisma.gitHubInstallation.update({
            where: { id: installation },
            data: { status: "suspended" },
          }),
        restore: () =>
          prisma.gitHubInstallation.update({
            where: { id: installation },
            data: { status: "active" },
          }),
      },
    ] as const;
    for (const authorityCase of cases) {
      const issued = await issueGrant(
        `mint-stale-finalize-${authorityCase.name}`,
      );
      const mintLedger = new PrismaHostedCommentTokenMintLedger(prisma);
      const mintId = `comment-mint-stale-finalize-${authorityCase.name}`;
      const ownerIdHash = sha256(`owner-${authorityCase.name}`);
      const prepared = await mintLedger.prepare({
        mintId,
        purpose: "initial",
        logicalKeyHash: sha256(mintId),
        requestFingerprintHash: sha256(`fingerprint:${mintId}`),
        ownerIdHash,
        grantId: issued.grant.id,
        bindingId: binding,
        bindingVersion: 1,
        now: new Date(),
        leaseExpiresAt: new Date(Date.now() + 30_000),
      });
      if (prepared.state !== "prepared")
        throw new Error("postgres_e2e_prepare_failed");
      await mintLedger.authorizeDispatch({
        mintId,
        ownerIdHash,
        now: new Date(),
        dispatchAuthorizedUntil: new Date(Date.now() + 15_000),
        unsafeUntil: new Date(Date.now() + 61 * 60_000),
      });
      await authorityCase.invalidate();
      const tokenHash = sha256(`token-${authorityCase.name}`);
      try {
        await expect(
          mintLedger.finalizeKnownToken({
            mintId,
            ownerIdHash,
            fenceEpoch: prepared.fenceEpoch,
            tokenHash,
            tokenExpiresAt: new Date(Date.now() + 60_000),
            secretEnvelope: testSecretEnvelope(`token-${authorityCase.name}`),
            now: new Date(),
          }),
        ).resolves.toBe("revoke_pending");
        await finalizeTrustedRevocation(
          mintLedger,
          mintId,
          tokenHash,
          `revoked-${authorityCase.name}`,
        );
      } finally {
        await authorityCase.restore();
      }
    }
  });

  it("linearizes a same-idempotency-key prepare race to one mint, use, and provider attempt", async () => {
    const issued = await issueGrant("mint-same-key-race");
    const mintLedger = new PrismaHostedCommentTokenMintLedger(prisma);
    const mintId = "comment-mint-same-key-race";
    const requestIdHash = sha256("same-key-request");
    const owners = [sha256("same-key-owner-a"), sha256("same-key-owner-b")];
    const base = {
      mintId,
      purpose: "refresh" as const,
      logicalKeyHash: sha256(mintId),
      requestFingerprintHash: sha256(`fingerprint:${mintId}`),
      grantId: issued.grant.id,
      bindingId: binding,
      bindingVersion: 1,
      presentedTokenHash: sha256(issued.commentRefreshPlaintextToken),
      requestIdHash,
      now: new Date(),
      leaseExpiresAt: new Date(Date.now() + 30_000),
    };
    const results = await Promise.allSettled([
      mintLedger.prepare({ ...base, ownerIdHash: owners[0]! }),
      new PrismaHostedCommentTokenMintLedger(prisma).prepare({
        ...base,
        ownerIdHash: owners[1]!,
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const winner = results.findIndex((result) => result.status === "fulfilled");
    const loser = results[1 - winner]!;
    expect(loser.status).toBe("rejected");
    if (loser.status !== "rejected")
      throw new Error("postgres_e2e_same_key_loser_missing");
    expect(String(loser.reason)).toContain("hosted_comment_mint_busy");
    expect(
      await prisma.hostedCodexCommentTokenMint.count({ where: { id: mintId } }),
    ).toBe(1);
    expect(
      await prisma.hostedCodexCommentRefreshUse.count({
        where: { grantId: issued.grant.id, requestIdHash },
      }),
    ).toBe(1);
    await mintLedger.authorizeDispatch({
      mintId,
      ownerIdHash: owners[winner]!,
      now: new Date(),
      dispatchAuthorizedUntil: new Date(Date.now() + 15_000),
      unsafeUntil: new Date(Date.now() + 61 * 60_000),
    });
    await mintLedger.finalizeOutcomeUnknown({
      mintId,
      ownerIdHash: owners[winner]!,
      now: new Date(),
      errorCode: "postgres_e2e_proven_no_effect",
    });
    await expect(
      prisma.hostedCodexCommentTokenMint.findUniqueOrThrow({
        where: { id: mintId },
        select: { providerAttempt: true, state: true },
      }),
    ).resolves.toEqual({ providerAttempt: 1, state: "outcome_unknown" });
    await expect(
      prisma.hostedCodexCommentTokenMint.delete({ where: { id: mintId } }),
    ).rejects.toThrow("hosted_codex_comment_token_mint_delete_forbidden");
    await expect(
      prisma.hostedCodexCommentTokenMint.update({
        where: { id: mintId },
        data: { state: "prepared", revision: { increment: 1 } },
      }),
    ).rejects.toThrow("hosted_codex_comment_token_mint_transition_invalid");
  });

  it("allows exactly one different key to consume the final refresh budget", async () => {
    const issued = await issueGrant(
      "mint-final-refresh-budget",
      {},
      { commentRefreshMaxUses: 1 },
    );
    const mintLedger = new PrismaHostedCommentTokenMintLedger(prisma);
    const owners = [
      sha256("final-budget-owner-a"),
      sha256("final-budget-owner-b"),
    ];
    const requests = ["final-budget-request-a", "final-budget-request-b"].map(
      (request, index) => ({
        mintId: `comment-mint-${request}`,
        purpose: "refresh" as const,
        logicalKeyHash: sha256(`comment-mint-${request}`),
        requestFingerprintHash: sha256(`fingerprint:${request}`),
        ownerIdHash: owners[index]!,
        grantId: issued.grant.id,
        bindingId: binding,
        bindingVersion: 1,
        presentedTokenHash: sha256(issued.commentRefreshPlaintextToken),
        requestIdHash: sha256(request),
        now: new Date(),
        leaseExpiresAt: new Date(Date.now() + 30_000),
      }),
    );
    const results = await Promise.allSettled(
      requests.map((request) => mintLedger.prepare(request)),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const winner = results.findIndex((result) => result.status === "fulfilled");
    expect(
      await prisma.hostedCodexCommentTokenMint.count({
        where: { grantId: issued.grant.id },
      }),
    ).toBe(1);
    expect(
      await prisma.hostedCodexCommentRefreshUse.count({
        where: { grantId: issued.grant.id },
      }),
    ).toBe(1);
    await expect(
      prisma.hostedCodexCommentRefreshCapability.findUniqueOrThrow({
        where: { grantId: issued.grant.id },
        select: { useCount: true, maxUses: true },
      }),
    ).resolves.toEqual({ useCount: 1, maxUses: 1 });
    await mintLedger.authorizeDispatch({
      mintId: requests[winner]!.mintId,
      ownerIdHash: owners[winner]!,
      now: new Date(),
      dispatchAuthorizedUntil: new Date(Date.now() + 15_000),
      unsafeUntil: new Date(Date.now() + 61 * 60_000),
    });
    await mintLedger.finalizeOutcomeUnknown({
      mintId: requests[winner]!.mintId,
      ownerIdHash: owners[winner]!,
      now: new Date(),
      errorCode: "postgres_e2e_proven_no_effect",
    });
  });

  it("lets a second repository under one installation dispatch while the first provider call hangs", async () => {
    const repositoryB = repositoryId("repository-parallel-mint-b");
    const bindingB = hostedBindingId("binding-parallel-mint-b");
    await prisma.repositoryConnection.create({
      data: {
        id: repositoryB,
        workspaceId: workspace,
        provider: "github",
        externalRepositoryId: "900003",
        installationId: "installation-e2e",
        githubRepositoryId: 900003n,
        owner: "disposable-e2e",
        name: "private-fixture-b",
        fullName: "disposable-e2e/private-fixture-b",
        defaultBranch: "main",
        visibility: "private",
        selected: true,
        archived: false,
      },
    });
    await prisma.hostedCodexRepositoryBinding.create({
      data: {
        id: bindingB,
        workspaceId: workspace,
        poolId: pool,
        repositoryConnectionId: repositoryB,
        status: "active",
        revision: 1n,
        stateVersion: 1n,
        attestedGithubRepositoryId: 900003n,
        attestedBindingRevision: 1n,
        activatedAt: new Date(),
      },
    });
    const issuedA = await issueGrant("parallel-mint-a");
    const issuedB = await issueGrant(
      "parallel-mint-b",
      {},
      {
        repositoryId: repositoryB,
        bindingId: bindingB,
      },
    );
    const mintLedger = new PrismaHostedCommentTokenMintLedger(prisma);
    const ownerA = sha256("parallel-mint-owner-a");
    const ownerB = sha256("parallel-mint-owner-b");
    const preparedA = await mintLedger.prepare({
      mintId: "comment-mint-parallel-a",
      purpose: "initial",
      logicalKeyHash: sha256("comment-mint-parallel-a"),
      requestFingerprintHash: sha256("fingerprint:comment-mint-parallel-a"),
      ownerIdHash: ownerA,
      grantId: issuedA.grant.id,
      bindingId: binding,
      bindingVersion: 1,
      now: new Date(),
      leaseExpiresAt: new Date(Date.now() + 30_000),
    });
    if (preparedA.state !== "prepared")
      throw new Error("postgres_e2e_prepare_failed");
    await mintLedger.authorizeDispatch({
      mintId: preparedA.mintId,
      ownerIdHash: ownerA,
      now: new Date(),
      dispatchAuthorizedUntil: new Date(Date.now() + 15_000),
      unsafeUntil: new Date(Date.now() + 61 * 60_000),
    });
    // No ledger call remains open while repository A's provider POST hangs.
    const preparedB = await Promise.race([
      mintLedger.prepare({
        mintId: "comment-mint-parallel-b",
        purpose: "initial",
        logicalKeyHash: sha256("comment-mint-parallel-b"),
        requestFingerprintHash: sha256("fingerprint:comment-mint-parallel-b"),
        ownerIdHash: ownerB,
        grantId: issuedB.grant.id,
        bindingId: bindingB,
        bindingVersion: 1,
        now: new Date(),
        leaseExpiresAt: new Date(Date.now() + 30_000),
      }),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("postgres_e2e_parallel_mint_blocked")),
          2_000,
        ),
      ),
    ]);
    if (preparedB.state !== "prepared")
      throw new Error("postgres_e2e_prepare_failed");
    await mintLedger.authorizeDispatch({
      mintId: preparedB.mintId,
      ownerIdHash: ownerB,
      now: new Date(),
      dispatchAuthorizedUntil: new Date(Date.now() + 15_000),
      unsafeUntil: new Date(Date.now() + 61 * 60_000),
    });
    await Promise.all([
      mintLedger.finalizeOutcomeUnknown({
        mintId: preparedA.mintId,
        ownerIdHash: ownerA,
        now: new Date(),
        errorCode: "postgres_e2e_proven_no_effect",
      }),
      mintLedger.finalizeOutcomeUnknown({
        mintId: preparedB.mintId,
        ownerIdHash: ownerB,
        now: new Date(),
        errorCode: "postgres_e2e_proven_no_effect",
      }),
    ]);
  });

  it("releases an expired prepared request and resumes the same exhausted idempotency identity", async () => {
    let clock = new Date();
    const effects = new PrismaHostedCodexUpstreamEffectLedger(
      prisma,
      () => clock,
    );
    // sweepExpired is intentionally a global bounded worker operation. Drain
    // orphaned candidates from earlier crash fixtures before asserting the
    // exact cardinality created by this fixture.
    let orphanedCandidates: number;
    do {
      orphanedCandidates = await effects.sweepExpired();
    } while (orphanedCandidates !== 0);
    const issued = await issueGrant("prepared-safe-retry", {
      maxRequests: 1,
      maxConcurrentRequests: 1,
    });
    const authorization = new PrismaHostedCodexRelayAuthorization(prisma);
    const admitted = await authorization.authorize({
      opaqueGrant: issued.plaintextToken,
      requestOrdinal: 1,
      idempotencyKey: "prepared-safe-retry",
      requestBytes: 64,
    });
    const requestHash = sha256("prepared-safe-retry-body");
    await ledger.recordRequestHash({
      grantId: issued.grant.id,
      requestId: admitted.requestId,
      requestHash,
    });
    const expired = await effects.prepare({
      relayRequestId: admitted.requestId,
      grantId: issued.grant.id,
      workspaceId: workspace,
      poolId: pool,
      accountId: "account-primary",
      credentialGeneration: await activeCredentialGeneration("account-primary"),
      requestHash,
      leaseMs: 5_000,
    });
    const liveIssued = await issueGrant("prepared-safe-retry-live-sibling");
    const liveAdmitted = await authorization.authorize({
      opaqueGrant: liveIssued.plaintextToken,
      requestOrdinal: 1,
      idempotencyKey: "prepared-safe-retry-live-sibling",
      requestBytes: 64,
    });
    const liveRequestHash = sha256("prepared-safe-retry-live-sibling-body");
    await ledger.recordRequestHash({
      grantId: liveIssued.grant.id,
      requestId: liveAdmitted.requestId,
      requestHash: liveRequestHash,
    });
    const live = await effects.prepare({
      relayRequestId: liveAdmitted.requestId,
      grantId: liveIssued.grant.id,
      workspaceId: workspace,
      poolId: pool,
      accountId: "account-primary",
      credentialGeneration: await activeCredentialGeneration("account-primary"),
      requestHash: liveRequestHash,
    });
    clock = new Date(clock.getTime() + 5_001);
    expect(await effects.sweepExpired()).toBe(1);
    await expect(
      prisma.hostedCodexUpstreamEffectAttempt.findUniqueOrThrow({
        where: { id: expired.attemptId },
        select: { state: true },
      }),
    ).resolves.toEqual({ state: "failed_no_effect" });
    await expect(
      prisma.hostedCodexUpstreamEffectAttempt.findUniqueOrThrow({
        where: { id: live.attemptId },
        select: { state: true },
      }),
    ).resolves.toEqual({ state: "prepared" });
    await expect(
      prisma.hostedCodexRelayRequest.findUniqueOrThrow({
        where: { id: liveAdmitted.requestId },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "processing" });
    expect(
      await prisma.hostedCodexInvocationGrant.findUniqueOrThrow({
        where: { id: issued.grant.id },
      }),
    ).toMatchObject({ status: "exhausted", requestCount: 1, inFlight: 0 });
    const resumed = await authorization.authorize({
      opaqueGrant: issued.plaintextToken,
      requestOrdinal: 1,
      idempotencyKey: "prepared-safe-retry",
      requestBytes: 64,
    });
    expect(resumed.requestId).toBe(admitted.requestId);
    expect(
      await prisma.hostedCodexInvocationGrant.findUniqueOrThrow({
        where: { id: issued.grant.id },
      }),
    ).toMatchObject({ status: "exhausted", requestCount: 1, inFlight: 1 });
    const retry = await effects.prepare({
      relayRequestId: resumed.requestId,
      grantId: issued.grant.id,
      workspaceId: workspace,
      poolId: pool,
      accountId: "account-primary",
      credentialGeneration: await activeCredentialGeneration("account-primary"),
      requestHash,
    });
    expect(retry.fenceEpoch).toBe(2n);
  });

  it("poisons an exhausted grant without erasing a concurrent sibling completion", async () => {
    const issued = await issueGrant("poison-concurrent-sibling", {
      maxRequests: 2,
      maxConcurrentRequests: 2,
    });
    const authorization = new PrismaHostedCodexRelayAuthorization(prisma);
    const effects = new PrismaHostedCodexUpstreamEffectLedger(prisma);
    const prepare = async (ordinal: number) => {
      const admitted = await authorization.authorize({
        opaqueGrant: issued.plaintextToken,
        requestOrdinal: ordinal,
        idempotencyKey: `poison-concurrent-${ordinal}`,
        requestBytes: 64,
      });
      const requestHash = sha256(`poison-concurrent-${ordinal}`);
      await ledger.recordRequestHash({
        grantId: issued.grant.id,
        requestId: admitted.requestId,
        requestHash,
      });
      const effect = await effects.prepare({
        relayRequestId: admitted.requestId,
        grantId: issued.grant.id,
        workspaceId: workspace,
        poolId: pool,
        accountId: "account-primary",
        credentialGeneration:
          await activeCredentialGeneration("account-primary"),
        requestHash,
      });
      await effects.markDispatching(effect);
      return { admitted, effect };
    };
    const first = await prepare(1);
    const second = await prepare(2);
    await effects.finish(first.effect, {
      state: "terminal_unknown",
      errorCode: "ambiguous-first-sibling",
      evidence: "poison-concurrent-first",
    });
    expect(
      await prisma.hostedCodexInvocationGrant.findUniqueOrThrow({
        where: { id: issued.grant.id },
      }),
    ).toMatchObject({ status: "revoked", requestCount: 2, inFlight: 1 });
    await recordHostedPoolProviderResponseStarted(
      {
        grantId: invocationGrantId(issued.grant.id),
        requestId: relayRequestId(second.admitted.requestId),
        startedAt: new Date(),
        effect: {
          ...effects.authority(second.effect),
          providerResponseIdHash: null,
        },
      },
      ledger,
    );
    await recordHostedPoolSuccessfulProviderResponse(
      {
        grantId: invocationGrantId(issued.grant.id),
        requestId: relayRequestId(second.admitted.requestId),
        responseBytes: 2,
        responseHash: sha256("ok"),
        completedAt: new Date(),
        effect: {
          ...effects.authority(second.effect),
          terminalState: "succeeded",
          terminalEvidenceHash: sha256("sibling-completed"),
        },
      },
      ledger,
    );
    expect(
      await prisma.hostedCodexInvocationGrant.findUniqueOrThrow({
        where: { id: issued.grant.id },
      }),
    ).toMatchObject({ status: "revoked", requestCount: 2, inFlight: 0 });
  });

  it("rejects forged terminal INSERTs and enforces the absolute dispatch deadline", async () => {
    const issuedMint = await createIssuedMint("insert-guard");
    const forgedId = "comment-mint-forged-terminal-insert";
    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "HostedCodexCommentTokenMint"
        SELECT (jsonb_populate_record(
          NULL::"HostedCodexCommentTokenMint",
          to_jsonb(mint) || jsonb_build_object(
            'id', '${forgedId}',
            'logicalKeyHash', '${sha256(forgedId)}'
          )
        )).* FROM "HostedCodexCommentTokenMint" mint
        WHERE mint."id" = '${issuedMint.mintId}'
      `),
    ).rejects.toThrow("hosted_codex_comment_token_mint_insert_shape_invalid");

    const delayed = await createDispatchingMint("dispatch-deadline");
    await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(
        `SET LOCAL session_replication_role = 'replica'`,
      );
      await transaction.hostedCodexCommentTokenMint.update({
        where: { id: delayed.mintId },
        data: { dispatchAuthorizedUntil: new Date(0) },
      });
    });
    await expect(
      delayed.ledger.confirmDispatch({
        mintId: delayed.mintId,
        ownerIdHash: delayed.ownerIdHash,
      }),
    ).rejects.toThrow("hosted_comment_mint_dispatch_authorization_expired");
    await forceTerminalNoToken(delayed.mintId);
    await issuedMint.ledger.stageRevocation({
      mintId: issuedMint.mintId,
      tokenHash: issuedMint.tokenHash,
      tokenExpiresAt: issuedMint.tokenExpiresAt,
      now: new Date(),
      errorCode: "insert_guard_cleanup",
    });
    await finalizeTrustedRevocation(
      issuedMint.ledger,
      issuedMint.mintId,
      issuedMint.tokenHash,
      "insert-guard-cleanup",
    );
  });

  it("rejects caller-forged custody prepare authority snapshots", async () => {
    const issued = await issueGrant("prepare-authority-forgery");
    const ledger = new PrismaHostedCommentTokenMintLedger(prisma);
    const sourceId = "comment-mint-prepare-authority-source";
    const ownerIdHash = sha256("prepare-authority-source-owner");
    await ledger.prepare({
      mintId: sourceId,
      purpose: "initial",
      ownerIdHash,
      logicalKeyHash: sha256(sourceId),
      requestFingerprintHash: sha256(`fingerprint:${sourceId}`),
      grantId: issued.grant.id,
      bindingId: binding,
      bindingVersion: 1,
      now: new Date(),
      leaseExpiresAt: new Date(Date.now() + 30_000),
    });
    const source = await prisma.hostedCodexCommentTokenMint.findUniqueOrThrow({
      where: { id: sourceId },
    });
    const base = {
      mintId: "comment-mint-forged-authority-copy",
      purpose: source.purpose,
      ownerIdHash: source.ownerIdHash,
      logicalKeyHash: sha256("comment-mint-forged-authority-copy"),
      requestFingerprintHash: sha256("forged-authority-fingerprint"),
      grantId: source.grantId,
      capabilityId: "",
      requestIdHash: "",
      presentedTokenHash: "",
      runtimeAuthzEpoch: source.runtimeAuthzEpoch.toString(),
      runtimeGateRevision: source.runtimeGateRevision.toString(),
      workspaceId: source.workspaceId,
      repositoryBindingId: source.repositoryBindingId,
      bindingRevision: source.bindingRevision.toString(),
      bindingStateVersion: source.bindingStateVersion.toString(),
      poolId: source.poolId,
      poolRevision: source.poolRevision.toString(),
      poolAuthzEpoch: source.poolAuthzEpoch.toString(),
      repositoryConnectionId: source.repositoryConnectionId,
      repositoryUpdatedAt: source.repositoryUpdatedAt.toISOString(),
      githubInstallationRowId: source.githubInstallationRowId,
      installationUpdatedAt: source.installationUpdatedAt.toISOString(),
      installationStatus: source.installationStatus,
      installationSelection: source.installationSelection,
      installationWorkspaceId: source.installationWorkspaceId,
      githubInstallationId: source.githubInstallationId.toString(),
      githubRepositoryId: source.githubRepositoryId.toString(),
      repositoryFullName: source.repositoryFullName,
      leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
    const directPrepare = (arguments_: Record<string, string>) =>
      custodyPrisma.$queryRawUnsafe(
        `SELECT * FROM public.hosted_codex_mutate_comment_token_mint('prepare',$1::jsonb)`,
        JSON.stringify(arguments_),
      );

    await expect(
      directPrepare({ ...base, installationSelection: "caller-forged" }),
    ).rejects.toThrow(
      "hosted_codex_comment_token_mint_insert_authority_invalid",
    );

    await prisma.$executeRawUnsafe(
      `UPDATE "RepositoryConnection" SET "visibility"='public' WHERE "id"='${repository}'`,
    );
    try {
      await expect(
        directPrepare({ ...base, mintId: `${base.mintId}-public` }),
      ).rejects.toThrow(
        "hosted_codex_comment_token_mint_insert_authority_invalid",
      );
    } finally {
      await prisma.$executeRawUnsafe(
        `UPDATE "RepositoryConnection" SET "visibility"='private' WHERE "id"='${repository}'`,
      );
    }

    await adjustInvocationGrantFixture(issued.grant.id, "authzEpoch", 1);
    try {
      await expect(
        directPrepare({ ...base, mintId: `${base.mintId}-grant-epoch` }),
      ).rejects.toThrow(
        "hosted_codex_comment_token_mint_insert_authority_invalid",
      );
    } finally {
      await adjustInvocationGrantFixture(issued.grant.id, "authzEpoch", -1);
    }

    await adjustInvocationGrantFixture(issued.grant.id, "bindingRevision", 1);
    try {
      await expect(
        directPrepare({ ...base, mintId: `${base.mintId}-binding-revision` }),
      ).rejects.toThrow(
        "hosted_codex_comment_token_mint_insert_authority_invalid",
      );
    } finally {
      await adjustInvocationGrantFixture(
        issued.grant.id,
        "bindingRevision",
        -1,
      );
    }
    await forceTerminalNoToken(sourceId);
  });

  it("bounds provider expiry by fresh database time and unsafeUntil", async () => {
    for (const [label, tokenExpiresAt] of [
      ["past", new Date(0)],
      ["too-long", new Date(Date.now() + 62 * 60_000)],
    ] as const) {
      const dispatched = await createDispatchingMint(`expiry-${label}`);
      await expect(
        dispatched.ledger.finalizeKnownToken({
          mintId: dispatched.mintId,
          ownerIdHash: dispatched.ownerIdHash,
          fenceEpoch: dispatched.fenceEpoch,
          tokenHash: sha256(`expiry-${label}-token`),
          tokenExpiresAt,
          secretEnvelope: testSecretEnvelope(`expiry-${label}-token`),
          now: new Date(),
        }),
      ).rejects.toThrow("hosted_comment_mint_provider_expiry_invalid");
      await forceTerminalNoToken(dispatched.mintId);
    }
  });

  it("revokes issued tokens on active epoch and installation workspace mutations and rejects forged proof", async () => {
    const gateMint = await createIssuedMint("active-epoch-revoke");
    await prisma.hostedCodexRuntimeGate.update({
      where: { id: "global" },
      data: {
        authzEpoch: { increment: 1 },
        revision: { increment: 1 },
        reasonCode: "postgres_e2e_active_epoch_revoke",
        changedAt: new Date(),
        changedByHash: sha256("postgres_e2e_active_epoch_revoke"),
      },
    });
    await expect(
      prisma.hostedCodexCommentTokenMint.findUniqueOrThrow({
        where: { id: gateMint.mintId },
        select: { state: true },
      }),
    ).resolves.toEqual({ state: "revoke_pending" });
    await expect(
      prisma.hostedCodexCommentTokenMint.update({
        where: { id: gateMint.mintId },
        data: {
          state: "revoked",
          completedAt: new Date(),
          revocationEvidenceHash: sha256("forged-proof"),
          secretCiphertext: null,
          secretEncryptedDataKey: null,
          secretIv: null,
          secretAuthTag: null,
          secretKeyId: null,
          secretAadHash: null,
          revision: { increment: 1 },
        },
      }),
    ).rejects.toThrow("hosted_codex_comment_token_revocation_proof_invalid");
    await finalizeTrustedRevocation(
      gateMint.ledger,
      gateMint.mintId,
      gateMint.tokenHash,
      "trusted-active-epoch-proof",
    );
    await expect(
      prisma.hostedCodexCommentTokenMint.findUniqueOrThrow({
        where: { id: gateMint.mintId },
        select: { state: true, secretCiphertext: true },
      }),
    ).resolves.toEqual({ state: "revoked", secretCiphertext: null });

    const workspaceMint = await createIssuedMint("workspace-revoke");
    const alternateWorkspace = workspaceId("workspace-e2e-alternate");
    await prisma.workspace.create({
      data: {
        id: alternateWorkspace,
        slug: "hosted-pool-e2e-alternate",
        name: "Hosted pool E2E alternate",
      },
    });
    await prisma.gitHubInstallation.update({
      where: { id: installation },
      data: { workspaceId: alternateWorkspace },
    });
    await expect(
      prisma.hostedCodexCommentTokenMint.findUniqueOrThrow({
        where: { id: workspaceMint.mintId },
        select: { state: true },
      }),
    ).resolves.toEqual({ state: "revoke_pending" });
    await prisma.gitHubInstallation.update({
      where: { id: installation },
      data: { workspaceId: workspace },
    });
    await finalizeTrustedRevocation(
      workspaceMint.ledger,
      workspaceMint.mintId,
      workspaceMint.tokenHash,
      "trusted-workspace-proof",
    );
    await prisma.workspace.delete({ where: { id: alternateWorkspace } });
  });

  it("denies revocation forgery and fake-token terminalization from every runtime role", async () => {
    const pending = await createIssuedMint("runtime-role-proof-attack");
    await prisma.repositoryConnection.update({
      where: { id: repository },
      data: { archived: true },
    });
    await prisma.repositoryConnection.update({
      where: { id: repository },
      data: { archived: false },
    });
    const unknown = await createDispatchingMint("runtime-role-token-attack");
    await unknown.ledger.finalizeOutcomeUnknown({
      mintId: unknown.mintId,
      ownerIdHash: unknown.ownerIdHash,
      now: new Date(),
      errorCode: "ambiguous",
    });

    for (const role of [
      "reviewrouter_api",
      "reviewrouter_web",
      "reviewrouter_worker",
    ]) {
      const runAsRole = async (
        operation: (transaction: typeof prisma) => Promise<unknown>,
      ) =>
        role === "reviewrouter_api"
          ? apiPrisma.$transaction((transaction) =>
              operation(transaction as never),
            )
          : prisma.$transaction(async (transaction) => {
              await transaction.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
              return operation(transaction as never);
            });
      await expect(
        runAsRole(async (transaction) => {
          await transaction.$executeRawUnsafe(
            `UPDATE "HostedCodexCommentTokenMint" SET "state"='revoke_pending', "tokenHash"='${sha256(`fake:${role}`)}', "tokenExpiresAt"=clock_timestamp()+interval '1 hour', "revision"="revision"+1 WHERE "id"='${unknown.mintId}'`,
          );
        }),
      ).rejects.toThrow(/permission denied/iu);
      await expect(
        runAsRole(async (transaction) => {
          await transaction.$queryRawUnsafe(
            `SELECT hosted_codex_finalize_comment_token_revocation('${pending.mintId}','${pending.tokenHash}','${sha256(`forged:${role}`)}','${sha256("owner")}',1,'github_token_delete','revoked')`,
          );
        }),
      ).rejects.toThrow(/permission denied|proof_shape_invalid/iu);
    }

    await finalizeTrustedRevocation(
      pending.ledger,
      pending.mintId,
      pending.tokenHash,
      "runtime-role-attack-cleanup",
    );
  });

  it("linearizes replay with authority mutation in both commit orders", async () => {
    const replayFirst = await createIssuedMint("replay-first");
    let authorityLocked!: () => void;
    let releaseReplay!: () => void;
    const locked = new Promise<void>((resolve) => (authorityLocked = resolve));
    const release = new Promise<void>((resolve) => (releaseReplay = resolve));
    const replayLedger = new PrismaHostedCommentTokenMintLedger(prisma, {
      afterReplayAuthority: async () => {
        authorityLocked();
        await release;
      },
    });
    const replay = replayLedger.replayAuthorized({
      mintId: replayFirst.mintId,
    });
    await locked;
    let mutationSettled = false;
    const mutation = prisma.repositoryConnection
      .update({ where: { id: repository }, data: { selected: false } })
      .finally(() => (mutationSettled = true));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mutationSettled).toBe(false);
    releaseReplay();
    const delivered = await replay;
    zeroTestEnvelope(delivered.secretEnvelope);
    await mutation;
    await prisma.repositoryConnection.update({
      where: { id: repository },
      data: { selected: true },
    });
    await finalizeTrustedRevocation(
      replayFirst.ledger,
      replayFirst.mintId,
      replayFirst.tokenHash,
      "trusted-replay-first-proof",
    );

    const mutationFirst = await createIssuedMint("mutation-first");
    await prisma.repositoryConnection.update({
      where: { id: repository },
      data: { archived: true },
    });
    await expect(
      mutationFirst.ledger.replayAuthorized({ mintId: mutationFirst.mintId }),
    ).rejects.toThrow("hosted_comment_mint_replay_not_authorized");
    await prisma.repositoryConnection.update({
      where: { id: repository },
      data: { archived: false },
    });
    await finalizeTrustedRevocation(
      mutationFirst.ledger,
      mutationFirst.mintId,
      mutationFirst.tokenHash,
      "trusted-mutation-first-proof",
    );
  });

  it("recovers a crashed delivery claimant only after the database lease expires", async () => {
    const issued = await createIssuedMint("delivery-claim-crash-recovery");
    const crashedClaim = sha256("delivery-claim-crashed-process");
    const restartedClaim = sha256("delivery-claim-restarted-process");
    await issued.ledger.confirmReplayDelivery({
      mintId: issued.mintId,
      tokenHash: issued.tokenHash,
      deliveryClaimIdHash: crashedClaim,
    });

    const restartedLedger = new PrismaHostedCommentTokenMintLedger(prisma);
    await expect(
      restartedLedger.confirmReplayDelivery({
        mintId: issued.mintId,
        tokenHash: issued.tokenHash,
        deliveryClaimIdHash: restartedClaim,
      }),
    ).rejects.toThrow("hosted_comment_mint_replay_not_authorized");

    await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(
        `SET LOCAL session_replication_role = 'replica'`,
      );
      await transaction.hostedCodexCommentTokenMint.update({
        where: { id: issued.mintId },
        data: { deliveryClaimExpiresAt: new Date(0) },
      });
    });
    await expect(
      restartedLedger.confirmReplayDelivery({
        mintId: issued.mintId,
        tokenHash: issued.tokenHash,
        deliveryClaimIdHash: restartedClaim,
      }),
    ).resolves.toBeUndefined();
    await expect(
      issued.ledger.confirmReplayDelivery({
        mintId: issued.mintId,
        tokenHash: issued.tokenHash,
        deliveryClaimIdHash: crashedClaim,
      }),
    ).rejects.toThrow("hosted_comment_mint_replay_not_authorized");
    await expect(
      prisma.hostedCodexCommentTokenMint.findUniqueOrThrow({
        where: { id: issued.mintId },
        select: { deliveryClaimIdHash: true },
      }),
    ).resolves.toEqual({ deliveryClaimIdHash: restartedClaim });
  });

  it("keeps a failed release exactly once and permits retry only after expiry", async () => {
    const issued = await createIssuedMint("delivery-release-write-failure");
    const originalClaim = sha256("delivery-release-original-owner");
    const retryClaim = sha256("delivery-release-retry-owner");
    await issued.ledger.confirmReplayDelivery({
      mintId: issued.mintId,
      tokenHash: issued.tokenHash,
      deliveryClaimIdHash: originalClaim,
    });
    await expect(
      issued.ledger.releaseDelivery({
        mintId: issued.mintId,
        tokenHash: issued.tokenHash,
        deliveryClaimIdHash: sha256("delivery-release-wrong-owner"),
      }),
    ).rejects.toThrow("hosted_comment_mint_delivery_release_conflict");
    await expect(
      issued.ledger.confirmReplayDelivery({
        mintId: issued.mintId,
        tokenHash: issued.tokenHash,
        deliveryClaimIdHash: retryClaim,
      }),
    ).rejects.toThrow("hosted_comment_mint_replay_not_authorized");

    await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(
        `SET LOCAL session_replication_role = 'replica'`,
      );
      await transaction.hostedCodexCommentTokenMint.update({
        where: { id: issued.mintId },
        data: { deliveryClaimExpiresAt: new Date(0) },
      });
    });
    await expect(
      issued.ledger.confirmReplayDelivery({
        mintId: issued.mintId,
        tokenHash: issued.tokenHash,
        deliveryClaimIdHash: retryClaim,
      }),
    ).resolves.toBeUndefined();
    await expect(
      issued.ledger.releaseDelivery({
        mintId: issued.mintId,
        tokenHash: issued.tokenHash,
        deliveryClaimIdHash: originalClaim,
      }),
    ).rejects.toThrow("hosted_comment_mint_delivery_release_conflict");
  });

  it("never exposes transaction-local replica mode to another pooled connection", async () => {
    const sibling = createPrismaClient({ databaseUrl, poolMax: 1 });
    await sibling.$connect();
    try {
      await prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(
          `SET LOCAL session_replication_role = 'replica'`,
        );
        await expect(
          sibling.$queryRaw<Array<{ mode: string }>>`
            SELECT current_setting('session_replication_role') AS mode
          `,
        ).resolves.toEqual([{ mode: "origin" }]);
      });
      await expect(
        prisma.$queryRaw<Array<{ mode: string }>>`
          SELECT current_setting('session_replication_role') AS mode
        `,
      ).resolves.toEqual([{ mode: "origin" }]);
    } finally {
      await sibling.$disconnect();
    }
  });

  it.each(["grant", "capability"] as const)(
    "rechecks every mint boundary after a mint-row wait crosses %s expiry",
    async (expiryKind) => {
      const names = [
        "authorize",
        "confirm",
        "replay",
        "delivery",
        "finalize",
      ] as const;
      const issued = await Promise.all(
        names.map((name) =>
          issueGrant(`mint-lock-expiry-${expiryKind}-${name}`),
        ),
      );
      const fixtures = [] as Array<{
        name: (typeof names)[number];
        ledger: PrismaHostedCommentTokenMintLedger;
        mintId: string;
        ownerIdHash: string;
        fenceEpoch: bigint;
        tokenHash: string;
      }>;
      for (const [index, name] of names.entries()) {
        const grant = issued[index]!;
        const mintId = `comment-mint-lock-expiry-${expiryKind}-${name}`;
        const ownerIdHash = sha256(`owner:${mintId}`);
        const mintLedger = new PrismaHostedCommentTokenMintLedger(prisma);
        const prepared = await mintLedger.prepare({
          mintId,
          purpose: expiryKind === "capability" ? "refresh" : "initial",
          logicalKeyHash: sha256(mintId),
          requestFingerprintHash: sha256(`fingerprint:${mintId}`),
          ownerIdHash,
          grantId: grant.grant.id,
          bindingId: binding,
          bindingVersion: 1,
          ...(expiryKind === "capability"
            ? {
                presentedTokenHash: sha256(grant.commentRefreshPlaintextToken),
                requestIdHash: sha256(`request:${mintId}`),
              }
            : {}),
          now: new Date(),
          leaseExpiresAt: new Date(Date.now() + 30_000),
        });
        if (prepared.state !== "prepared")
          throw new Error("postgres_e2e_prepare_failed");
        if (name !== "authorize") {
          await mintLedger.authorizeDispatch({
            mintId,
            ownerIdHash,
            now: new Date(),
            dispatchAuthorizedUntil: new Date(Date.now() + 30_000),
            unsafeUntil: new Date(Date.now() + 61 * 60_000),
          });
        }
        const tokenHash = sha256(`token:${mintId}`);
        if (name === "replay" || name === "delivery") {
          await expect(
            mintLedger.finalizeKnownToken({
              mintId,
              ownerIdHash,
              fenceEpoch: prepared.fenceEpoch,
              tokenHash,
              tokenExpiresAt: new Date(Date.now() + 60_000),
              secretEnvelope: testSecretEnvelope(`token:${mintId}`),
              now: new Date(),
            }),
          ).resolves.toBe("issued");
        }
        fixtures.push({
          name,
          ledger: mintLedger,
          mintId,
          ownerIdHash,
          fenceEpoch: prepared.fenceEpoch,
          tokenHash,
        });
      }

      // Model natural deadline passage without firing the update-triggered
      // revocation path merely because the future deadline is shortened.
      const authorityExpiresAt = new Date(Date.now() + 3_000);
      await prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(
          `SET LOCAL session_replication_role = 'replica'`,
        );
        if (expiryKind === "grant") {
          await transaction.hostedCodexInvocationGrant.updateMany({
            where: { id: { in: issued.map((item) => item.grant.id) } },
            data: { expiresAt: authorityExpiresAt },
          });
        } else {
          await transaction.hostedCodexCommentRefreshCapability.updateMany({
            where: { grantId: { in: issued.map((item) => item.grant.id) } },
            data: { expiresAt: authorityExpiresAt },
          });
        }
      });

      let locksReady!: () => void;
      let releaseLocks!: () => void;
      const ready = new Promise<void>((resolve) => (locksReady = resolve));
      const release = new Promise<void>((resolve) => (releaseLocks = resolve));
      const holder = prisma.$transaction(
        async (transaction) => {
          for (const fixture of [...fixtures].sort((a, b) =>
            a.mintId.localeCompare(b.mintId),
          )) {
            await transaction.$queryRaw`
              SELECT "id" FROM "HostedCodexCommentTokenMint"
              WHERE "id" = ${fixture.mintId} FOR UPDATE
            `;
          }
          locksReady();
          await release;
        },
        { timeout: 20_000 },
      );
      await ready;

      const pending = fixtures.map((fixture) => {
        switch (fixture.name) {
          case "authorize":
            return fixture.ledger.authorizeDispatch({
              mintId: fixture.mintId,
              ownerIdHash: fixture.ownerIdHash,
              now: new Date(),
              dispatchAuthorizedUntil: new Date(Date.now() + 15_000),
              unsafeUntil: new Date(Date.now() + 61 * 60_000),
            });
          case "confirm":
            return fixture.ledger.confirmDispatch({
              mintId: fixture.mintId,
              ownerIdHash: fixture.ownerIdHash,
            });
          case "replay":
            return fixture.ledger.replayAuthorized({ mintId: fixture.mintId });
          case "delivery":
            return fixture.ledger.confirmReplayDelivery({
              mintId: fixture.mintId,
              tokenHash: fixture.tokenHash,
              deliveryClaimIdHash: sha256(`delivery:${fixture.mintId}`),
            });
          case "finalize":
            return fixture.ledger.finalizeKnownToken({
              mintId: fixture.mintId,
              ownerIdHash: fixture.ownerIdHash,
              fenceEpoch: fixture.fenceEpoch,
              tokenHash: fixture.tokenHash,
              tokenExpiresAt: new Date(Date.now() + 60_000),
              secretEnvelope: testSecretEnvelope(`token:${fixture.mintId}`),
              now: new Date(),
            });
        }
      });
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.max(0, authorityExpiresAt.getTime() - Date.now() + 100),
        ),
      );
      releaseLocks();
      await holder;
      const results = await Promise.allSettled(pending);
      expect(
        results.slice(0, 4).every((result) => result.status === "rejected"),
      ).toBe(true);
      expect(results[4]).toEqual({
        status: "fulfilled",
        value: "revoke_pending",
      });
    },
    30_000,
  );

  it("runs 52 grants through two real session-runtime replicas without an invocation gate", async () => {
    const replica = createPrismaClient({
      databaseUrl: databaseUrl!,
      poolMax: 30,
    });
    await replica.$connect();
    try {
      const runtimeFor = (client: typeof prisma) =>
        new HostedCodexSessionRuntime({
          sessionStore: new HostedCodexSessionStore(
            new PrismaHostedCodexSessionPersistence(
              client,
              vault,
              databaseIncarnation,
              databaseResourceIdentity,
              Buffer.alloc(32, 29),
            ),
          ),
          leaseStore: new HostedCodexMutationFenceLeaseStore(
            new PrismaHostedCodexMutationFence(client),
          ),
        });
      const runtimes = [runtimeFor(prisma), runtimeFor(replica)];
      const beforeFence = await prisma.hostedCodexMutationFence.findUnique({
        where: { accountId: "account-primary" },
      });
      const grants = await Promise.all(
        Array.from({ length: 52 }, (_, index) =>
          issueGrant(`parallel-52-${index}`),
        ),
      );
      let active = 0;
      let maximumActive = 0;
      let entered = 0;
      let release: (() => void) | undefined;
      const allEntered = new Promise<void>((resolve) => {
        release = resolve;
      });
      const safety = setTimeout(() => release?.(), 120_000);
      await Promise.all(
        grants.map(async (grant, index) => {
          const session = await runtimes[index % 2]!.ensureFreshSession({
            accountId: grant.grant.activeAccountId,
            runId: `real-runtime-${index}`,
            attempt: 1,
            abortSignal: AbortSignal.timeout(120_000),
          });
          expect(session.chatgptAccountId).toBe("chatgpt-primary");
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          entered += 1;
          if (entered === grants.length) release?.();
          await allEntered;
          active -= 1;
        }),
      );
      clearTimeout(safety);
      expect(maximumActive).toBe(52);
      const afterFence = await prisma.hostedCodexMutationFence.findUnique({
        where: { accountId: "account-primary" },
      });
      expect(afterFence?.fenceEpoch).toBe(beforeFence?.fenceEpoch);
      expect(afterFence?.ownerIdHash ?? null).toBeNull();

      const enrollment = new PrismaHostedCredentialEnrollment(
        prisma,
        vault,
        databaseIncarnation,
        databaseResourceIdentity,
        Buffer.alloc(32, 29),
      );
      await enrollment.importCodexAuth({
        workspaceId: workspace,
        poolId: pool,
        accountId: hostedAccountId("account-expired-concurrency"),
        label: "Expired concurrency",
        priority: 5,
        expectedPoolRevision: 3,
        authJsonBytes: validAuthJson(
          "expired-concurrency",
          "expired-access",
          "expired-refresh",
          new Date(Date.now() - 2 * 60 * 60_000),
        ),
        now: new Date(),
      });
      let refreshCalls = 0;
      for (const runtime of runtimes) {
        vi.spyOn(runtime.sessionDriver, "refreshSession").mockImplementation(
          async ({ session }) => {
            refreshCalls += 1;
            await new Promise((resolve) => setTimeout(resolve, 100));
            const refreshed = JSON.parse(
              Buffer.from(session.bytes).toString("utf8"),
            ) as { last_refresh: string; tokens: { access_token: string } };
            refreshed.last_refresh = new Date().toISOString();
            refreshed.tokens.access_token = "refreshed-access";
            return {
              artifact: {
                ...session,
                bytes: Buffer.from(JSON.stringify(refreshed), "utf8"),
                updatedAt: new Date(),
              },
              providerState: "refreshed",
              warnings: [],
            };
          },
        );
      }
      active = 0;
      maximumActive = 0;
      entered = 0;
      const expiredAllEntered = new Promise<void>((resolve) => {
        release = resolve;
      });
      const expiredSafety = setTimeout(() => release?.(), 120_000);
      await Promise.all(
        grants.map(async (_grant, index) => {
          const session = await runtimes[index % 2]!.ensureFreshSession({
            accountId: "account-expired-concurrency",
            runId: `expired-real-runtime-${index}`,
            attempt: 1,
            abortSignal: AbortSignal.timeout(120_000),
          });
          expect(session.accessToken).toBe("refreshed-access");
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          entered += 1;
          if (entered === grants.length) release?.();
          await expiredAllEntered;
          active -= 1;
        }),
      );
      clearTimeout(expiredSafety);
      expect(refreshCalls).toBe(1);
      expect(maximumActive).toBe(52);
      expect(
        await prisma.hostedCodexCredentialVersion.count({
          where: { accountId: "account-expired-concurrency" },
        }),
      ).toBe(2);
      expect(
        (
          await prisma.hostedCodexMutationFence.findUniqueOrThrow({
            where: { accountId: "account-expired-concurrency" },
          })
        ).ownerIdHash,
      ).toBeNull();
    } finally {
      await replica.$disconnect();
    }
  }, 180_000);

  it("rejects enrolled identity drift without persisting plaintext", async () => {
    const secret = "identity-drift-refresh-token-sentinel";
    const bytes = validAuthJson("primary", "drift-access", secret);
    const enrollment = new PrismaHostedCredentialEnrollment(
      prisma,
      vault,
      databaseIncarnation,
      databaseResourceIdentity,
      Buffer.alloc(32, 29),
    );
    await expect(
      enrollment.importCodexAuth({
        workspaceId: workspace,
        poolId: pool,
        accountId: hostedAccountId("account-identity-drift"),
        label: "Identity drift",
        priority: 3,
        expectedPoolRevision: 4,
        authJsonBytes: bytes,
        now: new Date(),
      }),
    ).rejects.toThrow("hosted_account_subject_already_enrolled");
    expect(bytes.every((byte) => byte === 0)).toBe(true);
    const serialized = JSON.stringify(
      await prisma.hostedCodexCredentialVersion.findMany(),
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    );
    expect(serialized).not.toContain(secret);
  });

  it.each([401, 429])(
    "makes exactly two upstream calls for persistent %i, records one failover, and never attempts a third account",
    async (status) => {
      const issued = await issueGrant(`persistent-${status}`);
      const authorization = new PrismaHostedCodexRelayAuthorization(
        prisma,
        true,
      );
      const admitted = await authorization.authorize({
        opaqueGrant: issued.plaintextToken,
        requestOrdinal: 1,
        idempotencyKey: `persistent-${status}`,
        requestBytes: Buffer.byteLength('{"input":"classified"}'),
      });
      let upstreamCalls = 0;
      const relay = new FetchHostedCodexStreamingRelay(
        {
          ensureFreshSession: vi.fn(async ({ accountId }) => ({
            accessToken: `classified-${accountId}`,
            chatgptAccountId: `classified-${accountId}`,
            credentialGeneration: await activeCredentialGeneration(accountId),
          })),
          classifyFailure: vi.fn(() => ({ code: "unknown" })),
        } as unknown as HostedCodexSessionRuntime,
        ledger,
        vi.fn(async () => {
          upstreamCalls += 1;
          return new Response('{"error":"classified"}', { status });
        }) as typeof fetch,
        { failoverEnabled: true },
      );
      const response = await relay.open({
        authorization: admitted,
        body: Readable.from(Buffer.from('{"input":"classified"}')),
        contentType: "application/json",
        accept: "application/json",
        abortSignal: new AbortController().signal,
      });
      await readAll(response.body);
      const [grant, attempts] = await Promise.all([
        prisma.hostedCodexInvocationGrant.findUniqueOrThrow({
          where: { id: issued.grant.id },
        }),
        prisma.hostedCodexUpstreamEffectAttempt.findMany({
          where: { relayRequestId: admitted.requestId },
          orderBy: { attemptOrdinal: "asc" },
        }),
      ]);
      expect(upstreamCalls).toBe(2);
      expect(grant.failoverCount).toBe(1);
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toMatchObject({
        attemptOrdinal: 1,
        state: "failed_classified",
      });
      expect(attempts[1]).toMatchObject({
        attemptOrdinal: 2,
        state: "terminal_unknown",
      });
    },
  );

  it("replays witnessed restore after a committed-item crash and permit expiry, quarantines grants, reconciles full inventory, and promotes once", async () => {
    const sourceKey =
      "arn:aws:kms:us-east-1:123456789012:key/11111111-1111-4111-8111-111111111111";
    const targetKey =
      "arn:aws:kms:us-east-1:123456789012:key/22222222-2222-4222-8222-222222222222";
    const sourceIncarnation = "restored-source-incarnation-e2e";
    const targetIncarnation = "restored-target-incarnation-e2e";
    const targetResource = "restored-target-resource-e2e";
    const keys = {
      [sourceKey]: Buffer.alloc(32, 41).toString("base64"),
      [targetKey]: Buffer.alloc(32, 42).toString("base64"),
    };
    const sourceVault = new CredentialEnvelopeVault(
      new EnvCredentialKeyring({
        REVIEW_ROUTER_HOSTED_CODEX_KEK_CURRENT_ID: sourceKey,
        REVIEW_ROUTER_HOSTED_CODEX_KEK_KEYRING_JSON: JSON.stringify(keys),
      }),
      "relay",
    );
    const recoveryVault = new CredentialEnvelopeVault(
      new EnvCredentialKeyring({
        REVIEW_ROUTER_HOSTED_CODEX_KEK_CURRENT_ID: targetKey,
        REVIEW_ROUTER_HOSTED_CODEX_KEK_KEYRING_JSON: JSON.stringify(keys),
      }),
      "relay",
    );
    const activeCredentials = await prisma.hostedCodexAccount.findMany({
      where: { activeGeneration: { not: null }, state: { not: "tombstoned" } },
      include: {
        credentialVersions: {
          orderBy: { generation: "desc" },
          take: 1,
          include: {
            envelopeRevisions: { orderBy: { revision: "desc" }, take: 1 },
          },
        },
      },
    });
    for (const account of activeCredentials) {
      const credential = account.credentialVersions[0]!;
      const prior = credential.envelopeRevisions[0]!;
      const envelope = await sourceVault.encrypt(
        Buffer.from(`restore-${account.id}`),
        {
          workspaceId: account.workspaceId,
          poolId: account.poolId,
          accountId: account.id,
          generation: Number(credential.generation),
          databaseIncarnation: sourceIncarnation,
          databaseResourceIdentity: "restored-source-resource-e2e",
        },
      );
      await prisma.hostedCodexCredentialEnvelopeRevision.create({
        data: {
          id: `restore-source-${account.id}`,
          credentialVersionId: credential.id,
          accountId: account.id,
          workspaceId: account.workspaceId,
          poolId: account.poolId,
          generation: credential.generation,
          revision: prior.revision + 1n,
          sourceRevision: prior.revision,
          custodyMode: "aws_kms",
          kmsKeyArn: sourceKey,
          kmsContextVersion: 1,
          databaseResourceIdentity: "restored-source-resource-e2e",
          databaseIncarnation: sourceIncarnation,
          reason: "restore_reconciliation",
          envelopeVersion: 1,
          encryptionAlgorithm: "aes-256-gcm",
          aadHash: envelope.associatedDataHash,
          ciphertextHash: envelope.ciphertextHash,
          encryptedCiphertext: envelope.ciphertext,
          envelopeMetadata: {
            nonce: envelope.nonce,
            authenticationTag: envelope.authenticationTag,
            wrappedDataEncryptionKey: envelope.wrappedDataEncryptionKey,
          },
          actorIdHash: sha256(`restore-source-actor-${account.id}`),
          idempotencyKeyHash: sha256(
            `restore-source-idempotency-${account.id}`,
          ),
        },
      });
    }
    const outstanding = await issueGrant("restore-quarantine-grant");
    let restoreNow = new Date();
    const permit = {
      inventoryHash: "",
      databaseResourceIdentity: targetResource,
      sourceIncarnation,
      targetIncarnation,
      sourceKmsKeyArn: sourceKey,
      targetKmsKeyArn: targetKey,
      authorityKeyId: "restore-e2e-authority",
      actorId: "restore-e2e-operator",
      nonce: "restore-e2e-nonce-that-is-unique-and-long",
      expiresAt: new Date(restoreNow.getTime() + 60_000),
    };
    let crashOnce = true;
    const restore = new PrismaHostedCodexRestoreReconciler(
      prisma,
      recoveryVault,
      targetResource,
      targetIncarnation,
      {
        verify(input) {
          expect(input.token).toBe("witnessed-restore-token");
          return { ...permit, inventoryHash: input.inventoryHash };
        },
      },
      (phase) => {
        if (phase === "after_item_committed" && crashOnce) {
          crashOnce = false;
          throw new Error("simulated-restore-crash");
        }
      },
      () => restoreNow,
    );
    await expect(restore.assertRelayReady()).rejects.toThrow(
      "hosted_codex_external_database_witness_mismatch",
    );
    expect(
      await prisma.hostedCodexInvocationGrant.findUniqueOrThrow({
        where: { id: outstanding.grant.id },
      }),
    ).toMatchObject({ status: "revoked", inFlight: 0 });
    const competingRestore = new PrismaHostedCodexRestoreReconciler(
      prisma,
      recoveryVault,
      targetResource,
      targetIncarnation,
      {
        verify: (input) => ({
          ...permit,
          nonce: "restore-e2e-competing-nonce-that-is-unique",
          inventoryHash: input.inventoryHash,
        }),
      },
      undefined,
      () => restoreNow,
    );
    const [operationId, competingOperationId] = await Promise.all([
      restore.begin("witnessed-restore-token"),
      competingRestore.begin("competing-witnessed-restore-token"),
    ]);
    expect(competingOperationId).toBe(operationId);
    expect(await restore.begin("witnessed-restore-token")).toBe(operationId);
    expect(
      await prisma.hostedCodexRestoreOperation.count({
        where: {
          inventoryHash: (
            await prisma.hostedCodexRestoreOperation.findUniqueOrThrow({
              where: { id: operationId },
            })
          ).inventoryHash,
          databaseResourceIdentity: targetResource,
          targetIncarnation,
          state: { in: ["witnessed", "reconciling", "reconciled"] },
        },
      }),
    ).toBe(1);
    const witnessedOperation =
      await prisma.hostedCodexRestoreOperation.findUniqueOrThrow({
        where: { id: operationId },
        include: { items: { take: 1 } },
      });
    const witnessedItem = witnessedOperation.items[0]!;
    const adversarialOperationId = "restore-adversarial-failed";
    const adversarialItemId = "restore-adversarial-failed-item";
    await prisma.hostedCodexRestoreOperation.create({
      data: {
        id: adversarialOperationId,
        inventoryHash: sha256(
          `${witnessedOperation.inventoryHash}\0adversarial-failed`,
        ),
        databaseResourceIdentity: witnessedOperation.databaseResourceIdentity,
        sourceIncarnation: witnessedOperation.sourceIncarnation,
        targetIncarnation: witnessedOperation.targetIncarnation,
        sourceKmsKeyArn: witnessedOperation.sourceKmsKeyArn,
        targetKmsKeyArn: witnessedOperation.targetKmsKeyArn,
        authorityKeyId: witnessedOperation.authorityKeyId,
        actorIdHash: witnessedOperation.actorIdHash,
        nonceHash: sha256("adversarial-restore-nonce"),
        permitExpiresAt: witnessedOperation.permitExpiresAt,
        itemCount: 1,
        items: {
          create: {
            id: adversarialItemId,
            credentialVersionId: witnessedItem.credentialVersionId,
            accountId: witnessedItem.accountId,
            workspaceId: witnessedItem.workspaceId,
            poolId: witnessedItem.poolId,
            generation: witnessedItem.generation,
            sourceRevision: witnessedItem.sourceRevision,
            sourceAadHash: witnessedItem.sourceAadHash,
            sourceCiphertextHash: witnessedItem.sourceCiphertextHash,
          },
        },
      },
    });
    await prisma.hostedCodexRestoreItem.update({
      where: { id: adversarialItemId },
      data: { state: "failed", failureCode: "adversarial" },
    });
    await expect(
      prisma.hostedCodexRestoreItem.update({
        where: { id: adversarialItemId },
        data: { state: "pending" },
      }),
    ).rejects.toThrow(/hosted_codex_restore_item_transition_invalid/u);
    await prisma.hostedCodexRestoreOperation.update({
      where: { id: adversarialOperationId },
      data: { state: "reconciling", reconciliationStartedAt: new Date() },
    });
    await prisma.hostedCodexRestoreOperation.update({
      where: { id: adversarialOperationId },
      data: { state: "reconciled", reconciledAt: new Date() },
    });
    await expect(
      prisma.hostedCodexRestoreOperation.update({
        where: { id: adversarialOperationId },
        data: { state: "promoted", promotedAt: new Date() },
      }),
    ).rejects.toThrow(/hosted_codex_restore_promotion_inventory_incomplete/u);
    await prisma.hostedCodexRestoreOperation.update({
      where: { id: adversarialOperationId },
      data: {
        state: "failed",
        failedAt: new Date(),
        failureCode: "adversarial",
      },
    });
    await expect(
      prisma.hostedCodexRestoreOperation.update({
        where: { id: adversarialOperationId },
        data: { state: "reconciling" },
      }),
    ).rejects.toThrow(/hosted_codex_restore_operation_transition_invalid/u);
    await expect(restore.reconcile(operationId)).rejects.toThrow(
      "simulated-restore-crash",
    );
    restoreNow = new Date(permit.expiresAt.getTime() + 60_000);
    await expect(
      prisma.hostedCodexRestoreOperation.update({
        where: { id: operationId },
        data: {
          state: "failed",
          failedAt: new Date(),
          failureCode: "must-not-abandon-partial-inventory",
        },
      }),
    ).rejects.toThrow(/hosted_codex_restore_partial_operation_must_resume/u);
    const resumed = new PrismaHostedCodexRestoreReconciler(
      prisma,
      recoveryVault,
      targetResource,
      targetIncarnation,
      {
        verify: (input) => ({ ...permit, inventoryHash: input.inventoryHash }),
      },
      undefined,
      () => restoreNow,
    );
    await resumed.reconcile(operationId);
    const itemCount = await prisma.hostedCodexRestoreItem.count({
      where: { restoreOperationId: operationId, state: "rewrapped" },
    });
    expect(itemCount).toBe(activeCredentials.length);
    const rewrapped = await prisma.hostedCodexRestoreItem.findFirstOrThrow({
      where: { restoreOperationId: operationId, state: "rewrapped" },
    });
    await expect(
      prisma.hostedCodexRestoreItem.update({
        where: { id: rewrapped.id },
        data: { state: "pending" },
      }),
    ).rejects.toThrow(/hosted_codex_restore_item_transition_invalid/u);
    await expect(
      prisma.hostedCodexRestoreItem.update({
        where: { id: rewrapped.id },
        data: { state: "failed" },
      }),
    ).rejects.toThrow(/hosted_codex_restore_item_transition_invalid/u);
    expect(await resumed.promote(operationId)).toBe(activeCredentials.length);
    expect(await resumed.promote(operationId)).toBe(0);
    await expect(resumed.assertRelayReady()).resolves.toBeUndefined();
  }, 120_000);

  it("reconciles more than one expiry batch without starving later grants", async () => {
    const cutoff = new Date("2026-08-25T12:00:00.000Z");
    await insertIssuedGrantFixtures("expiry-many", 7, {
      issuedAt: new Date(cutoff.getTime() - 60_000),
      expiresAt: new Date(cutoff.getTime() - 1),
    });

    await expect(
      reconcileExpiredInvocationGrants(
        { now: cutoff, batchSize: 3, maxBatches: 4 },
        ledger,
      ),
    ).resolves.toEqual({ expiredCount: 7, batches: 3 });
    expect(
      await prisma.hostedCodexInvocationGrant.count({
        where: { id: { startsWith: "grant-expiry-many-" }, status: "expired" },
      }),
    ).toBe(7);
  });

  it("is idempotent and concurrency-safe across reconcilers", async () => {
    const cutoff = new Date("2026-08-25T12:05:00.000Z");
    await insertIssuedGrantFixtures("expiry-concurrent", 11, {
      issuedAt: new Date(cutoff.getTime() - 60_000),
      expiresAt: new Date(cutoff.getTime() - 1),
    });

    const results = await Promise.all([
      reconcileExpiredInvocationGrants(
        { now: cutoff, batchSize: 2, maxBatches: 10 },
        ledger,
      ),
      reconcileExpiredInvocationGrants(
        { now: cutoff, batchSize: 2, maxBatches: 10 },
        new PrismaInvocationGrantRepository(prisma),
      ),
    ]);

    expect(results.reduce((sum, result) => sum + result.expiredCount, 0)).toBe(
      11,
    );
    expect(
      await prisma.hostedCodexInvocationGrant.count({
        where: {
          id: { startsWith: "grant-expiry-concurrent-" },
          status: "expired",
        },
      }),
    ).toBe(11);
    await expect(
      reconcileExpiredInvocationGrants({ now: cutoff, batchSize: 2 }, ledger),
    ).resolves.toMatchObject({ expiredCount: 0 });
  });

  it("retains issued grants whose expiry is still active", async () => {
    const cutoff = new Date("2026-08-25T12:10:00.000Z");
    await insertIssuedGrantFixtures("expiry-active", 1, {
      issuedAt: new Date(cutoff.getTime() - 60_000),
      expiresAt: new Date(cutoff.getTime() + 1),
    });

    await reconcileExpiredInvocationGrants(
      { now: cutoff, batchSize: 1 },
      ledger,
    );

    await expect(
      prisma.hostedCodexInvocationGrant.findUniqueOrThrow({
        where: { id: "grant-expiry-active-0" },
        select: { status: true, revision: true },
      }),
    ).resolves.toEqual({ status: "issued", revision: 1n });
  });

  it("expires a grant at the exact expiresAt boundary", async () => {
    // Keep this before the still-issued +1ms fixture from the preceding probe
    // so the assertion isolates equality at this grant's own boundary.
    const cutoff = new Date("2026-08-25T12:09:00.000Z");
    await insertIssuedGrantFixtures("expiry-exact-boundary", 1, {
      issuedAt: new Date(cutoff.getTime() - 60_000),
      expiresAt: cutoff,
    });

    await expect(
      reconcileExpiredInvocationGrants(
        { now: cutoff, batchSize: 1, maxBatches: 2 },
        ledger,
      ),
    ).resolves.toEqual({ expiredCount: 1, batches: 2 });
    await expect(
      prisma.hostedCodexInvocationGrant.findUniqueOrThrow({
        where: { id: "grant-expiry-exact-boundary-0" },
        select: { status: true, revision: true, updatedAt: true },
      }),
    ).resolves.toEqual({
      status: "expired",
      revision: 2n,
      updatedAt: cutoff,
    });
  });
});

async function createElapsedTestRuntimeClosure(input: {
  id: string;
  gateRevision: bigint;
  closedAuthzEpoch: bigint;
  actorHash: string;
  reasonHash: string;
  legacyBarrier: true;
  legacyUnsafeUntil: Date;
}) {
  const closure = await prisma.hostedCodexRuntimeClosure.create({
    data: input,
  });
  return prisma.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(
      `SET LOCAL session_replication_role = 'replica'`,
    );
    return transaction.hostedCodexRuntimeClosure.update({
      where: { id: closure.id },
      data: { legacyBarrier: false, legacyUnsafeUntil: new Date(0) },
    });
  });
}

async function transitionRuntimeGate(
  status: "closed" | "active",
  reasonCode: string,
  callerChangedAt?: Date,
) {
  const current = await prisma.hostedCodexRuntimeGate.findUniqueOrThrow({
    where: { id: "global" },
  });
  if (status === "active" && current.status === "closed") {
    const closure = await prisma.hostedCodexRuntimeClosure.upsert({
      where: { gateRevision: current.revision },
      create: {
        id: `runtime-closure-${current.revision}`,
        gateRevision: current.revision,
        closedAuthzEpoch: current.authzEpoch,
        actorHash: sha256("postgres-e2e"),
        reasonHash: sha256(reasonCode),
        legacyBarrier: true,
        legacyUnsafeUntil: new Date(0),
      },
      update: {},
    });
    if (closure.state !== "complete") {
      if (closure.legacyBarrier || closure.legacyUnsafeUntil > new Date()) {
        // Test-only bootstrap of the migration quarantine. Runtime code cannot bypass this barrier.
        await prisma.$transaction(async (transaction) => {
          await transaction.$executeRawUnsafe(
            `SET LOCAL session_replication_role = 'replica'`,
          );
          await transaction.hostedCodexRuntimeClosure.update({
            where: { id: closure.id },
            data: {
              state: "complete",
              completedAt: new Date(),
              legacyBarrier: false,
              legacyUnsafeUntil: new Date(0),
              revision: { increment: 1 },
            },
          });
        });
      } else {
        await prisma.hostedCodexRuntimeClosure.update({
          where: { id: closure.id },
          data: {
            state: "complete",
            completedAt: new Date(),
            legacyBarrier: false,
            revision: { increment: 1 },
          },
        });
      }
    }
  }
  const changedAt =
    callerChangedAt ??
    new Date(Math.max(Date.now(), current.changedAt.getTime() + 1));
  const updated = await prisma.hostedCodexRuntimeGate.updateMany({
    where: { id: "global", revision: current.revision },
    data: {
      status,
      authzEpoch: { increment: 1 },
      revision: { increment: 1 },
      reasonCode,
      changedAt,
      changedByHash: sha256(reasonCode),
    },
  });
  if (updated.count !== 1)
    throw new Error("postgres_e2e_runtime_gate_transition_conflict");
  return prisma.hostedCodexRuntimeGate.findUniqueOrThrow({
    where: { id: "global" },
  });
}

async function restoreRuntimeGateActive(reasonCode: string) {
  const current = await prisma.hostedCodexRuntimeGate.findUniqueOrThrow({
    where: { id: "global" },
  });
  if (current.status !== "active")
    await transitionRuntimeGate("active", reasonCode);
  const restored = await prisma.hostedCodexRuntimeGate.findUniqueOrThrow({
    where: { id: "global" },
    select: { status: true },
  });
  if (restored.status !== "active")
    throw new Error("postgres_e2e_runtime_gate_restore_failed");
}

async function createDispatchingMint(label: string) {
  const issued = await issueGrant(`security-${label}`);
  const ledger = new PrismaHostedCommentTokenMintLedger(prisma);
  const mintId = `comment-mint-security-${label}`;
  const ownerIdHash = sha256(`owner:${label}`);
  const prepared = await ledger.prepare({
    mintId,
    purpose: "initial",
    logicalKeyHash: sha256(mintId),
    requestFingerprintHash: sha256(`fingerprint:${mintId}`),
    ownerIdHash,
    grantId: issued.grant.id,
    bindingId: binding,
    bindingVersion: 1,
    now: new Date(),
    leaseExpiresAt: new Date(Date.now() + 30_000),
  });
  if (prepared.state !== "prepared")
    throw new Error("postgres_e2e_security_prepare_failed");
  const dispatchNow = new Date();
  await ledger.authorizeDispatch({
    mintId,
    ownerIdHash,
    now: dispatchNow,
    dispatchAuthorizedUntil: new Date(dispatchNow.getTime() + 15_000),
    unsafeUntil: new Date(dispatchNow.getTime() + 61 * 60_000),
  });
  return {
    ledger,
    mintId,
    grantId: issued.grant.id,
    ownerIdHash,
    fenceEpoch: prepared.fenceEpoch,
  };
}

async function createIssuedMint(label: string) {
  const dispatched = await createDispatchingMint(label);
  const token = `security-token-${label}`;
  const tokenHash = sha256(token);
  const tokenExpiresAt = new Date(Date.now() + 30 * 60_000);
  await expect(
    dispatched.ledger.finalizeKnownToken({
      mintId: dispatched.mintId,
      ownerIdHash: dispatched.ownerIdHash,
      fenceEpoch: dispatched.fenceEpoch,
      tokenHash,
      tokenExpiresAt,
      secretEnvelope: testSecretEnvelope(token),
      now: new Date(),
    }),
  ).resolves.toBe("issued");
  return { ...dispatched, tokenHash, tokenExpiresAt };
}

const trustedRevocationReceipt = Object.freeze({
  authority: "github_token_delete" as const,
  result: "revoked" as const,
});

async function cleanupCommentTokenMintFixtures(input: {
  mintIds: readonly string[];
  grantIds: readonly string[];
  restoreRepository?: Readonly<{
    archived: boolean;
    selected: boolean;
    updatedAt: Date;
  }>;
}) {
  await prisma.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(
      `SET LOCAL session_replication_role = 'replica'`,
    );
    if (input.mintIds.length > 0) {
      await transaction.$executeRawUnsafe(
        `DELETE FROM public."HostedCodexCommentTokenRevocationProof"
         WHERE "mintId" = ANY($1::text[])`,
        [...input.mintIds],
      );
      await transaction.hostedCodexCommentRefreshUse.deleteMany({
        where: { mintId: { in: [...input.mintIds] } },
      });
      await transaction.hostedCodexCommentTokenMint.deleteMany({
        where: { id: { in: [...input.mintIds] } },
      });
    }
    if (input.grantIds.length > 0) {
      await transaction.hostedCodexCommentRefreshUse.deleteMany({
        where: { grantId: { in: [...input.grantIds] } },
      });
      await transaction.hostedCodexCommentRefreshCapability.deleteMany({
        where: { grantId: { in: [...input.grantIds] } },
      });
      await transaction.hostedCodexInvocationGrant.deleteMany({
        where: { id: { in: [...input.grantIds] } },
      });
    }
    if (input.restoreRepository) {
      await transaction.repositoryConnection.update({
        where: { id: repository },
        data: input.restoreRepository,
      });
    }
  });
}

async function adjustInvocationGrantFixture(
  grantId: string,
  field: "authzEpoch" | "bindingRevision",
  delta: 1 | -1,
) {
  await prisma.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(
      `SET LOCAL session_replication_role = 'replica'`,
    );
    await transaction.hostedCodexInvocationGrant.update({
      where: { id: grantId },
      data:
        field === "authzEpoch"
          ? { authzEpoch: { increment: delta } }
          : { bindingRevision: { increment: delta } },
    });
  });
}

async function finalizeTrustedRevocation(
  ledger: PrismaHostedCommentTokenMintLedger,
  mintId: string,
  tokenHash: string,
  evidence: string,
) {
  const claimNow = new Date(Date.now() + 1);
  const claims = await ledger.claimRevocations({
    ownerIdHash: sha256(`trusted-revoker:${mintId}:${evidence}`),
    now: claimNow,
    leaseExpiresAt: new Date(claimNow.getTime() + 30_000),
    limit: 1,
  });
  const claim = claims.find((candidate) => candidate.mintId === mintId);
  if (!claim) throw new Error("trusted_revocation_claim_missing");
  await ledger.finalizeRevoked({
    mintId,
    tokenHash,
    ownerIdHash: claim.ownerIdHash,
    fenceEpoch: claim.fenceEpoch,
    now: new Date(),
    evidenceHash: sha256(evidence),
    receipt: trustedRevocationReceipt,
  });
}

async function forceTerminalNoToken(mintId: string) {
  await prisma.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(
      `SET LOCAL session_replication_role = 'replica'`,
    );
    await transaction.hostedCodexCommentTokenMint.update({
      where: { id: mintId },
      data: {
        state: "failed_no_token",
        completedAt: new Date(),
        terminalEvidenceHash: sha256(`forced-terminal:${mintId}`),
        revision: { increment: 1 },
      },
    });
  });
}

function zeroTestEnvelope(envelope: {
  ciphertext: Uint8Array;
  encryptedDataKey: Uint8Array;
  iv: Uint8Array;
  authTag: Uint8Array;
}) {
  envelope.ciphertext.fill(0);
  envelope.encryptedDataKey.fill(0);
  envelope.iv.fill(0);
  envelope.authTag.fill(0);
}

async function issueGrant(
  suffix: string,
  budget: Partial<{
    maxRequests: number;
    maxConcurrentRequests: number;
    maxRequestBytes: number;
    maxResponseBytes: number;
    maxOutputTokens: number;
  }> = {},
  options: Readonly<{
    commentRefreshMaxUses?: number;
    repositoryId?: ReturnType<typeof repositoryId>;
    bindingId?: ReturnType<typeof hostedBindingId>;
  }> = {},
) {
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  const runtimeGate = await prisma.hostedCodexRuntimeGate.findUniqueOrThrow({
    where: { id: "global" },
    select: { status: true, authzEpoch: true },
  });
  if (runtimeGate.status !== "active")
    throw new Error("postgres_e2e_runtime_gate_not_active");
  return issueHostedPoolInvocationGrant(
    {
      id: invocationGrantId(`grant-${suffix}`),
      invocationId: invocationId(`invocation-${suffix}`),
      repositoryId: options.repositoryId ?? repository,
      workspaceId: workspace,
      authority: {
        repositoryBindingId: options.bindingId ?? binding,
        reviewRequestId: `review-${suffix}`,
        providerInvocationKey: `provider-${suffix}`,
        runId: `run-${suffix}`,
        runAttempt: 1,
        model: "gpt-5.5",
        policyFingerprint: sha256("policy-e2e"),
        runtimeConfigVersion: 1,
        bindingRevision: 1,
        authzEpoch: 1n,
      },
      runtimeAuthzEpoch: runtimeGate.authzEpoch,
      budget: {
        expiresAt,
        maxRequests: budget.maxRequests ?? 4,
        maxConcurrentRequests: budget.maxConcurrentRequests ?? 2,
        maxRequestBytes: budget.maxRequestBytes ?? 16_384,
        maxResponseBytes: budget.maxResponseBytes ?? 65_536,
        maxOutputTokens: budget.maxOutputTokens ?? 4_096,
      },
      commentRefreshBudget: {
        expiresAt,
        maxUses: options.commentRefreshMaxUses ?? 2,
      },
      now: new Date(),
    },
    {
      pools: new PrismaHostedPoolRepository(prisma),
      bindings: new PrismaHostedPoolBindingRepository(prisma),
      accounts: new PrismaHostedAccountRepository(prisma),
      grants: ledger,
      capabilities: grantCapabilities,
      commentRefreshCapabilities: ledger,
    },
  );
}

async function insertIssuedGrantFixtures(
  prefix: string,
  count: number,
  dates: Readonly<{ issuedAt: Date; expiresAt: Date }>,
) {
  const runtimeGate = await prisma.hostedCodexRuntimeGate.findUniqueOrThrow({
    where: { id: "global" },
    select: { status: true, authzEpoch: true },
  });
  if (runtimeGate.status !== "active")
    throw new Error("postgres_e2e_runtime_gate_not_active");
  await prisma.hostedCodexInvocationGrant.createMany({
    data: Array.from({ length: count }, (_, index) => ({
      id: `grant-${prefix}-${index}`,
      invocationId: `invocation-${prefix}-${index}`,
      workspaceId: workspace,
      poolId: pool,
      repositoryConnectionId: repository,
      repositoryBindingId: binding,
      activeAccountId: "account-primary",
      primaryAccountId: "account-primary",
      backupAccountId: "account-backup",
      reviewRequestId: `review-${prefix}-${index}`,
      providerInvocationKey: `provider-${prefix}-${index}`,
      runId: `run-${prefix}-${index}`,
      runAttempt: 1,
      model: "gpt-5.5",
      policyVersion: "hosted-codex-v1",
      policyFingerprint: sha256(`policy-${prefix}-${index}`),
      runtimeConfigVersion: 1,
      bindingRevision: 1n,
      authzEpoch: 1n,
      runtimeAuthzEpoch: runtimeGate.authzEpoch,
      capabilityTokenHash: sha256(`capability-${prefix}-${index}`),
      issuedAt: dates.issuedAt,
      expiresAt: dates.expiresAt,
      maxRequests: 1,
      maxConcurrentRequests: 1,
      maxRequestBytes: 1_024,
      maxResponseBytes: 1_024,
      maxOutputTokens: 256,
    })),
  });
}

async function requestGrant(
  origin: string,
  suffix: string,
  readIssueError: () => unknown,
) {
  const response = await fetch(`${origin}${hostedCodexGrantPath}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      oidcToken: "synthetic-oidc-token-that-is-long-enough",
      providerInstanceId: suffix,
      workflowSchemaVersion: 5,
      bindingId: binding,
      bindingVersion: 1,
    }),
  });
  if (response.status !== 200) {
    throw new Error(`grant route failed: ${String(readIssueError())}`);
  }
  return (await response.json()) as {
    readonly grant: string;
    readonly invocationLeaseId: string;
    readonly commentTokenRefreshCapability: string;
  };
}

function deterministicCapability(
  namespace: string,
): InvocationGrantCapabilityPort {
  return {
    issue: async (scope) => {
      const plaintextToken = createHash("sha256")
        .update(
          `${namespace}\0${scope.grantId}\0${scope.invocationId}\0${scope.repositoryBindingId}\0${scope.expiresAt.toISOString()}`,
        )
        .digest("base64url");
      return { plaintextToken, tokenHash: sha256(plaintextToken) };
    },
  };
}

function validAuthJson(
  subject: string,
  accessToken: string,
  refreshToken: string,
  lastRefresh = now,
) {
  const claims = Buffer.from(
    JSON.stringify({
      iss: "https://auth.openai.com",
      sub: subject,
      "https://api.openai.com/auth": {
        chatgpt_account_id: `chatgpt-${subject}`,
      },
    }),
  ).toString("base64url");
  return Buffer.from(
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: accessToken,
        refresh_token: refreshToken,
        id_token: `e30.${claims}.signature`,
      },
      last_refresh: lastRefresh.toISOString(),
    }),
  );
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function testSecretEnvelope(token: string) {
  return {
    ciphertext: Buffer.from(token),
    encryptedDataKey: Buffer.from("test-key"),
    iv: Buffer.from("test-iv"),
    authTag: Buffer.from("test-tag"),
    keyId: "test-key",
    aadHash: "a".repeat(64),
  };
}

async function activeCredentialGeneration(accountId: string): Promise<number> {
  const account = await prisma.hostedCodexAccount.findUniqueOrThrow({
    where: { id: accountId },
    select: { activeGeneration: true },
  });
  if (account.activeGeneration === null) {
    throw new Error("hosted_codex_active_generation_missing");
  }
  const generation = Number(account.activeGeneration);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("hosted_codex_active_generation_invalid");
  }
  return generation;
}

async function readAll(stream: Readable): Promise<void> {
  for await (const chunk of stream) {
    // Consumption is the assertion boundary; bytes are intentionally ignored.
    if (chunk === undefined)
      throw new Error("hosted_codex_stream_chunk_invalid");
  }
}

function errorStack(error: unknown) {
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}
