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

  it("re-reads workflow content once when GitHub reports a write conflict", async () => {
    const requester = new FakeRequester([null, setupInput.workflowYaml], {
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
    const requester = new FakeRequester(setupInput.workflowYaml, {
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
});
