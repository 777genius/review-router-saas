import { describe, expect, it, vi } from "vitest";
import {
  assertClassifiedOutcome,
  assertExactPullRequestHead,
  assertFreshAttemptTwoRun,
  assertSimultaneousOneAccount,
  parseHostedPoolCanaryConfig,
  runHostedPoolProductionCanary,
  type CanaryRunEvidence,
  type HostedPoolCanaryPort,
} from "./run-hosted-pool-production-canary";
import type { HostedPoolControlPort } from "./hosted-pool-production-control";

const sha = "a".repeat(40);
const releaseSha = "b".repeat(40);
const env = {
  REVIEW_ROUTER_HOSTED_POOL_CANARY_REPOSITORY_ID: "123456789",
  REVIEW_ROUTER_HOSTED_POOL_CANARY_DISPOSABLE_REPOSITORY_ID: "123456789",
  REVIEW_ROUTER_HOSTED_POOL_CANARY_INSTALLATION_ID: "987654321",
  REVIEW_ROUTER_HOSTED_POOL_CANARY_REPOSITORY_ALLOWLIST: "123456789",
  REVIEW_ROUTER_HOSTED_POOL_CANARY_ACTION_SHA: sha,
  REVIEW_ROUTER_HOSTED_POOL_ACTION_SHA: sha,
  REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF: `777genius/review-router@${sha}`,
  REVIEW_ROUTER_HOSTED_POOL_CANARY_RELEASE_PR_NUMBER: "227",
  REVIEW_ROUTER_HOSTED_POOL_CANARY_RELEASE_HEAD_SHA: releaseSha,
  REVIEW_ROUTER_HOSTED_POOL_CANARY_APP_SLUG: "reviewrouter-app",
  REVIEW_ROUTER_HOSTED_POOL_CANARY_POOL_ID: "pool-canary",
  REVIEW_ROUTER_HOSTED_POOL_CANARY_ACCOUNT_IDS_JSON: JSON.stringify([
    "account-a",
    "account-b",
  ]),
  REVIEW_ROUTER_HOSTED_POOL_CANARY_FAULT_PLANS_JSON: JSON.stringify({
    unauthorized: "rr-canary-fault-v2.unauthorized.signature",
    rate_limited: "rr-canary-fault-v2.rate-limited.signature",
    dropped_response: "rr-canary-fault-v2.dropped.signature",
  }),
  REVIEW_ROUTER_HOSTED_POOL_CANARY_RUN_IDS_JSON: JSON.stringify({
    simultaneous_a: 11,
    simultaneous_b: 12,
    unauthorized: 13,
    rate_limited: 14,
    dropped_response: 15,
  }),
};

