import { describe, expect, it, vi } from "vitest";
import {
  assertClassifiedOutcome,
  assertExactPullRequestHead,
  assertExactReleasePullRequestRevision,
  assertFreshAttemptTwoRun,
  assertSimultaneousOneAccount,
  createGitHubHostedPoolCanaryPort,
  parseHostedPoolCanaryConfig,
  runHostedPoolProductionCanary,
  type CanaryRunEvidence,
  type HostedPoolCanaryPort,
} from "./run-hosted-pool-production-canary";
import type { HostedPoolControlPort } from "./hosted-pool-production-control";
import { renderCanonicalHostedPoolWorkflowV2 } from "../packages/features/workflow-provisioning/src/domain/hosted-pool-workflow-template";
import { canaryPhaseFixture } from "./hosted-pool-canary-phase-recovery.fixture";

vi.mock("../packages/platform/db/src/index.js", () => ({
  createPrismaClient: () => ({
    $disconnect: vi.fn(async () => undefined),
  }),
}));

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
    preflight: vi.fn(async () => ({
      exact: true,
      repositoryBindingId: "binding-canary",
      bindingRevision: "1",
    })),
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
    prepareCanaryPhase: vi.fn(async () => undefined),
    reconcileCanaryPhase: vi.fn(async (scope) => ({
      receiptId: scope.planIdHash,
      status: scope.phase === "dropped_response" ? "unchanged" : "restored",
    })),
  };
  return { config, canary, deployment, control, rerun, setFlags };
}

