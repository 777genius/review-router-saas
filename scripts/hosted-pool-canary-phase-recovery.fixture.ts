import { createHash } from "node:crypto";
import { expect, vi } from "vitest";
import {
  enrollHostedPoolAccount,
  resumeHostedAccount,
  type HostedPoolAccount,
} from "../packages/features/hosted-account-pool/src/domain/account-pool";
import {
  admitRelayRequest,
  failoverCurrentRelayRequest,
  issueInvocationGrant,
} from "../packages/features/hosted-account-pool/src/domain/invocation-grant";
import {
  hostedAccountId,
  hostedBindingId,
  hostedPoolId,
  invocationGrantId,
  invocationId,
  relayRequestId,
  repositoryId,
  workspaceId,
} from "../packages/features/hosted-account-pool/src/domain/identifiers";
import {
  createPrismaCanaryPhaseRecovery,
  type CanaryPhaseScope,
} from "./hosted-pool-canary-phase-recovery";
import type { CanaryRunEvidence } from "./hosted-pool-production-ports";

export const phaseHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** Stateful test storage. Selection, admission and failure disposition use the
 * real domain; the production recovery adapter performs every restoration.
 * Only DB I/O and successful disposable provider/publication effects are modeled.
 */
export function canaryPhaseFixture(options: { refreshBackup?: boolean } = {}) {
  let time = Date.parse("2026-09-05T12:00:00.000Z");
  const now = () => new Date(time);
  let accounts = ["account-a", "account-b"].map((id, priority) =>
    enrollHostedPoolAccount({
      id: hostedAccountId(id),
      poolId: hostedPoolId("pool-canary"),
      label: id,
      priority,
      credential: {
        credentialRef: `fixture:${id}`,
        subjectFingerprint: id,
        authGeneration: 1,
        validatedAt: now(),
        expiresAt: new Date(time + 86_400_000),
      },
      now: now(),
    }),
  );
  let events: any[] = [];
  const grants: any[] = [];
  const observations = new Map<number, CanaryRunEvidence>();
  const sources = new Map<string, any>();
  let restoreCount = 0;
  let responseLost = false;
  let receiptFailure = false;
  let casFailure = false;
  let restoreItems = 0;
  let uncertainEffects = 0;
  const scopes = new Map<number, CanaryPhaseScope>();
  const binding = {
    id: "binding-canary",
    workspaceId: "workspace-canary",
    revision: 1n,
    stateVersion: 1n,
    status: "active",
    attestedBindingRevision: 1n,
    attestedGithubRepositoryId: 123456789n,
    workflowActionRef: `777genius/review-router@${"a".repeat(40)}`,
    workflowPath: ".github/workflows/reviewrouter-codex.yml",
    pool: {
      status: "active",
      revision: 1n,
      authzEpoch: 1n,
      drainingAt: null,
      tombstonedAt: null,
    },
  };
  // Metadata projection of the real persisted version/envelope/activation
  // contract. PostgreSQL coverage generates refresh rows through production CAS.
  const credentialRows: any[] = accounts.map((a) => ({
    id: `credential-${a.id}-1`,
    accountId: a.id,
    generation: 1n,
    credentialExpiresAt: a.credential.expiresAt,
    databaseIncarnation: "disposable-incarnation",
    envelopeRevisions: [],
    generationReceipts: [
      {
        receiptHash: phaseHash(`enrolled-${a.id}`),
        mutationFenceEpoch: 1n,
        previousReceiptHash: phaseHash(`created-${a.id}`),
        actorIdHash: phaseHash(a.id),
        occurredAt: now(),
      },
    ],
  }));
  const credentialMetadata = (row: any) => {
    const metadata = { ...row };
    delete metadata.accountId;
    return metadata;
  };
  const refreshBackup = (accountId: string, at: Date) => {
    const index = accounts.findIndex((a) => a.id === accountId);
    const before = accounts[index]!;
    const previous = credentialRows
      .filter((v) => v.accountId === accountId)
      .at(-1)!;
    const generation = previous.generation + 1n;
    const epoch =
      previous.generation === 1n
        ? 1n
        : previous.generationReceipts[0].mutationFenceEpoch + 1n;
    const actorIdHash = phaseHash(`refresh-owner-${accountId}-${generation}`);
    const receiptHash = phaseHash(`writeback-${accountId}-${generation}`);
    credentialRows.push({
      id: `credential-${accountId}-${generation}`,
      accountId,
      generation,
      credentialExpiresAt: null,
      databaseIncarnation: previous.databaseIncarnation,
      envelopeRevisions: [
        {
          id: `envelope-${accountId}-${generation}`,
          databaseIncarnation: previous.databaseIncarnation,
          revision: 1n,
          reason: "refresh",
          fenceEpoch: epoch,
          fenceOwnerIdHash: actorIdHash,
          actorIdHash,
          idempotencyKeyHash: phaseHash(
            `refresh\0${accountId}\0${generation}\0${receiptHash}`,
          ),
          createdAt: at,
        },
      ],
      generationReceipts: [
        {
          receiptHash,
          previousReceiptHash: previous.generationReceipts[0].receiptHash,
          mutationFenceEpoch: epoch,
          actorIdHash,
          occurredAt: at,
        },
      ],
    });
    accounts[index] = {
      ...before,
      credential: {
        ...before.credential,
        authGeneration: Number(generation),
        expiresAt: null,
      },
      healthVersion: before.healthVersion + 1,
    };
  };
  const accountRow = (a: HostedPoolAccount) => ({
    id: a.id,
    state: a.availability.status,
    healthVersion: BigInt(a.healthVersion),
    activeGeneration: BigInt(a.credential.authGeneration),
    cooldownUntil:
      a.availability.status === "cooldown" ? a.availability.until : null,
    drainingAt: null,
    tombstonedAt: null,
    credentialVersions: [
      {
        ...credentialMetadata(
          credentialRows.filter((v) => v.accountId === a.id).at(-1)!,
        ),
        generation: BigInt(a.credential.authGeneration),
        credentialExpiresAt: a.credential.expiresAt,
      },
    ],
  });
  const matchesEvent = (event: any, where: any) =>
    Object.entries(where).every(([key, value]: [string, any]) => {
      if (key === "metadata")
        return event.metadata[value.path[0]] === value.equals;
      return value && typeof value === "object" && "in" in value
        ? value.in.includes(event[key])
        : event[key] === value;
    });
  const tx: any = {
    hostedCodexCredentialVersion: {
      findMany: async ({ where }: any) =>
        structuredClone(
          credentialRows
            .filter(
              (v) =>
                v.accountId === where.accountId &&
                v.generation > where.generation.gt &&
                v.generation <= where.generation.lte,
            )
            .map(credentialMetadata),
        ),
    },
    hostedCodexRepositoryBinding: {
      findMany: async () => [
        {
          ...binding,
          pool: { ...binding.pool, accounts: accounts.map(accountRow) },
        },
      ],
    },
    hostedCodexAccount: {
      findUnique: async ({ where }: any) =>
        accountRow(accounts.find((a) => a.id === where.id)!),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const account = accounts.find((a) => a.id === where.id)!;
        if (
          casFailure ||
          account.healthVersion !== Number(where.healthVersion) ||
          account.credential.authGeneration !==
            Number(where.activeGeneration) ||
          account.availability.status !== where.state
        )
          return { count: 0 };
        expect(data).toEqual({
          state: "healthy",
          cooldownUntil: null,
          healthVersion: { increment: 1 },
        });
        accounts = accounts.map((a) =>
          a.id === account.id ? resumeHostedAccount(a, now()) : a,
        );
        restoreCount++;
        return { count: 1 };
      }),
    },
    hostedCodexRestoreItem: { count: async () => restoreItems },
    hostedCodexRelayRequest: { count: async () => 0 },
    hostedCodexUpstreamEffectAttempt: { count: async () => uncertainEffects },
    hostedCodexInvocationGrant: {
      count: async ({ where }: any) =>
        grants.filter(
          (g) => g.runId === where.runId && g.runAttempt === where.runAttempt,
        ).length,
      findMany: async ({ where }: any) =>
        structuredClone(
          grants.filter(
            (g) => g.runId === where.runId && g.runAttempt === where.runAttempt,
          ),
        ),
    },
    reviewRequestedIntent: {
      findUnique: async ({ where }: any) => sources.get(where.requestId),
    },
    auditEvent: {
      findUnique: async ({ where }: any) =>
        structuredClone(events.find((e) => e.id === where.id) ?? null),
      findMany: async ({ where }: any) =>
        structuredClone(events.filter((e) => matchesEvent(e, where))),
      create: async ({ data }: any) => {
        if (receiptFailure && data.action.endsWith("phase_reconciled"))
          throw new Error("receipt_insert_failed");
        if (events.some((e) => e.id === data.id))
          throw new Error("unique_violation");
        const row = structuredClone({
          ...data,
          id: data.id ?? `event-${events.length}`,
          createdAt: now(),
        });
        events.push(row);
        return row;
      },
    },
  };
  const prisma: any = {
    ...tx,
    $transaction: vi.fn(async (fn: any, options: any) => {
      expect(options.isolationLevel).toBe("Serializable");
      const prior = structuredClone({ accounts, events, restoreCount });
      let result;
      try {
        result = await fn(tx);
      } catch (error) {
        accounts = prior.accounts;
        events = prior.events;
        restoreCount = prior.restoreCount;
        throw error;
      }
      if (responseLost && restoreCount > prior.restoreCount) {
        responseLost = false;
        throw new Error("commit_response_lost");
      }
      return result;
    }),
  };
  const recovery = createPrismaCanaryPhaseRecovery(prisma, now);
  const scopeFor = (phase: CanaryPhaseScope["phase"]): CanaryPhaseScope => ({
    phase,
    planIdHash: phaseHash(phase),
    runId: { unauthorized: 13, rate_limited: 14, dropped_response: 15 }[phase],
    repositoryId: 123456789,
    repositoryBindingId: "binding-canary",
    bindingRevision: "1",
    actionSha: "a".repeat(40),
    poolId: "pool-canary",
    accountIds: ["account-a", "account-b"],
  });
  const prepare = async (scope: CanaryPhaseScope) => {
    await recovery.prepareCanaryPhase(scope);
    scopes.set(scope.runId, scope);
  };
  const stage = async (scope: CanaryPhaseScope) =>
    tx.auditEvent.create({
      data: {
        workspaceId: "workspace-canary",
        actor: "operator:fixture",
        action: "hosted_codex_canary_fault_plan_staged",
        targetType: "hosted_codex_canary_fault_plan",
        targetId: scope.planIdHash,
        metadata: {},
      },
    });
  const run = (runId: number, phase?: CanaryPhaseScope["phase"]) => {
    if (observations.has(runId)) throw new Error("duplicate_dispatch");
    const base = time;
    const at = (ms: number) => new Date(base + ms);
    const id = invocationGrantId(`grant-${runId}`);
    const invocation = invocationId(`inv-${runId}`);
    const bindingId = hostedBindingId(binding.id);
    let grant = issueInvocationGrant({
      id,
      invocationId: invocation,
      workspaceId: workspaceId(binding.workspaceId),
      repositoryId: repositoryId("repository-canary"),
      poolId: hostedPoolId("pool-canary"),
      accounts,
      authority: {
        repositoryBindingId: bindingId,
        reviewRequestId: `review-${runId}`,
        providerInvocationKey: phaseHash(`provider-${runId}`),
        runId: String(runId),
        runAttempt: 2,
        model: "gpt-5.6",
        policyFingerprint: "sha256:fixture-policy",
        runtimeConfigVersion: 1,
        bindingRevision: 1,
        authzEpoch: 1n,
      },
      runtimeAuthzEpoch: 1n,
      capabilityTokenHash: phaseHash(`grant-${runId}`),
      commentTokenRefreshCapability: {
        grantId: id,
        invocationId: invocation,
        repositoryBindingId: bindingId,
        tokenHash: phaseHash(`refresh-${runId}`),
        expiresAt: at(1_800_000),
        maxUses: 1,
        useCount: 0,
        revokedAt: null,
      },
      budget: {
        expiresAt: at(1_800_000),
        maxRequests: 1,
        maxConcurrentRequests: 1,
        maxRequestBytes: 1024,
        maxResponseBytes: 4096,
        maxOutputTokens: 1024,
      },
      now: at(1),
    });
    const requestId = relayRequestId(`request-${runId}`);
    const admitted = admitRelayRequest({
      grant,
      requestId,
      authority: grant.authority,
      requestBytes: 10,
      now: at(2),
    });
    if (admitted.status !== "admitted") throw new Error(admitted.status);
    grant = admitted.grant;
    const failed = phase === "unauthorized" || phase === "rate_limited";
    const dropped = phase === "dropped_response";
    const consumption = phase
      ? {
          planIdHash: scopes.get(runId)!.planIdHash,
          authorityKeyId: "fixture-key",
          repositoryId: "123456789",
          runId: String(runId),
          runAttempt: 2,
          actionRef: binding.workflowActionRef,
          bindingId: binding.id,
          bindingRevision: "1",
          phase: {
            unauthorized: "synthetic_unauthorized",
            rate_limited: "synthetic_rate_limited",
            dropped_response: "drop_after_response_started",
          }[phase],
          requestOrdinal: 1,
          attemptOrdinal: 1,
          injectionPoint: dropped
            ? "after_response_started"
            : "before_provider_fetch",
          expiresAt: at(1_800_000).toISOString(),
        }
      : null;
    if (consumption)
      events.push({
        id: `consumed-${runId}`,
        workspaceId: binding.workspaceId,
        actor: "operator:authenticated-fixture",
        action: "hosted_codex_canary_fault_plan_consumed",
        targetType: "hosted_codex_canary_fault_plan",
        targetId: consumption.planIdHash,
        metadata: consumption,
        createdAt: at(4),
      });
    if (failed) {
      const result = failoverCurrentRelayRequest({
        grant,
        requestId,
        failedAccount: accounts.find((a) => a.id === grant.activeAccountId)!,
        backupAccount:
          accounts.find((a) => a.id === grant.backupAccountId) ?? null,
        failure:
          phase === "unauthorized" ? "credential_invalid" : "rate_limited",
        effectFence: "before_refresh_or_upstream_effect",
        cooldownUntil: phase === "rate_limited" ? at(900_004) : null,
        now: at(5),
      });
      if (result.status !== "switched") throw new Error(result.reason);
      grant = result.grant;
      accounts = accounts.map((a) =>
        a.id === result.failedAccount.id ? result.failedAccount : a,
      );
    }
    if (failed && options.refreshBackup)
      refreshBackup(grant.activeAccountId, at(5));
    const effect = (
      ordinal: number,
      accountId: string,
      synthetic: boolean,
    ) => ({
      id: `attempt-${runId}-${ordinal}`,
      grantId: id,
      relayRequestId: requestId,
      accountId,
      credentialGeneration: BigInt(
        accounts.find((a) => a.id === accountId)!.credential.authGeneration,
      ),
      attemptOrdinal: ordinal,
      fenceEpoch: BigInt(ordinal),
      state: synthetic
        ? "failed_no_effect"
        : dropped
          ? "terminal_unknown"
          : "succeeded",
      errorCode: synthetic
        ? phase === "unauthorized"
          ? "credential_invalid"
          : "quota_limited"
        : dropped
          ? "ambiguous_dropped_response"
          : null,
      createdAt: at(ordinal === 1 ? 3 : 6),
      completedAt: at(synthetic ? 5 : 9),
      dispatchStartedAt: synthetic ? null : at(7),
      responseStartedAt: synthetic ? null : at(8),
      providerResponseIdHash:
        synthetic || dropped ? null : phaseHash(`response-${runId}`),
      terminalEvidenceHash: synthetic
        ? phaseHash(
            `prepared\0${phase === "unauthorized" ? 401 : 429}\0attempt-${runId}-${ordinal}`,
          )
        : dropped
          ? phaseHash(
              `operator-canary-dropped-response\0attempt-${runId}-${ordinal}\0${ordinal}`,
            )
          : phaseHash(`terminal-${runId}`),
    });
    const attempts = failed
      ? [
          effect(1, grant.primaryAccountId, true),
          effect(2, grant.activeAccountId, false),
        ]
      : [effect(1, grant.activeAccountId, false)];
    const request = {
      id: requestId,
      ordinal: 1,
      status: dropped ? "terminal_unknown" : "succeeded",
      errorCode: dropped ? "ambiguous_dropped_response" : null,
      completedAt: at(9),
      upstreamAttempts: attempts,
    };
    const row = {
      id,
      workspaceId: binding.workspaceId,
      poolId: "pool-canary",
      repositoryBindingId: binding.id,
      bindingRevision: 1n,
      primaryAccountId: grant.primaryAccountId,
      backupAccountId: grant.backupAccountId,
      activeAccountId: grant.activeAccountId,
      failoverCount: grant.failoverCount,
      issuedAt: at(1),
      expiresAt: at(1_800_000),
      status: dropped ? "revoked" : "exhausted",
      revokedAt: dropped ? at(9) : null,
      inFlight: 0,
      requestCount: 1,
      reviewRequestId: `review-${runId}`,
      commentRefreshCapability: { revokedAt: dropped ? at(9) : null },
      relayRequests: [request],
      runId: String(runId),
      runAttempt: 2,
    };
    grants.push(row);
    sources.set(row.reviewRequestId, {
      headSha: "c".repeat(40),
      sourceRunId: String(runId),
      sourceRunAttempt: "2",
      executionId: `execution-${runId}`,
    });
    const observed: CanaryRunEvidence = {
      runId,
      sourceRunAttempt: 2,
      sourceHeadSha: "c".repeat(40),
      sourceExecutionId: `execution-${runId}`,
      grantId: id,
      invocationId: invocation,
      workspaceId: binding.workspaceId,
      githubRepositoryId: "123456789",
      actionRef: binding.workflowActionRef,
      activeAccountId: grant.activeAccountId,
      primaryAccountId: grant.primaryAccountId,
      backupAccountId: grant.backupAccountId,
      failoverCount: grant.failoverCount,
      grantStatus: row.status,
      grantRevokedAt: row.revokedAt?.toISOString() ?? null,
      commentRefreshRevokedAt:
        row.commentRefreshCapability.revokedAt?.toISOString() ?? null,
      repositoryBindingId: binding.id,
      bindingRevision: "1",
      issuedAt: at(1).toISOString(),
      completedAt: at(9).toISOString(),
      requestId,
      requestOrdinal: 1,
      requestErrorCode: request.errorCode,
      requestReceivedAt: at(2).toISOString(),
      requestStartedAt: at(7).toISOString(),
      successfulResponseStartedAt: at(8).toISOString(),
      providerInvocationKey: grant.authority.providerInvocationKey,
      providerResponseIdHash: dropped ? null : phaseHash(`response-${runId}`),
      publicationAttemptId: dropped ? null : `publication-${runId}`,
      appBotPublicationCount: dropped ? 0 : 1,
      nonAppBotPublicationCount: 0,
      publicationObjects: dropped
        ? []
        : [
            {
              kind: "issue_comment",
              externalObjectId: `comment-${runId}`,
              bodyHash: phaseHash(`body-${runId}`),
              authorLogin: "reviewrouter-app[bot]",
              publishedAt: at(9).toISOString(),
            },
          ],
      faultPlanConsumptionCount: consumption ? 1 : 0,
      faultPlanConsumptions: consumption
        ? [
            {
              ...consumption,
              consumedAt: at(4).toISOString(),
            } as CanaryRunEvidence["faultPlanConsumptions"][number],
          ]
        : [],
      requestStatuses: [request.status],
      attempts: attempts.map((a) => ({
        attemptId: a.id,
        relayRequestId: requestId,
        grantId: id,
        ordinal: a.attemptOrdinal,
        state: a.state,
        errorCode: a.errorCode,
        accountId: a.accountId,
        credentialGeneration: a.credentialGeneration.toString(),
        dispatchStartedAt: a.dispatchStartedAt?.toISOString() ?? null,
        responseStartedAt: a.responseStartedAt?.toISOString() ?? null,
        providerResponseIdHash: a.providerResponseIdHash,
        completedAt: a.completedAt.toISOString(),
        createdAt: a.createdAt.toISOString(),
      })),
    };
    observations.set(runId, observed);
    if (phase) time += 10;
    return observed;
  };
  return {
    prisma,
    credentialRows,
    refreshBackup,
    recovery,
    prepare,
    stage,
    scopeFor,
    run,
    now,
    binding,
    grants,
    sources,
    scopes,
    observations,
    get events() {
      return events;
    },
    get accounts() {
      return accounts;
    },
    get restoreCount() {
      return restoreCount;
    },
    changeAccount(index: number, change: Partial<HostedPoolAccount>) {
      accounts[index] = { ...accounts[index]!, ...change };
    },
    loseCommitResponse() {
      responseLost = true;
    },
    failReceipt() {
      receiptFailure = true;
    },
    failCas() {
      casFailure = true;
    },
    setRestoreItems(count: number) {
      restoreItems = count;
    },
    setUncertainEffects(count: number) {
      uncertainEffects = count;
    },
    advance(ms: number) {
      time += ms;
    },
  };
}