function evidence(
  runId: number,
  mode: "success" | "401" | "429" | "dropped" = "success",
): CanaryRunEvidence {
  const faultPhase =
    mode === "401"
      ? "synthetic_unauthorized"
      : mode === "429"
        ? "synthetic_rate_limited"
        : mode === "dropped"
          ? "drop_after_response_started"
          : null;
  const faultPlanConsumptions = faultPhase
    ? [
        {
          planIdHash: "f".repeat(64),
          phase: faultPhase,
          repositoryId: "123456789",
          runAttempt: 2,
          actionRef: `777genius/review-router@${sha}`,
          bindingId: "binding-canary",
          bindingRevision: "1",
          requestOrdinal: 1,
          attemptOrdinal: 1,
          injectionPoint:
            faultPhase === "drop_after_response_started"
              ? ("after_response_started" as const)
              : ("before_provider_fetch" as const),
          consumedAt: "2026-08-22T00:00:02.000Z",
        },
      ]
    : [];
  if (mode === "dropped")
    return {
      runId,
      sourceRunAttempt: 2,
      sourceHeadSha: "c".repeat(40),
      sourceExecutionId: `execution-${runId}`,
      grantId: `grant-${runId}`,
      invocationId: `inv-${runId}`,
      workspaceId: "workspace-canary",
      githubRepositoryId: "123456789",
      actionRef: `777genius/review-router@${sha}`,
      activeAccountId: "account-a",
      primaryAccountId: "account-a",
      backupAccountId: "account-b",
      failoverCount: 0,
      grantStatus: "revoked",
      grantRevokedAt: "2026-08-22T00:00:03.000Z",
      commentRefreshRevokedAt: "2026-08-22T00:00:03.000Z",
      repositoryBindingId: "binding-canary",
      bindingRevision: "1",
      issuedAt: "2026-08-22T00:00:00.000Z",
      completedAt: "2026-08-22T00:00:03.000Z",
      requestId: `request-${runId}`,
      requestOrdinal: 1,
      requestErrorCode: "ambiguous_dropped_response",
      requestReceivedAt: "2026-08-22T00:00:00.000Z",
      requestStartedAt: "2026-08-22T00:00:00.500Z",
      successfulResponseStartedAt: "2026-08-22T00:00:02.000Z",
      providerInvocationKey: "d".repeat(64),
      providerResponseIdHash: null,
      publicationAttemptId: null,
      appBotPublicationCount: 0,
      nonAppBotPublicationCount: 0,
      publicationObjects: [],
      faultPlanConsumptionCount: 1,
      faultPlanConsumptions,
      requestStatuses: ["terminal_unknown"],
      attempts: [
        {
          attemptId: `attempt-${runId}-1`,
          relayRequestId: `request-${runId}`,
          grantId: `grant-${runId}`,
          ordinal: 1,
          state: "terminal_unknown",
          errorCode: "ambiguous_dropped_response",
          accountId: "account-a",
          credentialGeneration: "1",
          dispatchStartedAt: "2026-08-22T00:00:01.000Z",
          responseStartedAt: "2026-08-22T00:00:02.000Z",
          providerResponseIdHash: null,
          completedAt: "2026-08-22T00:00:03.000Z",
          createdAt: "2026-08-22T00:00:00.750Z",
        },
      ],
    };
  const failed = mode === "401" || mode === "429";
  return {
    runId,
    sourceRunAttempt: 2,
    sourceHeadSha: "c".repeat(40),
    sourceExecutionId: `execution-${runId}`,
    grantId: `grant-${runId}`,
    invocationId: `inv-${runId}`,
    workspaceId: "workspace-canary",
    githubRepositoryId: "123456789",
    actionRef: `777genius/review-router@${sha}`,
    activeAccountId: failed ? "account-b" : "account-a",
    primaryAccountId: "account-a",
    backupAccountId: "account-b",
    failoverCount: failed ? 1 : 0,
    grantStatus: "exhausted",
    grantRevokedAt: null,
    commentRefreshRevokedAt: null,
    repositoryBindingId: "binding-canary",
    bindingRevision: "1",
    issuedAt: "2026-08-22T00:00:00.000Z",
    completedAt: "2026-08-22T00:00:03.000Z",
    requestId: `request-${runId}`,
    requestOrdinal: 1,
    requestErrorCode: null,
    requestReceivedAt: "2026-08-22T00:00:00.000Z",
    requestStartedAt: "2026-08-22T00:00:00.500Z",
    successfulResponseStartedAt: "2026-08-22T00:00:02.000Z",
    providerInvocationKey: "d".repeat(64),
    providerResponseIdHash: "e".repeat(64),
    publicationAttemptId: `publication-${runId}`,
    appBotPublicationCount: 1,
    nonAppBotPublicationCount: 0,
    publicationObjects: [
      {
        kind: "issue_comment",
        externalObjectId: `comment-${runId}`,
        bodyHash: "f".repeat(64),
        authorLogin: "reviewrouter-app[bot]",
        publishedAt: "2026-08-22T00:00:02.500Z",
      },
    ],
    faultPlanConsumptionCount: failed ? 1 : 0,
    faultPlanConsumptions,
    requestStatuses: ["succeeded"],
    attempts: failed
      ? [
          {
            attemptId: `attempt-${runId}-1`,
            relayRequestId: `request-${runId}`,
            grantId: `grant-${runId}`,
            ordinal: 1,
            state: "failed_no_effect",
            errorCode: mode === "401" ? "credential_invalid" : "quota_limited",
            accountId: "account-a",
            credentialGeneration: "1",
            dispatchStartedAt: null,
            responseStartedAt: null,
            providerResponseIdHash: null,
            completedAt: "2026-08-22T00:00:01.000Z",
            createdAt: "2026-08-22T00:00:00.750Z",
          },
          {
            attemptId: `attempt-${runId}-2`,
            relayRequestId: `request-${runId}`,
            grantId: `grant-${runId}`,
            ordinal: 2,
            state: "succeeded",
            errorCode: null,
            accountId: "account-b",
            credentialGeneration: "1",
            dispatchStartedAt: "2026-08-22T00:00:01.250Z",
            responseStartedAt: "2026-08-22T00:00:02.000Z",
            providerResponseIdHash: "e".repeat(64),
            completedAt: "2026-08-22T00:00:03.000Z",
            createdAt: "2026-08-22T00:00:01.125Z",
          },
        ]
      : [
          {
            attemptId: `attempt-${runId}-1`,
            relayRequestId: `request-${runId}`,
            grantId: `grant-${runId}`,
            ordinal: 1,
            state: "succeeded",
            errorCode: null,
            accountId: "account-a",
            credentialGeneration: "1",
            dispatchStartedAt: "2026-08-22T00:00:01.000Z",
            responseStartedAt: "2026-08-22T00:00:02.000Z",
            providerResponseIdHash: "e".repeat(64),
            completedAt: "2026-08-22T00:00:03.000Z",
            createdAt: "2026-08-22T00:00:00.750Z",
          },
        ],
  };
}

