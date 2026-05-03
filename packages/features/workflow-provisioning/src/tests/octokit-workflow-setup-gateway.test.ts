import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { OctokitWorkflowSetupGateway } from "../infrastructure/github/octokit-workflow-setup-gateway";

type RequestCall = {
  readonly route: string;
  readonly parameters?: Record<string, unknown>;
};

class FakeRequester {
  public readonly calls: RequestCall[] = [];

  constructor(private readonly existingWorkflowYaml: string | null) {}

  async request(route: string, parameters?: Record<string, unknown>) {
    this.calls.push(parameters ? { route, parameters } : { route });

    if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
      return { data: { object: { sha: "base-sha" } } };
    }
    if (route === "POST /repos/{owner}/{repo}/git/refs") {
      return { data: {} };
    }
    if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
      if (this.existingWorkflowYaml === null) {
        throw Object.assign(new Error("not found"), { status: 404 });
      }
      return {
        data: {
          type: "file",
          sha: "workflow-sha",
          encoding: "base64",
          content: Buffer.from(this.existingWorkflowYaml).toString("base64"),
        },
      };
    }
    if (route === "PUT /repos/{owner}/{repo}/contents/{path}") {
      return { data: {} };
    }
    if (route === "GET /repos/{owner}/{repo}/pulls") {
      return {
        data: [
          {
            html_url: "https://github.com/777genius/example/pull/10",
            number: 10,
          },
        ],
      };
    }

    throw new Error(`unexpected_route:${route}`);
  }
}

const setupInput = {
  owner: "777genius",
  repo: "example",
  baseBranch: "main",
  setupBranch: "reviewrouter/setup",
  workflowPath: ".github/workflows/reviewrouter.yml",
  workflowYaml: "name: ReviewRouter\n",
};

describe("OctokitWorkflowSetupGateway", () => {
  it("does not rewrite an identical workflow on the setup branch", async () => {
    const requester = new FakeRequester(setupInput.workflowYaml);
    const gateway = new OctokitWorkflowSetupGateway(requester);

    await expect(
      gateway.createOrUpdateSetupPullRequest(setupInput),
    ).resolves.toMatchObject({ number: 10 });

    expect(requester.calls.map((call) => call.route)).not.toContain(
      "PUT /repos/{owner}/{repo}/contents/{path}",
    );
  });

  it("updates the workflow file when content differs", async () => {
    const requester = new FakeRequester("name: Old\n");
    const gateway = new OctokitWorkflowSetupGateway(requester);

    await gateway.createOrUpdateSetupPullRequest(setupInput);

    const putCall = requester.calls.find(
      (call) => call.route === "PUT /repos/{owner}/{repo}/contents/{path}",
    );
    expect(putCall?.parameters).toMatchObject({
      branch: "reviewrouter/setup",
      sha: "workflow-sha",
      content: Buffer.from(setupInput.workflowYaml).toString("base64"),
    });
  });
});
