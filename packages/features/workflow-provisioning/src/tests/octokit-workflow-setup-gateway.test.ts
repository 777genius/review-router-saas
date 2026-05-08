import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { OctokitWorkflowSetupGateway } from "../infrastructure/github/octokit-workflow-setup-gateway";

type RequestCall = {
  readonly route: string;
  readonly parameters?: Record<string, unknown>;
};

class FakeRequester {
  public readonly calls: RequestCall[] = [];
  private contentReadCount = 0;
  private pullReadCount = 0;
  private putFailureConsumed = false;
  private postPullFailureConsumed = false;

  constructor(
    private readonly existingWorkflowYaml:
      | string
      | null
      | readonly (string | null)[],
    private readonly options: {
      readonly pullRequestResponses?: readonly (readonly {
        readonly html_url: string;
        readonly number: number;
      }[])[];
      readonly postPullRequest?: {
        readonly html_url: string;
        readonly number: number;
      };
      readonly failPutOnceStatus?: number;
      readonly failPostPullOnceStatus?: number;
    } = {},
  ) {}

  async request(route: string, parameters?: Record<string, unknown>) {
    this.calls.push(parameters ? { route, parameters } : { route });

    if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
      return { data: { object: { sha: "base-sha" } } };
    }
    if (route === "POST /repos/{owner}/{repo}/git/refs") {
      return { data: {} };
    }
    if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
      const existingWorkflowYaml = this.nextExistingWorkflowYaml();
      if (existingWorkflowYaml === null) {
        throw Object.assign(new Error("not found"), { status: 404 });
      }
      return {
        data: {
          type: "file",
          sha: "workflow-sha",
          encoding: "base64",
          content: Buffer.from(existingWorkflowYaml).toString("base64"),
        },
      };
    }
    if (route === "PUT /repos/{owner}/{repo}/contents/{path}") {
      if (this.options.failPutOnceStatus && this.putFailureConsumed === false) {
        this.putFailureConsumed = true;
        throw Object.assign(new Error("write conflict"), {
          status: this.options.failPutOnceStatus,
        });
      }
      return { data: {} };
    }
    if (route === "GET /repos/{owner}/{repo}/pulls") {
      return {
        data: this.nextPullRequestResponse(),
      };
    }
    if (route === "POST /repos/{owner}/{repo}/pulls") {
      if (
        this.options.failPostPullOnceStatus &&
        this.postPullFailureConsumed === false
      ) {
        this.postPullFailureConsumed = true;
        throw Object.assign(new Error("pull request already exists"), {
          status: this.options.failPostPullOnceStatus,
        });
      }
      return {
        data: this.options.postPullRequest ?? {
          html_url: "https://github.com/777genius/example/pull/11",
          number: 11,
        },
      };
    }
    if (route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}") {
      const pullNumber = Number(parameters?.pull_number ?? 10);
      return {
        data: {
          html_url: `https://github.com/777genius/example/pull/${pullNumber}`,
          number: pullNumber,
        },
      };
    }

    throw new Error(`unexpected_route:${route}`);
  }

  private nextExistingWorkflowYaml(): string | null {
    const values = this.existingWorkflowYaml;
    if (typeof values === "string" || values === null) {
      return values;
    }
    const index = Math.min(this.contentReadCount, values.length - 1);
    this.contentReadCount += 1;
    return values[index] ?? null;
  }

  private nextPullRequestResponse(): readonly {
    readonly html_url: string;
    readonly number: number;
  }[] {
    const responses = this.options.pullRequestResponses;
    if (!responses) {
      return [
        {
          html_url: "https://github.com/777genius/example/pull/10",
          number: 10,
        },
      ];
    }
    const index = Math.min(this.pullReadCount, responses.length - 1);
    this.pullReadCount += 1;
    return responses[index] ?? [];
  }
}

const setupInput = {
  owner: "777genius",
  repo: "example",
  baseBranch: "main",
  setupBranch: "reviewrouter/setup",
  workflowFiles: [
    {
      path: ".github/workflows/reviewrouter.yml",
      content: "name: ReviewRouter\n",
    },
  ],
};
const primaryWorkflow = setupInput.workflowFiles[0]!;

describe("OctokitWorkflowSetupGateway", () => {
  it("does not rewrite an identical workflow on the setup branch", async () => {
    const requester = new FakeRequester(primaryWorkflow.content);
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
      content: Buffer.from(primaryWorkflow.content).toString("base64"),
    });
  });

  it("refreshes existing setup pull request title and body", async () => {
    const requester = new FakeRequester(primaryWorkflow.content);
    const gateway = new OctokitWorkflowSetupGateway(requester);

    await gateway.createOrUpdateSetupPullRequest(setupInput);

    const patchCall = requester.calls.find(
      (call) => call.route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
    );
    expect(patchCall?.parameters).toMatchObject({
      pull_number: 10,
      title: "chore: add ReviewRouter workflow",
    });
    expect(String(patchCall?.parameters?.body)).toContain(
      "compact mode keeps small caller workflows",
    );
  });

  it("re-reads workflow content once when GitHub reports a write conflict", async () => {
    const requester = new FakeRequester([null, primaryWorkflow.content], {
      failPutOnceStatus: 409,
    });
    const gateway = new OctokitWorkflowSetupGateway(requester);

    await expect(
      gateway.createOrUpdateSetupPullRequest(setupInput),
    ).resolves.toMatchObject({ number: 10 });

    expect(
      requester.calls.filter(
        (call) => call.route === "GET /repos/{owner}/{repo}/contents/{path}",
      ),
    ).toHaveLength(2);
    expect(
      requester.calls.filter(
        (call) => call.route === "PUT /repos/{owner}/{repo}/contents/{path}",
      ),
    ).toHaveLength(1);
  });

  it("re-reads open setup PRs when pull request creation races", async () => {
    const requester = new FakeRequester(primaryWorkflow.content, {
      pullRequestResponses: [
        [],
        [
          {
            html_url: "https://github.com/777genius/example/pull/12",
            number: 12,
          },
        ],
      ],
      failPostPullOnceStatus: 422,
    });
    const gateway = new OctokitWorkflowSetupGateway(requester);

    await expect(
      gateway.createOrUpdateSetupPullRequest(setupInput),
    ).resolves.toMatchObject({
      number: 12,
      url: "https://github.com/777genius/example/pull/12",
    });

    expect(
      requester.calls.filter(
        (call) => call.route === "GET /repos/{owner}/{repo}/pulls",
      ),
    ).toHaveLength(2);
    expect(
      requester.calls.filter(
        (call) => call.route === "POST /repos/{owner}/{repo}/pulls",
      ),
    ).toHaveLength(1);
  });

  it("writes every workflow file into the setup branch", async () => {
    const requester = new FakeRequester(null);
    const gateway = new OctokitWorkflowSetupGateway(requester);

    await gateway.createOrUpdateSetupPullRequest({
      ...setupInput,
      workflowFiles: [
        ...setupInput.workflowFiles,
        {
          path: ".github/workflows/reviewrouter-interaction.yml",
          content: "name: ReviewRouter Interaction\n",
        },
      ],
    });

    const putCalls = requester.calls.filter(
      (call) => call.route === "PUT /repos/{owner}/{repo}/contents/{path}",
    );
    expect(putCalls.map((call) => call.parameters?.path)).toEqual([
      ".github/workflows/reviewrouter.yml",
      ".github/workflows/reviewrouter-interaction.yml",
    ]);
  });
});