function kit() {
  const config = parseHostedPoolCanaryConfig(env);
  const rerun = vi.fn(async () => undefined);
  const values = new Map([
    [11, evidence(11)],
    [12, evidence(12)],
    [13, evidence(13, "401")],
    [14, evidence(14, "429")],
    [15, evidence(15, "dropped")],
  ]);
  const canary: HostedPoolCanaryPort = {
    preflight: vi.fn(async () => ({ exact: true })),
    rerun,
    waitForCompletion: vi.fn(async () => undefined),
    evidence: vi.fn(async (runId) => values.get(runId)!),
  };
  const deployment = {
    readExactRevision: vi.fn(async () => [
      {
        serviceId: "srv-api",
        serviceName: "reviewrouter-api" as const,
        deployId: "dep-api",
        commitSha: releaseSha,
        status: "live" as const,
        observedAt: "2026-08-22T00:00:00.000Z",
      },
      {
        serviceId: "srv-web",
        serviceName: "reviewrouter-web" as const,
        deployId: "dep-web",
        commitSha: releaseSha,
        status: "live" as const,
        observedAt: "2026-08-22T00:00:00.000Z",
      },
    ]),
  };
  const setFlags = vi.fn(async () => undefined);
  const flags = Object.fromEntries(
    ["POOL", "CUSTODY", "ADMISSION", "RELAY", "FAILOVER"].map((name) => [
      `REVIEW_ROUTER_ENABLE_HOSTED_CODEX_${name}`,
      "1",
    ]),
  ) as Record<string, "0" | "1">;
  let runtimeGate = {
    status: "closed" as "closed" | "active",
    authzEpoch: "1",
    revision: "1",
    reasonCode: "fixture",
    changedAt: "2026-08-22T00:00:00.000Z",
    changedByHash: "0".repeat(64),
  };
  const control: HostedPoolControlPort = {
    readRuntimeGate: vi.fn(async () => runtimeGate),
    transitionRuntimeGate: vi.fn(async (transition) => {
      runtimeGate = {
        status: transition.status,
        authzEpoch: (BigInt(runtimeGate.authzEpoch) + 1n).toString(),
        revision: (BigInt(runtimeGate.revision) + 1n).toString(),
        reasonCode: transition.reasonCode,
        changedAt: transition.changedAt.toISOString(),
        changedByHash: transition.changedByHash,
      };
      return runtimeGate;
    }),
    readFlags: vi.fn(async () => ({
      api: { ...flags } as never,
      web: { ...flags } as never,
    })),
    setFlags: vi.fn(async (patch) => {
      setFlags(patch);
      Object.assign(flags, patch);
    }),
    reconcileExpiredGrants: vi.fn(async () => ({
      expiredCount: 0,
      batches: 1,
    })),
    counts: vi.fn(async () => ({
      inFlight: 0,
      issuedGrants: 0,
      unresolvedRequests: 0,
      terminalUnknownRequests: 1,
    })),
    setFaultPlan: vi.fn(async () => undefined),
  };
  return { config, canary, deployment, control, rerun, setFlags };
}

