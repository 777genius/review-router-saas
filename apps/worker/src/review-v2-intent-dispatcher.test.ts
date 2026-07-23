import { describe, expect, it, vi } from "vitest";
import {
  ReviewRequestedDispatchRunStatus,
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
            },
          ],
        },
      };
    });
    const gateway = gatewayWith(request);

    await expect(
      gateway.dispatch({ intent: intentFixture() }),
    ).resolves.toEqual({ sourceRunId: "701", sourceRunAttempt: "2" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("requests exact run details and sends the durable request identity", async () => {
    const request = vi.fn(async (route: string, parameters?: object) => {
      if (route.startsWith("GET")) {
        return { data: { workflow_runs: [] } };
      }
      expect(parameters).toMatchObject({
        ref: "main",
        return_run_details: true,
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

    await expect(
      gateway.dispatch({ intent: intentFixture() }),
    ).resolves.toEqual({ sourceRunId: "702", sourceRunAttempt: "1" });
    expect(request).toHaveBeenCalledTimes(2);
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
      gateway.inspect({
        intent: {
          ...intentFixture(),
          sourceRunId: "701",
          sourceRunAttempt: "2",
        },
      }),
    ).resolves.toEqual({
      status: ReviewRequestedDispatchRunStatus.TerminalCurrentRevision,
    });
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
    state: ReviewRequestedIntentState.AwaitingAuthorization,
    notBefore: now,
    claim: null,
    sourceRunId: "701",
    sourceRunAttempt: "2",
    authorizationId: null,
    executionId: null,
    supersededByRequestId: null,
    createdAt: now,
    updatedAt: now,
    retainUntil: new Date("2026-08-23T00:00:00.000Z"),
  };
}
