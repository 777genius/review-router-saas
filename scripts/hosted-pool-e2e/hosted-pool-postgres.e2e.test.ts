import { createHash } from "node:crypto";
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
  relayRequestId,
  repositoryId,
  workspaceId,
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
});

afterAll(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await prisma.$disconnect();
});

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
    const parallelSafetyTimer = setTimeout(() => releaseParallel?.(), 15_000);
    const runtime = {
      ensureFreshSession: vi.fn(async () => ({
        accessToken: "fake-provider-access-token",
        chatgptAccountId: "fake-chatgpt-account",
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
  });

  it("uses a real mutation fence for stale-session handoff and rejects stale generation CAS", async () => {
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
      ttlMs: 30_000,
      restoredGenerationHash: restored!.generationHash,
    });
    expect(acquired.status).toBe("granted");
    const blocked = await fences.acquire({
      accountId: "account-primary",
      runId: "refresh-b",
      attempt: 1,
      ttlMs: 30_000,
      restoredGenerationHash: restored!.generationHash,
    });
    expect(blocked.status).toBe("denied");
    if (acquired.status !== "granted") throw new Error("fence_not_granted");

    const accepted = await store.write({
      providerInstanceId: "account-primary",
      expectedGeneration: 1,
      nextArtifact: restored!.artifact,
      idempotencyKey: "refresh-write-a",
      leaseId: acquired.leaseId,
    });
    expect(accepted.status).toBe("accepted");
    const stale = await store.write({
      providerInstanceId: "account-primary",
      expectedGeneration: 1,
      nextArtifact: restored!.artifact,
      idempotencyKey: "refresh-write-stale",
      leaseId: acquired.leaseId,
    });
    expect(stale.status).toBe("stale_generation");
    await fences.release({ leaseId: acquired.leaseId, reason: "e2e-complete" });
    const released = await prisma.hostedCodexMutationFence.findUniqueOrThrow({
      where: { accountId: "account-primary" },
    });
    expect(released.ownerIdHash).toBeNull();
    expect(released.fenceEpoch).toBeGreaterThanOrEqual(1n);
    const current = await store.read({ providerInstanceId: "account-primary" });
    const successor = await fences.acquire({
      accountId: "account-primary",
      runId: "refresh-successor-after-process-restart",
      attempt: 1,
      ttlMs: 30_000,
      restoredGenerationHash: current!.generationHash,
    });
    expect(successor.status).toBe("granted");
    if (successor.status !== "granted")
      throw new Error("successor_fence_denied");
    expect(
      (
        await prisma.hostedCodexMutationFence.findUniqueOrThrow({
          where: { accountId: "account-primary" },
        })
      ).fenceEpoch,
    ).toBe(released.fenceEpoch + 1n);
    await expect(
      store.write({
        providerInstanceId: "account-primary",
        expectedGeneration: current!.generation,
        nextArtifact: current!.artifact,
        idempotencyKey: "stale-owner-after-successor",
        leaseId: acquired.leaseId,
      }),
    ).rejects.toThrow("hosted_codex_mutation_fence_invalid");
    await expect(
      fences.release({ leaseId: acquired.leaseId, reason: "stale-release" }),
    ).rejects.toThrow("hosted_codex_mutation_fence_invalid");
    expect(
      (
        await prisma.hostedCodexMutationFence.findUniqueOrThrow({
          where: { accountId: "account-primary" },
        })
      ).ownerIdHash,
    ).not.toBeNull();
    await fences.release({
      leaseId: successor.leaseId,
      reason: "successor-complete",
    });
    const finalFence = await prisma.hostedCodexMutationFence.findUniqueOrThrow({
      where: { accountId: "account-primary" },
    });
    expect(finalFence.ownerIdHash).toBeNull();
    expect(finalFence.fenceEpoch).toBe(released.fenceEpoch + 1n);
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
        prepare: () =>
          effects.prepare({
            relayRequestId: admitted.requestId,
            grantId: issued.grant.id,
            workspaceId: workspace,
            poolId: pool,
            accountId: "account-primary",
            requestHash,
            leaseMs: 5_000,
          }),
      };
    };

    const beforeSend = await prepareRequest("before-send");
    const firstPrepared = await beforeSend.prepare();
    clock = new Date(clock.getTime() + 5_001);
    expect(await effects.sweepExpired()).toBe(1);
    expect(
      await prisma.hostedCodexUpstreamEffectAttempt.findUniqueOrThrow({
        where: { id: firstPrepared.attemptId },
      }),
    ).toMatchObject({ state: "failed_no_effect", attemptOrdinal: 1 });
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
      const safety = setTimeout(() => release?.(), 10_000);
      await Promise.all(
        grants.map(async (grant, index) => {
          const session = await runtimes[index % 2]!.ensureFreshSession({
            accountId: grant.grant.activeAccountId,
            runId: `real-runtime-${index}`,
            attempt: 1,
            abortSignal: AbortSignal.timeout(15_000),
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
      const expiredSafety = setTimeout(() => release?.(), 45_000);
      await Promise.all(
        grants.map(async (_grant, index) => {
          const session = await runtimes[index % 2]!.ensureFreshSession({
            accountId: "account-expired-concurrency",
            runId: `expired-real-runtime-${index}`,
            attempt: 1,
            abortSignal: AbortSignal.timeout(45_000),
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
  }, 60_000);

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
});

async function issueGrant(suffix: string) {
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
        maxRequests: 4,
        maxConcurrentRequests: 2,
        maxRequestBytes: 16_384,
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

function errorStack(error: unknown) {
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}