describe("hosted pool one-shot production canary", () => {
  it("binds release evidence to the exact PR head and rejects merge SHA", () => {
    const pullRequest = {
      number: 227,
      state: "open",
      head: { sha: releaseSha },
      base: { repo: { full_name: "777genius/review-router-saas" } },
      merge_commit_sha: "c".repeat(40),
    };
    expect(() =>
      assertExactPullRequestHead(pullRequest, {
        pullRequestNumber: 227,
        headSha: releaseSha,
        repositoryFullName: "777genius/review-router-saas",
        errorCode: "mismatch",
      }),
    ).not.toThrow();
    expect(() =>
      assertExactPullRequestHead(
        { ...pullRequest, head: { sha: "c".repeat(40) } },
        {
          pullRequestNumber: 227,
          headSha: releaseSha,
          repositoryFullName: "777genius/review-router-saas",
          errorCode: "mismatch",
        },
      ),
    ).toThrow("mismatch");
  });

  it("accepts only a fresh attempt-2 run on the exact source head", () => {
    const rerunRequestedAt = new Date("2026-08-22T00:00:00.000Z");
    const run = {
      run_attempt: 2,
      status: "completed",
      conclusion: "success",
      head_sha: "c".repeat(40),
      run_started_at: "2026-08-22T00:00:01.000Z",
      updated_at: "2026-08-22T00:00:02.000Z",
    };
    expect(
      assertFreshAttemptTwoRun(run, {
        runId: 11,
        expectedConclusion: "success",
        sourceHeadSha: "c".repeat(40),
        rerunRequestedAt,
      }),
    ).toMatchObject({ startedAt: new Date(run.run_started_at) });
    expect(() =>
      assertFreshAttemptTwoRun(
        { ...run, head_sha: "d".repeat(40) },
        {
          runId: 11,
          expectedConclusion: "success",
          sourceHeadSha: "c".repeat(40),
          rerunRequestedAt,
        },
      ),
    ).toThrow("hosted_pool_canary_run_timestamps_invalid:11");
  });

  it("rejects every repository except the exact numeric disposable target", () => {
    expect(() =>
      parseHostedPoolCanaryConfig({
        ...env,
        REVIEW_ROUTER_HOSTED_POOL_CANARY_REPOSITORY_ALLOWLIST: "123456789,2",
      }),
    ).toThrow("hosted_pool_canary_exact_repository_allowlist_required");
    expect(() =>
      parseHostedPoolCanaryConfig({
        ...env,
        REVIEW_ROUTER_HOSTED_POOL_CANARY_REPOSITORY_ID: "123456788",
      }),
    ).toThrow("hosted_pool_canary_exact_repository_allowlist_required");
  });

  it("defaults to preflight-only dry run with no provider run or rollback", async () => {
    const { config, canary, deployment, control, rerun, setFlags } = kit();
    const result = await runHostedPoolProductionCanary({
      config,
      execute: false,
      canary,
      deployment,
      control,
    });
    expect(result.result).toBe("dry_run");
    expect(rerun).not.toHaveBeenCalled();
    expect(setFlags).not.toHaveBeenCalled();
  });

  it("requires independent execution and rollback confirmations", async () => {
    const { config, canary, deployment, control } = kit();
    await expect(
      runHostedPoolProductionCanary({
        config,
        execute: true,
        executeConfirmation: "yes",
        rollbackConfirmation: "yes",
        canary,
        deployment,
        control,
      }),
    ).rejects.toThrow("hosted_pool_canary_confirmations_required");
  });

  it("runs simultaneous reviews, classified faults, and always ordered rollback", async () => {
    const { config, canary, deployment, control, rerun, setFlags } = kit();
    const result = await runHostedPoolProductionCanary({
      config,
      execute: true,
      executeConfirmation: "EXECUTE ONE SHOT HOSTED POOL CANARY",
      rollbackConfirmation: "ROLL BACK HOSTED POOL AFTER CANARY",
      canary,
      deployment,
      control,
      now: () => new Date("2026-08-22T00:00:00.000Z"),
      sleep: async () => undefined,
    });
    expect(rerun.mock.calls.map(([runId]) => runId)).toEqual([
      11, 12, 13, 14, 15,
    ]);
    expect(setFlags).toHaveBeenCalledWith({
      REVIEW_ROUTER_ENABLE_HOSTED_CODEX_POOL: "1",
      REVIEW_ROUTER_ENABLE_HOSTED_CODEX_CUSTODY: "1",
      REVIEW_ROUTER_ENABLE_HOSTED_CODEX_RELAY: "1",
      REVIEW_ROUTER_ENABLE_HOSTED_CODEX_FAILOVER: "1",
    });
    expect(setFlags).toHaveBeenCalledWith({
      REVIEW_ROUTER_ENABLE_HOSTED_CODEX_ADMISSION: "1",
    });
    expect(control.setFaultPlan).toHaveBeenCalledTimes(8);
    expect(vi.mocked(control.setFaultPlan!).mock.calls).toEqual([
      [null],
      [config.faultPlans.unauthorized],
      [null],
      [config.faultPlans.rate_limited],
      [null],
      [config.faultPlans.dropped_response],
      [null],
      [null],
    ]);
    expect(result.result).toBe("passed");
    expect(result.records).not.toContainEqual(
      expect.objectContaining({ phase: "certification_blocked" }),
    );
  });

  it("requires strict overlap between the two upstream effect intervals", () => {
    const second = evidence(12);
    expect(() =>
      assertSimultaneousOneAccount([
        evidence(11),
        {
          ...second,
          completedAt: "2026-08-22T00:00:06.000Z",
          attempts: [
            {
              ...second.attempts[0]!,
              dispatchStartedAt: "2026-08-22T00:00:04.000Z",
              responseStartedAt: "2026-08-22T00:00:05.000Z",
              providerResponseIdHash: "e".repeat(64),
              completedAt: "2026-08-22T00:00:06.000Z",
            },
          ],
        },
      ]),
    ).toThrow("hosted_pool_canary_simultaneous_account_contract_failed");
  });

  it("distinguishes the signed 401 and 429 plan consumptions", () => {
    const unauthorized = evidence(13, "401");
    expect(() =>
      assertClassifiedOutcome(
        {
          ...unauthorized,
          faultPlanConsumptions: [
            {
              ...unauthorized.faultPlanConsumptions[0]!,
              phase: "synthetic_rate_limited",
            },
          ],
        },
        "401",
      ),
    ).toThrow("hosted_pool_canary_401_backup_contract_failed");
  });

  it("forbids replay after an ambiguous dropped response", () => {
    expect(() =>
      assertClassifiedOutcome(
        {
          ...evidence(15, "dropped"),
          attempts: [
            ...evidence(15, "dropped").attempts,
            {
              attemptId: "attempt-15-2",
              relayRequestId: "request-15",
              grantId: "grant-15",
              ordinal: 2,
              state: "succeeded",
              errorCode: null,
              accountId: "account-b",
              credentialGeneration: "1",
              dispatchStartedAt: "2026-08-22T00:00:04.000Z",
              responseStartedAt: "2026-08-22T00:00:05.000Z",
              providerResponseIdHash: "e".repeat(64),
              completedAt: "2026-08-22T00:00:06.000Z",
              createdAt: "2026-08-22T00:00:03.500Z",
            },
          ],
        },
        "dropped",
      ),
    ).toThrow("hosted_pool_canary_dropped_response_replayed");
  });

  it("stops after the first failed phase and still performs ordered rollback", async () => {
    const { config, canary, deployment, control, rerun, setFlags } = kit();
    vi.mocked(canary.waitForCompletion).mockRejectedValueOnce(
      new Error("fixture_run_failed"),
    );
    const result = await runHostedPoolProductionCanary({
      config,
      execute: true,
      executeConfirmation: "EXECUTE ONE SHOT HOSTED POOL CANARY",
      rollbackConfirmation: "ROLL BACK HOSTED POOL AFTER CANARY",
      canary,
      deployment,
      control,
      now: () => new Date("2026-08-22T00:00:00.000Z"),
      sleep: async () => undefined,
    });
    expect(result.result).toBe("failed");
    expect(rerun).toHaveBeenCalledTimes(2);
    expect(setFlags).toHaveBeenCalledWith({
      REVIEW_ROUTER_ENABLE_HOSTED_CODEX_POOL: "0",
    });
  });
});