describe("hosted pool one-shot production canary", () => {
  it("accepts an open release PR only at its exact source head", () => {
    const openPullRequest = {
      number: 227,
      state: "open",
      merged: false,
      merged_at: null,
      head: { sha: releaseSha },
      base: { repo: { full_name: "777genius/review-router-saas" } },
      merge_commit_sha: "c".repeat(40),
    };
    expect(() =>
      assertExactReleasePullRequestRevision(openPullRequest, {
        pullRequestNumber: 227,
        releaseHeadSha: releaseSha,
        repositoryFullName: "777genius/review-router-saas",
        errorCode: "mismatch",
      }),
    ).not.toThrow();
    expect(() =>
      assertExactReleasePullRequestRevision(
        { ...openPullRequest, head: { sha: "d".repeat(40) } },
        {
          pullRequestNumber: 227,
          releaseHeadSha: releaseSha,
          repositoryFullName: "777genius/review-router-saas",
          errorCode: "mismatch",
        },
      ),
    ).toThrow("mismatch");
  });

  it.each(["2026-08-29T12:34:56.000Z", "2026-08-29T12:34:56Z"])(
    "accepts a merged release PR at its exact resulting commit with timestamp %s",
    (mergedAt) => {
      expect(() =>
        assertExactReleasePullRequestRevision(
          {
            number: 245,
            state: "closed",
            merged: true,
            merged_at: mergedAt,
            head: { sha: "2".repeat(40) },
            base: { repo: { full_name: "777genius/review-router-saas" } },
            merge_commit_sha: releaseSha,
          },
          {
            pullRequestNumber: 245,
            releaseHeadSha: releaseSha,
            repositoryFullName: "777genius/review-router-saas",
            errorCode: "mismatch",
          },
        ),
      ).not.toThrow();
    },
  );

  it.each([
    [
      "closed but unmerged",
      { state: "closed", merged: false, merged_at: null },
    ],
    ["wrong merged commit", { merge_commit_sha: "c".repeat(40) }],
    ["malformed merged timestamp", { merged_at: "not-a-timestamp" }],
    ["malformed calendar timestamp", { merged_at: "2026-02-31T12:34:56.000Z" }],
  ])("rejects a %s release PR response", (_name, patch) => {
    const mergedPullRequest = {
      number: 245,
      state: "closed",
      merged: true,
      merged_at: "2026-08-29T12:34:56.000Z",
      head: { sha: "2".repeat(40) },
      base: { repo: { full_name: "777genius/review-router-saas" } },
      merge_commit_sha: releaseSha,
    };
    expect(() =>
      assertExactReleasePullRequestRevision(
        { ...mergedPullRequest, ...patch },
        {
          pullRequestNumber: 245,
          releaseHeadSha: releaseSha,
          repositoryFullName: "777genius/review-router-saas",
          errorCode: "mismatch",
        },
      ),
    ).toThrow("mismatch");
  });

  it("rejects an open PR whose synthetic merge SHA is the only match", () => {
    expect(() =>
      assertExactReleasePullRequestRevision(
        {
          number: 245,
          state: "open",
          merged: false,
          merged_at: null,
          head: { sha: "2".repeat(40) },
          base: { repo: { full_name: "777genius/review-router-saas" } },
          merge_commit_sha: releaseSha,
        },
        {
          pullRequestNumber: 245,
          releaseHeadSha: releaseSha,
          repositoryFullName: "777genius/review-router-saas",
          errorCode: "mismatch",
        },
      ),
    ).toThrow("mismatch");
  });

  it.each([
    ["wrong PR", { number: 246 }, releaseSha],
    [
      "wrong repository",
      { base: { repo: { full_name: "777genius/other" } } },
      releaseSha,
    ],
    ["malformed response", { base: null }, releaseSha],
    ["malformed response SHA", { head: { sha: "not-a-sha" } }, releaseSha],
    ["malformed expected SHA", {}, "not-a-sha"],
  ])("rejects %s", (_name, patch, expectedSha) => {
    const pullRequest = {
      number: 245,
      state: "closed",
      merged: true,
      merged_at: "2026-08-29T12:34:56.000Z",
      head: { sha: "2".repeat(40) },
      base: { repo: { full_name: "777genius/review-router-saas" } },
      merge_commit_sha: releaseSha,
    };
    expect(() =>
      assertExactReleasePullRequestRevision(
        { ...pullRequest, ...patch },
        {
          pullRequestNumber: 245,
          releaseHeadSha: expectedSha,
          repositoryFullName: "777genius/review-router-saas",
          errorCode: "mismatch",
        },
      ),
    ).toThrow("mismatch");
  });

  it("keeps disposable PR validation strict to an open exact head", () => {
    const pullRequest = {
      number: 17,
      state: "open",
      head: { sha: releaseSha, repo: { id: 123456789 } },
      base: { repo: { id: 123456789 } },
      merge_commit_sha: "c".repeat(40),
    };
    expect(() =>
      assertExactPullRequestHead(pullRequest, {
        pullRequestNumber: 17,
        headSha: releaseSha,
        repositoryId: 123456789,
        errorCode: "mismatch",
      }),
    ).not.toThrow();
    expect(() =>
      assertExactPullRequestHead(
        { ...pullRequest, merge_commit_sha: releaseSha },
        {
          pullRequestNumber: 17,
          headSha: releaseSha,
          repositoryId: 123456789,
          errorCode: "mismatch",
        },
      ),
    ).toThrow("mismatch");
    expect(() =>
      assertExactPullRequestHead(
        { ...pullRequest, state: "closed" },
        {
          pullRequestNumber: 17,
          headSha: releaseSha,
          repositoryId: 123456789,
          errorCode: "mismatch",
        },
      ),
    ).toThrow("mismatch");
  });

  it.each([
    ["merged exact SHA", {}, true],
    ["wrong merged SHA", { merge_commit_sha: "c".repeat(40) }, false],
    ["closed but unmerged", { merged: false, merged_at: null }, false],
  ])(
    "wires release validation into GitHub preflight for %s",
    async (_name, releasePatch, reachesActionsLookup) => {
      const config = parseHostedPoolCanaryConfig(env);
      const workflow = renderCanonicalHostedPoolWorkflowV2({
        actionRef: `777genius/review-router@${sha}`,
        apiUrl: "https://reviewrouter.example",
        providerInstanceId: "hosted-pool:repository:123456789",
        bindingId: "binding-canary",
        bindingRevision: 1,
      });
      const responses = [
        {
          id: 123456789,
          full_name: "777genius/rr-codex-rotating-e2e",
          archived: false,
          visibility: "private",
          default_branch: "main",
        },
        { id: 987654321, app_slug: "reviewrouter-app" },
        { sha: "d".repeat(40) },
        { content: Buffer.from(workflow).toString("base64") },
        {
          number: 227,
          state: "closed",
          merged: true,
          merged_at: "2026-08-29T12:34:56.000Z",
          head: { sha: "2".repeat(40) },
          base: { repo: { full_name: "777genius/review-router-saas" } },
          merge_commit_sha: releaseSha,
          ...releasePatch,
        },
      ];
      const fetchMock = vi.fn<typeof fetch>(async () => {
        const body = responses.shift();
        return body
          ? new Response(JSON.stringify(body), { status: 200 })
          : new Response(null, { status: 418 });
      });
      vi.stubGlobal("fetch", fetchMock);
      const canary = createGitHubHostedPoolCanaryPort({
        appJwt: "app-jwt",
        repositoryToken: "repository-token",
        databaseUrl: "postgresql://fixture.invalid/reviewrouter",
      });
      try {
        const preflight = canary.preflight(config);
        if (reachesActionsLookup) {
          await expect(preflight).rejects.toThrow(
            "hosted_pool_canary_github_418",
          );
        } else {
          await expect(preflight).rejects.toThrow(
            "hosted_pool_canary_release_pr_head_mismatch",
          );
        }
        expect(fetchMock).toHaveBeenCalledTimes(reachesActionsLookup ? 6 : 5);
        expect(fetchMock.mock.calls[4]?.[0]).toBe(
          "https://api.github.com/repos/777genius/review-router-saas/pulls/227",
        );
        expect(
          fetchMock.mock.calls.some(([request]) =>
            String(request).includes("/actions/runs/"),
          ),
        ).toBe(reachesActionsLookup);
        if (reachesActionsLookup) {
          expect(fetchMock.mock.calls[5]?.[0]).toBe(
            "https://api.github.com/repos/777genius/rr-codex-rotating-e2e/actions/runs/11",
          );
        }
      } finally {
        await canary.disconnect();
        vi.unstubAllGlobals();
      }
    },
  );

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

  it("runs all five controller phases against one evolving two-account domain and the production recovery adapter", async () => {
    const k = kit();
    const f = canaryPhaseFixture();
    const states: string[] = [];
    const canary: HostedPoolCanaryPort = {
      ...k.canary,
      rerun: vi.fn(async (runId) => {
        f.run(runId, f.scopes.get(runId)?.phase);
      }),
      evidence: async (runId) => f.observations.get(runId)!,
    };
    const control: HostedPoolControlPort = {
      ...k.control,
      prepareCanaryPhase: f.prepare,
      setFaultPlan: async (token) => {
        if (token) {
          const phase = (
            Object.keys(k.config.faultPlans) as Array<
              keyof typeof k.config.faultPlans
            >
          ).find((p) => k.config.faultPlans[p] === token)!;
          await f.stage(f.scopes.get(k.config.runs[phase])!);
        }
      },
      reconcileCanaryPhase: async (scope, observed) => {
        states.push(f.accounts[0]!.availability.status);
        return f.recovery.reconcileCanaryPhase(scope, observed);
      },
    };
    const result = await runHostedPoolProductionCanary({
      ...k,
      canary,
      control,
      execute: true,
      executeConfirmation: "EXECUTE ONE SHOT HOSTED POOL CANARY",
      rollbackConfirmation: "ROLL BACK HOSTED POOL AFTER CANARY",
      sleep: async () => undefined,
    });
    expect(result.result, JSON.stringify(result.records)).toBe("passed");
    expect(vi.mocked(canary.rerun).mock.calls.map(([id]) => id)).toEqual([
      11, 12, 13, 14, 15,
    ]);
    expect(states).toEqual(["quarantined", "cooldown", "healthy"]);
    expect(f.accounts.map((a) => a.healthVersion)).toEqual([5, 1]);
    expect(f.restoreCount).toBe(2);
    expect(f.grants.map((g) => g.backupAccountId)).toEqual(
      Array(5).fill("account-b"),
    );
    expect(
      f.grants
        .flatMap((g) => g.relayRequests[0].upstreamAttempts)
        .filter((a) => a.dispatchStartedAt !== null),
    ).toHaveLength(5);
    expect(result.records.at(-1)).toMatchObject({
      phase: "ordered_rollback",
      outcome: "passed",
    });
  });

  it.each([
    "stage_response_lost",
    "cancellation_failed",
    "health_reconciliation_failed",
  ])("stops before the next run and rolls back after %s", async (failure) => {
    const k = kit();
    let staged = false;
    let cleanupAttempts = 0;
    const restore = vi.fn(async () => {
      throw new Error("health_reconciliation_failed");
    });
    const control: HostedPoolControlPort = {
      ...k.control,
      reconcileCanaryPhase: restore,
      setFaultPlan: vi.fn(async (token) => {
        if (token) {
          staged = true;
          if (failure === "stage_response_lost") throw new Error(failure);
        } else if (staged) {
          cleanupAttempts++;
          if (failure === "cancellation_failed") throw new Error(failure);
          staged = false;
        }
      }),
    };
    const result = await runHostedPoolProductionCanary({
      ...k,
      control,
      execute: true,
      executeConfirmation: "EXECUTE ONE SHOT HOSTED POOL CANARY",
      rollbackConfirmation: "ROLL BACK HOSTED POOL AFTER CANARY",
      sleep: async () => undefined,
    });
    expect(result.result).toBe("failed");
    expect(k.rerun.mock.calls.map(([id]) => id)).toEqual(
      failure === "stage_response_lost" ? [11, 12] : [11, 12, 13],
    );
    expect(cleanupAttempts).toBe(failure === "cancellation_failed" ? 2 : 1);
    expect(restore).toHaveBeenCalledTimes(
      failure === "health_reconciliation_failed" ? 1 : 0,
    );
    expect(result.records.at(-1)?.phase).toBe(
      failure === "cancellation_failed"
        ? "ordered_rollback_failed"
        : "ordered_rollback",
    );
    expect(k.setFlags).toHaveBeenCalledWith({
      REVIEW_ROUTER_ENABLE_HOSTED_CODEX_RELAY: "0",
    });
    expect(await control.readRuntimeGate()).toMatchObject({ status: "closed" });
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
