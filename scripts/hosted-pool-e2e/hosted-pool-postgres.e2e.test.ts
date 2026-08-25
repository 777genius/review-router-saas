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

const databaseUrl = process.env.REVIEW_ROUTER_HOSTED_POOL_E2E_DATABASE_URL;
if (!databaseUrl) throw new Error("hosted_pool_e2e_database_url_required");
const parsedDatabaseUrl = new URL(databaseUrl);
if (
  !["127.0.0.1", "localhost"].includes(parsedDatabaseUrl.hostname) ||
  !parsedDatabaseUrl.pathname.startsWith("/reviewrouter_hosted_pool_e2e_")
) {
  throw new Error("hosted_pool_e2e_database_must_be_disposable_loopback");
}

const prisma = createPrismaClient({ databaseUrl, poolMax: 12 });
const now = new Date();
const workspace = workspaceId("workspace-e2e");
const pool = hostedPoolId("pool-e2e");
const repository = repositoryId("repository-e2e");
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
  await prisma.workspace.create({
    data: { id: workspace, slug: "hosted-pool-e2e", name: "Hosted pool E2E" },
  });
  await prisma.gitHubInstallation.create({
    data: {
      id: "installation-e2e",
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
      installationId: "installation-e2e",
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
}, 120_000);

describe("hosted pool production adapters on disposable PostgreSQL 17", () => {
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
      commentTokens: { issueCommentToken: commentTokenCalls },
      clock: { now: () => new Date() },
      grants: ledger,
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
    expect(commentReplay.status).not.toBe(200);
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
    const issued = await issueGrant("long-response-heartbeat");
    const authorization = new PrismaHostedCodexRelayAuthorization(prisma);
    const admitted = await authorization.authorize({
      opaqueGrant: issued.plaintextToken,
      requestOrdinal: 1,
      idempotencyKey: "long-response-heartbeat",
      requestBytes: Buffer.byteLength('{"input":"long"}'),
    });
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (chunks === 3) {
          controller.close();
          return;
        }
        clock = new Date(clock.getTime() + 20_000);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(await effects.sweepExpired()).toBe(0);
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
    await readAll(response.body);
    expect(chunks).toBe(3);
    expect(
      await prisma.hostedCodexRelayRequest.findUniqueOrThrow({
        where: { id: admitted.requestId },
      }),
    ).toMatchObject({ status: "succeeded" });
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

  it("releases an expired prepared request and resumes the same exhausted idempotency identity", async () => {
    let clock = new Date();
    const effects = new PrismaHostedCodexUpstreamEffectLedger(
      prisma,
      () => clock,
    );
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
    await effects.prepare({
      relayRequestId: admitted.requestId,
      grantId: issued.grant.id,
      workspaceId: workspace,
      poolId: pool,
      accountId: "account-primary",
      credentialGeneration: await activeCredentialGeneration("account-primary"),
      requestHash,
      leaseMs: 5_000,
    });
    clock = new Date(clock.getTime() + 5_001);
    expect(await effects.sweepExpired()).toBe(1);
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
});

async function issueGrant(
  suffix: string,
  budget: Partial<{
    maxRequests: number;
    maxConcurrentRequests: number;
    maxRequestBytes: number;
    maxResponseBytes: number;
    maxOutputTokens: number;
  }> = {},
) {
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  return issueHostedPoolInvocationGrant(
    {
      id: invocationGrantId(`grant-${suffix}`),
      invocationId: invocationId(`invocation-${suffix}`),
      repositoryId: repository,
      workspaceId: workspace,
      authority: {
        repositoryBindingId: binding,
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
        maxUses: 2,
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
