import { describe, expect, it } from "vitest";
import { inspectSetupPullRequestStatus } from "./setup-pull-request-status";

describe("inspectSetupPullRequestStatus", () => {
  it("treats a merged setup PR as merged without requiring the branch to still exist", async () => {
    const requests: string[] = [];
    const status = await inspectSetupPullRequestStatus(
      setupInput(),
      requester(async (route) => {
        requests.push(route);
        return {
          data: {
            merged: true,
            state: "closed",
            head: { ref: "reviewrouter/setup" },
          },
        };
      }),
    );

    expect(status).toBe("merged");
    expect(requests).toEqual(["GET /repos/{owner}/{repo}/pulls/{pull_number}"]);
  });

  it("reports a closed unmerged setup PR when the setup branch still exists", async () => {
    const status = await inspectSetupPullRequestStatus(
      setupInput(),
      requester(async (route) => {
        if (route.includes("/pulls/")) {
          return {
            data: {
              merged: false,
              state: "closed",
              head: { ref: "reviewrouter/setup" },
            },
          };
        }
        return { data: { object: { sha: "setup-branch-sha" } } };
      }),
    );

    expect(status).toBe("closed");
  });

  it("reports a deleted setup branch before asking the user to merge", async () => {
    const status = await inspectSetupPullRequestStatus(
      setupInput(),
      requester(async (route) => {
        if (route.includes("/pulls/")) {
          return {
            data: {
              merged: false,
              state: "open",
              head: { ref: "reviewrouter/setup" },
            },
          };
        }
        throw Object.assign(new Error("not found"), { status: 404 });
      }),
    );

    expect(status).toBe("branch_deleted");
  });
});

function setupInput(): {
  readonly owner: string;
  readonly name: string;
  readonly pullRequestNumber: number;
  readonly setupBranch: string;
} {
  return {
    owner: "777genius",
    name: "example",
    pullRequestNumber: 1,
    setupBranch: "reviewrouter/setup",
  };
}

function requester(
  request: (
    route: string,
    parameters?: Record<string, unknown>,
  ) => Promise<{ data: unknown }>,
): Parameters<typeof inspectSetupPullRequestStatus>[1] {
  return { request };
}
