import { describe, expect, it, vi } from "vitest";
import {
  ReviewRequestedDispatchLookupStatus,
  ReviewRequestedDispatchRunStatus,
  ReviewRequestedDispatchSubmissionStatus,
  ReviewRequestedIntentState,
  ReviewRequestedTriggerKind,
  type ReviewRequestedIntent,
} from "@reviewrouter/features-review-executions";
import { GitHubActionsReviewRequestedDispatchGateway } from "./review-v2-intent-dispatcher";

describe("GitHubActionsReviewRequestedDispatchGateway", () => {
  it("reconciles an existing run before creating an external side effect", async () => {
    const request = vi.fn(async (route: string) => {
      expect(route).toContain("/workflows/");
      return {
        data: {
          workflow_runs: [
            {
              id: 701,
              run_attempt: 2,
              display_title: "ReviewRouter review request-1",
              created_at: "2026-07-23T00:00:01.000Z",
            },
          ],
        },
      };
    });
    const gateway = gatewayWith(request);

    await expect(
      gateway.findByRequestIdentity({ intent: intentFixture() }),
    ).resolves.toEqual({
      status: ReviewRequestedDispatchLookupStatus.Found,
      sourceRunId: "701",
      sourceRunAttempt: "2",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("includes a run created in the same second as the durable submission", async () => {
    const request = vi.fn(async (_route: string, parameters?: object) => {
      expect(parameters).toMatchObject({
        created: ">=2026-07-23T00:00:00.000Z",
      });
      return {
        data: {
          workflow_runs: [
            {
              id: 700,
              run_attempt: 1,
              display_title: "ReviewRouter review request-1",
              created_at: "2026-07-23T00:00:00.000Z",
            },
          ],
        },
      };
    });
    const gateway = gatewayWith(request);

    await expect(
      gateway.findByRequestIdentity({
        intent: {
          ...intentFixture(),
          submissionStartedAt: new Date("2026-07-23T00:00:00.999Z"),
        },
      }),
    ).resolves.toMatchObject({
      status: ReviewRequestedDispatchLookupStatus.Found,
      sourceRunId: "700",
    });
  });

  it("requests exact run details and sends the durable request identity", async () => {
    const request = vi.fn(async (route: string, parameters?: object) => {
      expect(route.startsWith("POST")).toBe(true);
      expect(parameters).toMatchObject({
        ref: "main",
        inputs: {
          review_request_id: "request-1",
          pr_number: "42",
          review_head_sha: "c".repeat(40),
        },
        headers: { "X-GitHub-Api-Version": "2026-03-10" },
      });
      return { data: { workflow_run_id: 702 } };
    });
    const gateway = gatewayWith(request);
    const prepared = await gateway.prepare({ intent: intentFixture() });

    await expect(prepared.submit()).resolves.toEqual({
      status: ReviewRequestedDispatchSubmissionStatus.Accepted,
      sourceRunId: "702",
      sourceRunAttempt: "1",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("inspects the exact recorded attempt and validates its correlation", async () => {
    const request = vi.fn(async (route: string, parameters?: object) => {
      if (route.includes("/attempts/")) {
        expect(parameters).toMatchObject({ run_id: "701", attempt_number: 2 });
        return {
          data: {
            id: 701,
            run_attempt: 2,
            event: "workflow_dispatch",
            display_title: "ReviewRouter review request-1",
            status: "completed",
          },
        };
      }
      return {
        data: {
          head: { sha: "c".repeat(40) },
          base: { sha: "a".repeat(40) },
        },
      };
    });
    const gateway = gatewayWith(request);

    await expect(
      gateway.inspectKnownRun({
        intent: {
          ...intentFixture(),
          state: ReviewRequestedIntentState.AwaitingAuthorization,
          claim: null,
          sourceRunId: "701",
          sourceRunAttempt: "2",
        },
      }),
    ).resolves.toEqual({
      status: ReviewRequestedDispatchRunStatus.TerminalCurrentRevision,
    });
  });

  it("classifies a validation rejection as definitely no external effect", async () => {
    const request = vi.fn(async () => {
      throw Object.assign(new Error("unprocessable"), { status: 422 });
    });
    const gateway = gatewayWith(request);
    const prepared = await gateway.prepare({ intent: intentFixture() });

    await expect(prepared.submit()).resolves.toEqual({
      status: ReviewRequestedDispatchSubmissionStatus.DefinitelyNoEffect,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("returns inconclusive when the bounded workflow inventory is exhausted", async () => {
    const request = vi.fn(async () => ({
      data: {
        workflow_runs: Array.from({ length: 100 }, (_, index) => ({
          id: index + 1,
          run_attempt: 1,
          display_title: `unrelated-${index}`,
          created_at: "2026-07-23T00:00:01.000Z",
        })),
      },
    }));
    const gateway = gatewayWith(request);

    await expect(
      gateway.findByRequestIdentity({ intent: intentFixture() }),
    ).resolves.toEqual({
      status: ReviewRequestedDispatchLookupStatus.Inconclusive,
    });
    expect(request).toHaveBeenCalledTimes(5);
  });

  it("fails closed when more than one run matches the request identity", async () => {
    const request = vi.fn(async () => ({
      data: {
        workflow_runs: [
          {
            id: 701,
            run_attempt: 1,
            display_title: "ReviewRouter review request-1",
            created_at: "2026-07-23T00:00:01.000Z",
          },
          {
            id: 702,
            run_attempt: 1,
            display_title: "ReviewRouter review request-1",
            created_at: "2026-07-23T00:00:02.000Z",
          },
        ],
      },
    }));
    const gateway = gatewayWith(request);

    await expect(
      gateway.findByRequestIdentity({ intent: intentFixture() }),
    ).resolves.toEqual({
      status: ReviewRequestedDispatchLookupStatus.Inconclusive,
    });
  });

  it("cancels only the exact persisted run identity", async () => {
    const request = vi.fn(async (route: string, parameters?: object) => {
      expect(route).toContain("/actions/runs/{run_id}/cancel");
      expect(parameters).toMatchObject({ run_id: "701" });
      return { data: {} };
    });
    const gateway = gatewayWith(request);

    await expect(
      gateway.cancelKnownRun({
        intent: {
          ...intentFixture(),
          state: ReviewRequestedIntentState.AwaitingAuthorization,
          claim: null,
          sourceRunId: "701",
          sourceRunAttempt: "2",
        },
      }),
    ).resolves.toBeUndefined();
  });
});

function gatewayWith(
  request: (
    route: string,
    parameters?: Readonly<Record<string, unknown>>,
  ) => Promise<{ readonly data: unknown }>,
) {
  const prisma = {
    repositoryConnection: {
      findUnique: vi.fn(async () => ({
        id: "connection-1",
        workspaceId: "workspace-1",
        scmRepositoryIdentityId: "repository-1",
        owner: "777genius",
        name: "agent-teams-ai",
        defaultBranch: "main",
        provider: "github",
        selected: true,
        archived: false,
        installation: { status: "active", githubInstallationId: 123n },
      })),
    },
  };
  return new GitHubActionsReviewRequestedDispatchGateway(
    prisma as never,
    { appId: "1", privateKey: "unused-in-test" },
    ".github/workflows/reviewrouter-codex.yml",
    { forInstallation: async () => ({ request }) },
  );
}

function intentFixture(): ReviewRequestedIntent {
  const now = new Date("2026-07-23T00:00:00.000Z");
  return {
    workspaceId: "workspace-1",
    repositoryConnectionId: "connection-1",
    scmRepositoryIdentityId: "repository-1",
    pullRequestNumber: 42,
    requestId: "request-1",
    dispatchAttempt: 1,
    version: 3n,
    revision: {
      baseSha: "a".repeat(40),
      mergeBaseSha: "b".repeat(40),
      headSha: "c".repeat(40),
      reviewRevisionHash: "d".repeat(64),
    },
    triggerKind: ReviewRequestedTriggerKind.PullRequestSynchronized,
    deliveryIdentityHash: "e".repeat(64),
    canonicalRequestHash: "f".repeat(64),
    state: ReviewRequestedIntentState.ReconcilingDispatch,
    notBefore: now,
    claim: {
      claimId: "claim-1",
      ownerIdHash: "owner-1",
      fencingToken: 1n,
      claimedAt: now,
      claimUntil: new Date("2026-07-23T00:01:00.000Z"),
    },
    submissionStartedAt: now,
    nextResolutionAt: new Date("2026-07-23T00:00:05.000Z"),
    resolutionDeadlineAt: new Date("2026-07-23T00:05:00.000Z"),
    sourceRunId: null,
    sourceRunAttempt: null,
    authorizationId: null,
    executionId: null,
    terminalReason: null,
    supersededByRequestId: null,
    createdAt: now,
    updatedAt: now,
    retainUntil: new Date("2026-08-23T00:00:00.000Z"),
  };
}
