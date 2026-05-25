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
  private reopenFailureConsumed = false;

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
      readonly closedPullRequestResponses?: readonly (readonly {
        readonly html_url: string;
        readonly number: number;
        readonly merged_at?: string | null;
      }[])[];
      readonly postPullRequest?: {
        readonly html_url: string;
        readonly number: number;
      };
      readonly failPutOnceStatus?: number;
      readonly failPostPullOnceStatus?: number;
      readonly failReopenOnceStatus?: number;
      readonly existingBranches?: readonly string[];
    } = {},
  ) {}

  async request(route: string, parameters?: Record<string, unknown>) {
    this.calls.push(parameters ? { route, parameters } : { route });

    if (route === "GET /repos/{owner}/{repo}/git/ref/{ref}") {
      const branch = String(parameters?.ref ?? "").replace(/^heads\//, "");
      const existingBranches = this.options.existingBranches ?? ["main"];
      if (!existingBranches.includes(branch)) {
        throw Object.assign(new Error("not found"), { status: 404 });
      }
      return { data: { object: { sha: `${branch}-sha` } } };
    }
    if (route === "POST /repos/{owner}/{repo}/git/refs") {
      const branch = String(parameters?.ref ?? "").replace(
        /^refs\/heads\//,
        "",
      );
      const existingBranches = this.options.existingBranches ?? ["main"];
      if (existingBranches.includes(branch)) {
        throw Object.assign(new Error("reference already exists"), {
          status: 422,
        });
      }
      return { data: {} };
    }
    if (route === "PATCH /repos/{owner}/{repo}/git/refs/{ref}") {
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
    if (route === "DELETE /repos/{owner}/{repo}/contents/{path}") {
      return { data: {} };
    }
    if (route === "GET /repos/{owner}/{repo}/pulls") {
      return {
        data:
          parameters?.state === "closed"
            ? this.nextClosedPullRequestResponse()
            : this.nextPullRequestResponse(),
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
      if (
        parameters?.state === "open" &&
        this.options.failReopenOnceStatus &&
        this.reopenFailureConsumed === false
      ) {
        this.reopenFailureConsumed = true;
        throw Object.assign(
          new Error("state cannot be changed after branch recreation"),
          { status: this.options.failReopenOnceStatus },
        );
      }
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

  private nextClosedPullRequestResponse(): readonly {
    readonly html_url: string;
    readonly number: number;
    readonly merged_at?: string | null;
  }[] {
    return this.options.closedPullRequestResponses?.[0] ?? [];
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

  it("deletes a legacy ReviewRouter workflow only when trusted markers match", async () => {
    const requester = new FakeRequester(
      "name: ReviewRouter\njobs:\n  review:\n    uses: 777genius/review-router/.github/workflows/reviewrouter-reusable.yml@v1\n",
    );
    const gateway = new OctokitWorkflowSetupGateway(requester);

    await gateway.createOrUpdateSetupPullRequest({
      ...setupInput,
      workflowFiles: [
        {
          path: ".github/workflows/reviewrouter.yml",
          operation: "delete",
          markerGroups: [
            [
              "name: ReviewRouter",
              "777genius/review-router/.github/workflows/reviewrouter-reusable.yml",
            ],
          ],
        },
      ],
    });

    const deleteCall = requester.calls.find(
      (call) => call.route === "DELETE /repos/{owner}/{repo}/contents/{path}",
    );
    expect(deleteCall?.parameters).toMatchObject({
      path: ".github/workflows/reviewrouter.yml",
      branch: "reviewrouter/setup",
      sha: "workflow-sha",
      message: "chore: remove legacy ReviewRouter workflow",
    });
  });

  it("blocks deleting an unrecognized workflow at a legacy ReviewRouter path", async () => {
    const requester = new FakeRequester("name: Custom CI\n");
    const gateway = new OctokitWorkflowSetupGateway(requester);

    await expect(
      gateway.createOrUpdateSetupPullRequest({
        ...setupInput,
        workflowFiles: [
          {
            path: ".github/workflows/reviewrouter.yml",
            operation: "delete",
            markerGroups: [["name: ReviewRouter"]],
          },
        ],
      }),
    ).rejects.toThrow(
      "workflow_delete_untrusted:.github/workflows/reviewrouter.yml",
    );

    expect(requester.calls.map((call) => call.route)).not.toContain(
      "DELETE /repos/{owner}/{repo}/contents/{path}",
    );
  });

  it("refreshes existing setup pull request title and body", async () => {
    const requester = new FakeRequester(primaryWorkflow.content);
    const gateway = new OctokitWorkflowSetupGateway(requester);

    await gateway.createOrUpdateSetupPullRequest(setupInput);

    const patchCall = requester.calls.find(
      (call) =>
        call.route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
    );
    expect(patchCall?.parameters).toMatchObject({
      pull_number: 10,
      title: "chore: add ReviewRouter workflow",
      base: "main",
    });
    expect(String(patchCall?.parameters?.body)).toContain(
      "compact mode keeps small caller workflows",
    );
  });

  it("reopens a closed setup pull request before creating a new one", async () => {
    const requester = new FakeRequester(primaryWorkflow.content, {
      pullRequestResponses: [[]],
      closedPullRequestResponses: [
        [
          {
            html_url: "https://github.com/777genius/example/pull/14",
            number: 14,
          },
        ],
      ],
    });
    const gateway = new OctokitWorkflowSetupGateway(requester);

    await expect(
      gateway.createOrUpdateSetupPullRequest(setupInput),
    ).resolves.toMatchObject({
      number: 14,
      url: "https://github.com/777genius/example/pull/14",
    });

    expect(
      requester.calls.map((call) => [call.route, call.parameters?.state]),
    ).toContainEqual(["GET /repos/{owner}/{repo}/pulls", "closed"]);
    expect(
      requester.calls.find(
        (call) =>
          call.route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
      )?.parameters,
    ).toMatchObject({
      pull_number: 14,
      state: "open",
      title: "chore: add ReviewRouter workflow",
    });
    expect(requester.calls.map((call) => call.route)).not.toContain(
      "POST /repos/{owner}/{repo}/pulls",
    );
  });

  it("resets a stale setup branch before reopening a closed setup pull request", async () => {
    const requester = new FakeRequester(null, {
      existingBranches: ["main", "reviewrouter/setup"],
      pullRequestResponses: [[]],
      closedPullRequestResponses: [
        [
          {
            html_url: "https://github.com/777genius/example/pull/14",
            number: 14,
          },
        ],
      ],
    });
    const gateway = new OctokitWorkflowSetupGateway(requester);

    await expect(
      gateway.createOrUpdateSetupPullRequest(setupInput),
    ).resolves.toMatchObject({
      number: 14,
      url: "https://github.com/777genius/example/pull/14",
    });

    const resetCall = requester.calls.find(
      (call) => call.route === "PATCH /repos/{owner}/{repo}/git/refs/{ref}",
    );
    expect(resetCall?.parameters).toMatchObject({
      ref: "heads/reviewrouter/setup",
      sha: "main-sha",
      force: true,
    });
    expect(
      requester.calls.findIndex(
        (call) => call.route === "PATCH /repos/{owner}/{repo}/git/refs/{ref}",
      ),
    ).toBeLessThan(
      requester.calls.findIndex(
        (call) => call.route === "PUT /repos/{owner}/{repo}/contents/{path}",
      ),
    );
    expect(
      requester.calls.find(
        (call) =>
          call.route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
      )?.parameters,
    ).toMatchObject({
      pull_number: 14,
      state: "open",
    });
  });

  it("creates a new setup pull request when a recreated branch prevents reopening a closed one", async () => {
    const requester = new FakeRequester(primaryWorkflow.content, {
      pullRequestResponses: [[]],
      closedPullRequestResponses: [
        [
          {
            html_url: "https://github.com/777genius/example/pull/14",
            number: 14,
          },
        ],
      ],
      failReopenOnceStatus: 422,
      postPullRequest: {
        html_url: "https://github.com/777genius/example/pull/15",
        number: 15,
      },
    });
    const gateway = new OctokitWorkflowSetupGateway(requester);

    await expect(
      gateway.createOrUpdateSetupPullRequest(setupInput),
    ).resolves.toMatchObject({
      number: 15,
      url: "https://github.com/777genius/example/pull/15",
    });

    expect(requester.calls.map((call) => call.route)).toContain(
      "POST /repos/{owner}/{repo}/pulls",
    );
  });

  it("keeps an existing setup branch when an open setup pull request exists", async () => {
    const requester = new FakeRequester(null, {
      existingBranches: ["main", "reviewrouter/setup"],
      pullRequestResponses: [
        [
          {
            html_url: "https://github.com/777genius/example/pull/10",
            number: 10,
          },
        ],
      ],
    });
    const gateway = new OctokitWorkflowSetupGateway(requester);

    await expect(
      gateway.createOrUpdateSetupPullRequest(setupInput),
    ).resolves.toMatchObject({ number: 10 });

    expect(requester.calls.map((call) => call.route)).not.toContain(
      "PATCH /repos/{owner}/{repo}/git/refs/{ref}",
    );
    expect(
      requester.calls.find(
        (call) =>
          call.route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
      )?.parameters,
    ).toMatchObject({
      pull_number: 10,
      title: "chore: add ReviewRouter workflow",
    });
  });

  it("does not try to reopen an already merged setup pull request", async () => {
    const requester = new FakeRequester(primaryWorkflow.content, {
      pullRequestResponses: [[]],
      closedPullRequestResponses: [
        [
          {
            html_url: "https://github.com/777genius/example/pull/14",
            number: 14,
            merged_at: "2026-05-13T12:00:00Z",
          },
        ],
      ],
      postPullRequest: {
        html_url: "https://github.com/777genius/example/pull/15",
        number: 15,
      },
    });
    const gateway = new OctokitWorkflowSetupGateway(requester);

    await expect(
      gateway.createOrUpdateSetupPullRequest(setupInput),
    ).resolves.toMatchObject({
      number: 15,
      url: "https://github.com/777genius/example/pull/15",
    });

    expect(requester.calls.map((call) => call.route)).toContain(
      "POST /repos/{owner}/{repo}/pulls",
    );
    expect(requester.calls.map((call) => call.route)).not.toContain(
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
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
        (call) =>
          call.route === "GET /repos/{owner}/{repo}/pulls" &&
          call.parameters?.state === "open",
      ),
    ).toHaveLength(2);
    expect(
      requester.calls.filter(
        (call) => call.route === "POST /repos/{owner}/{repo}/pulls",
      ),
    ).toHaveLength(1);
  });

  it("prefers dev over develop and the repository default branch for setup PRs", async () => {
    const requester = new FakeRequester(null, {
      existingBranches: ["main", "develop", "dev"],
      pullRequestResponses: [[]],
    });
    const gateway = new OctokitWorkflowSetupGateway(requester);

    await gateway.createOrUpdateSetupPullRequest(setupInput);

    const createdRefCall = requester.calls.find(
      (call) => call.route === "POST /repos/{owner}/{repo}/git/refs",
    );
    expect(createdRefCall?.parameters).toMatchObject({ sha: "dev-sha" });

    const postPullCall = requester.calls.find(
      (call) => call.route === "POST /repos/{owner}/{repo}/pulls",
    );
    expect(postPullCall?.parameters).toMatchObject({ base: "dev" });
  });

  it("falls back to develop before the repository default branch", async () => {
    const requester = new FakeRequester(null, {
      existingBranches: ["main", "develop"],
      pullRequestResponses: [[]],
    });
    const gateway = new OctokitWorkflowSetupGateway(requester);

    await gateway.createOrUpdateSetupPullRequest(setupInput);

    const createdRefCall = requester.calls.find(
      (call) => call.route === "POST /repos/{owner}/{repo}/git/refs",
    );
    expect(createdRefCall?.parameters).toMatchObject({ sha: "develop-sha" });

    const postPullCall = requester.calls.find(
      (call) => call.route === "POST /repos/{owner}/{repo}/pulls",
    );
    expect(postPullCall?.parameters).toMatchObject({ base: "develop" });
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
