import { describe, expect, it } from "vitest";
import { provisionReviewRouterWorkflow } from "../application/use-cases/provision-reviewrouter-workflow";
import { PrismaWorkflowProvisioningRepository } from "../infrastructure/prisma/prisma-workflow-provisioning-repository";
import { PrismaWorkflowProvisioningStatusAuthority } from "../infrastructure/prisma/prisma-workflow-provisioning-status-authority";
import { OctokitWorkflowSetupGateway } from "../infrastructure/github/octokit-workflow-setup-gateway";
import {
  createProvisioningPrisma,
  identity,
  record,
} from "./provisioning-prisma-fixture";
import { WorkflowGitHubFixture } from "./workflow-github-fixture";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("workflow attempt artifacts", () => {
  it("opens a new isolated attempt alongside the legacy setup branch", async () => {
    const state = createProvisioningPrisma(null);
    const remote = new WorkflowGitHubFixture();
    const legacyHead = remote.branches.get("main")!;
    remote.branches.set("reviewrouter/setup", legacyHead);
    const attempt = await new PrismaWorkflowProvisioningRepository(
      state.prisma as never,
    ).beginAttempt(record);
    const result = await new OctokitWorkflowSetupGateway(
      remote,
    ).createOrUpdateSetupPullRequest({
      owner: "acme",
      repo: "widget",
      baseBranch: "main",
      setupBranch: attempt.branch,
      workflowFiles: [{ path: record.workflowPath, content: "new workflow" }],
    });
    expect(attempt.branch).toBe(`reviewrouter/setup-${attempt.attemptId}`);
    expect(remote.branches.get("reviewrouter/setup")).toBe(legacyHead);
    expect(remote.branches.get(attempt.branch)).toBe(result.headSha);
    expect(result.headSha).not.toBe(legacyHead);
  });

  it("a paused A cannot overwrite B's branch or configure B from A's PR head", async () => {
    const state = createProvisioningPrisma(null);
    const remote = new WorkflowGitHubFixture();
    const entered = deferred();
    const resume = deferred();
    let paused = false;
    remote.beforeWrite = async () => {
      if (!paused) {
        paused = true;
        entered.resolve();
        await resume.promise;
      }
    };
    const writer = new PrismaWorkflowProvisioningRepository(
      state.prisma as never,
    );
    const provision = (version: string) =>
      provisionReviewRouterWorkflow(
        {
          ...record,
          owner: "acme",
          name: "widget",
          defaultBranch: "main",
          actionRef: `777genius/review-router@${version}`,
          apiUrl: "https://api.reviewrouter.test",
          runtimeConfigMode: "oidc",
          codexRotatingProviderInstanceId: "codex-rotating:123456",
        },
        {
          provisioning: writer,
          setupGateway: new OctokitWorkflowSetupGateway(remote),
        },
      );
    const older = provision("a".repeat(40));
    try {
      await Promise.race([
        entered.promise,
        older.then(() => {
          throw new Error("attempt_completed_before_write_pause");
        }),
      ]);
      const newer = await provision("b".repeat(40));
      const before = { ...state.current()! };
      resume.resolve();
      const stale = await older;
      expect(stale.branch).not.toBe(newer.branch);
      expect(remote.branches.get(newer.branch)).toBe(newer.headSha);
      expect(
        [...remote.commits.get(newer.headSha)!.values()].join("\n"),
      ).toContain(`@${"b".repeat(40)}`);
      expect(state.current()).toEqual(before);
      const authority = new PrismaWorkflowProvisioningStatusAuthority(
        state.prisma as never,
      );
      const merge = {
        ...identity,
        setupBranch: newer.branch,
        pullRequestNumber: newer.number,
        headSha: newer.headSha,
      };
      expect(
        await authority.markConfigured({ ...merge, headSha: stale.headSha }),
      ).toBe(false);
      expect(await authority.markConfigured(merge)).toBe(true);
      expect(state.current()).toMatchObject({
        status: "configured",
        actionVersion: `777genius/review-router@${"b".repeat(40)}`,
        pullRequestHeadSha: newer.headSha,
      });
    } finally {
      resume.resolve();
      await older;
    }
  });

  it.each(["content", "pull_request_head"] as const)(
    "rejects artifact drift at %s",
    async (drift) => {
      const remote = new WorkflowGitHubFixture();
      const request = remote.request.bind(remote);
      const gateway = new OctokitWorkflowSetupGateway({
        async request(route, parameters) {
          const response = await request(route, parameters);
          if (
            drift === "content" &&
            route === "GET /repos/{owner}/{repo}/contents/{path}" &&
            /^[a-f0-9]{40}$/.test(String(parameters?.ref))
          )
            return {
              data: {
                ...(response.data as object),
                content: Buffer.from("unexpected workflow").toString("base64"),
              },
            };
          if (
            drift === "pull_request_head" &&
            route === "POST /repos/{owner}/{repo}/pulls"
          )
            return {
              data: {
                ...(response.data as object),
                head: { sha: "f".repeat(40) },
              },
            };
          return response;
        },
      });
      await expect(
        gateway.createOrUpdateSetupPullRequest({
          owner: "acme",
          repo: "widget",
          baseBranch: "main",
          setupBranch: "reviewrouter/setup/attempt-1",
          workflowFiles: [
            {
              path: ".github/workflows/reviewrouter.yml",
              content: "intended workflow",
            },
          ],
        }),
      ).rejects.toThrow("workflow_provisioning_artifact_mismatch");
      if (drift === "content") expect(remote.pullRequests.size).toBe(0);
    },
  );
});
