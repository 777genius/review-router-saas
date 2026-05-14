import { describe, expect, it } from "vitest";
import { OctokitConflictReviewPostingGateway } from "./octokit-conflict-review-posting-gateway";

type RequestCall = {
  readonly route: string;
  readonly parameters?: Record<string, unknown>;
};

class FakeRequester {
  public readonly calls: RequestCall[] = [];

  constructor(
    private readonly options: {
      readonly pullRequest?: unknown;
      readonly comments?: readonly unknown[];
      readonly statuses?: readonly unknown[];
      readonly patchedComment?: unknown;
      readonly postedComment?: unknown;
      readonly postedStatus?: unknown;
    } = {},
  ) {}

  async request(route: string, parameters?: Record<string, unknown>) {
    this.calls.push(parameters ? { route, parameters } : { route });

    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
      return { data: this.options.pullRequest ?? pullRequest() };
    }
    if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments") {
      return { data: this.options.comments ?? [] };
    }
    if (route === "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}") {
      return {
        data:
          this.options.patchedComment ??
          comment({
            id: Number(parameters?.comment_id ?? 1),
            body: String(parameters?.body ?? ""),
            login: "reviewrouter-test[bot]",
            type: "Bot",
          }),
      };
    }
    if (route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments") {
      return {
        data:
          this.options.postedComment ??
          comment({
            id: 10,
            body: String(parameters?.body ?? ""),
            login: "reviewrouter-test[bot]",
            type: "Bot",
          }),
      };
    }
    if (route === "GET /repos/{owner}/{repo}/commits/{ref}/statuses") {
      return { data: this.options.statuses ?? [] };
    }
    if (route === "POST /repos/{owner}/{repo}/statuses/{sha}") {
      return {
        data:
          this.options.postedStatus ??
          status({
            id: 20,
            context: String(parameters?.context ?? ""),
            description: String(parameters?.description ?? ""),
            state: String(parameters?.state ?? "success"),
            login: "reviewrouter-test[bot]",
          }),
      };
    }

    throw new Error(`unexpected_route:${route}`);
  }
}

function gatewayFor(
  requester: FakeRequester,
): OctokitConflictReviewPostingGateway {
  return new OctokitConflictReviewPostingGateway({
    appSlug: "reviewrouter-test",
    app: {
      getInstallationOctokit(installationId: number) {
        expect(installationId).toBe(129500385);
        return requester;
      },
    },
  });
}

const postingInput = {
  githubInstallationId: "129500385",
  githubRepositoryId: "123456",
  repositoryFullName: "777genius/example",
  pullRequestNumber: 7,
  headSha: "a".repeat(40),
  baseRef: "main",
  baseSha: "b".repeat(40),
  marker:
    "<!-- reviewrouter:conflict-review:v1 dispatch_id=cr_123 manifest_hash=abc -->",
  body: "safe conflict summary",
};

describe("OctokitConflictReviewPostingGateway", () => {
  it("updates only the expected GitHub App bot summary comment", async () => {
    const requester = new FakeRequester({
      comments: [
        comment({
          id: 1,
          body: postingInput.marker,
          login: "maintainer",
          type: "User",
        }),
        comment({
          id: 2,
          body: postingInput.marker,
          login: "other-app[bot]",
          type: "Bot",
        }),
        comment({
          id: 3,
          body: postingInput.marker,
          login: "reviewrouter-test[bot]",
          type: "Bot",
        }),
      ],
    });

    await expect(
      gatewayFor(requester).upsertConflictReviewSummary(postingInput),
    ).resolves.toMatchObject({ githubExternalId: "3" });

    expect(requester.calls.map((call) => call.route)).toEqual([
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
    ]);
    expect(requester.calls[2]?.parameters).toMatchObject({
      comment_id: 3,
      body: postingInput.body,
    });
  });

  it("creates a new summary when copied markers are not owned by the App bot", async () => {
    const requester = new FakeRequester({
      comments: [
        comment({
          id: 1,
          body: postingInput.marker,
          login: "maintainer",
          type: "User",
        }),
        comment({
          id: 2,
          body: postingInput.marker,
          login: "other-app[bot]",
          type: "Bot",
        }),
      ],
    });

    await expect(
      gatewayFor(requester).upsertConflictReviewSummary(postingInput),
    ).resolves.toMatchObject({ githubExternalId: "10" });

    expect(requester.calls.map((call) => call.route)).toEqual([
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
    ]);
  });

  it("fails closed when multiple owned summary markers exist", async () => {
    const requester = new FakeRequester({
      comments: [
        comment({
          id: 1,
          body: postingInput.marker,
          login: "reviewrouter-test[bot]",
          type: "Bot",
        }),
        comment({
          id: 2,
          body: postingInput.marker,
          login: "reviewrouter-test[bot]",
          type: "Bot",
        }),
      ],
    });

    await expect(
      gatewayFor(requester).upsertConflictReviewSummary(postingInput),
    ).rejects.toThrow("conflict_summary_marker_ambiguous");
    expect(requester.calls).toHaveLength(2);
  });

  it("fails closed when summary comment search exhausts its page budget", async () => {
    const requester = new FakeRequester({
      comments: Array.from({ length: 100 }, (_, index) =>
        comment({
          id: index + 1,
          body: "regular discussion",
          login: "maintainer",
          type: "User",
        }),
      ),
    });

    await expect(
      gatewayFor(requester).upsertConflictReviewSummary(postingInput),
    ).rejects.toThrow("conflict_summary_comment_search_budget_exceeded");
    expect(requester.calls.map((call) => call.route)).toEqual([
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
    ]);
  });

  it("rejects summary posting before write when the PR head is stale", async () => {
    const requester = new FakeRequester({
      pullRequest: pullRequest({ headSha: "b".repeat(40) }),
      comments: [
        comment({
          id: 3,
          body: postingInput.marker,
          login: "reviewrouter-test[bot]",
          type: "Bot",
        }),
      ],
    });

    await expect(
      gatewayFor(requester).upsertConflictReviewSummary(postingInput),
    ).rejects.toThrow("conflict_posting_pr_head_mismatch");
    expect(requester.calls.map((call) => call.route)).toEqual([
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
    ]);
  });

  it("rejects summary posting before write when the PR is from a fork", async () => {
    const requester = new FakeRequester({
      pullRequest: pullRequest({ headRepositoryId: 999999 }),
      comments: [
        comment({
          id: 3,
          body: postingInput.marker,
          login: "reviewrouter-test[bot]",
          type: "Bot",
        }),
      ],
    });

    await expect(
      gatewayFor(requester).upsertConflictReviewSummary(postingInput),
    ).rejects.toThrow("conflict_posting_pr_fork_unsupported");
    expect(requester.calls.map((call) => call.route)).toEqual([
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
    ]);
  });

  it("supports a standalone pre-post validation checkpoint without writes", async () => {
    const requester = new FakeRequester();

    await expect(
      gatewayFor(requester).assertConflictReviewPrePostState(postingInput),
    ).resolves.toBeUndefined();

    expect(requester.calls.map((call) => call.route)).toEqual([
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
    ]);
  });

  it("reuses an existing matching advisory status before posting", async () => {
    const requester = new FakeRequester({
      statuses: [
        status({
          id: 44,
          context: "ReviewRouter conflict review",
          description: "Advisory conflict-head review completed.",
          state: "success",
          login: "reviewrouter-test[bot]",
        }),
      ],
    });

    await expect(
      gatewayFor(requester).postConflictReviewAdvisoryStatus({
        githubInstallationId: "129500385",
        githubRepositoryId: "123456",
        repositoryFullName: "777genius/example",
        pullRequestNumber: 7,
        headSha: "a".repeat(40),
        baseRef: "main",
        baseSha: "b".repeat(40),
        context: "ReviewRouter conflict review",
        state: "success",
        description: "Advisory conflict-head review completed.",
      }),
    ).resolves.toEqual({
      githubExternalId: "44",
      githubUrl: "https://api.github.com/repos/777genius/example/statuses/44",
    });

    expect(requester.calls.map((call) => call.route)).toEqual([
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      "GET /repos/{owner}/{repo}/commits/{ref}/statuses",
    ]);
  });

  it("posts advisory status to the expected head when no owned match exists", async () => {
    const requester = new FakeRequester({
      statuses: [],
    });

    await expect(
      gatewayFor(requester).postConflictReviewAdvisoryStatus({
        githubInstallationId: "129500385",
        githubRepositoryId: "123456",
        repositoryFullName: "777genius/example",
        pullRequestNumber: 7,
        headSha: "a".repeat(40),
        baseRef: "main",
        baseSha: "b".repeat(40),
        context: "ReviewRouter conflict review",
        state: "success",
        description: "Advisory conflict-head review completed.",
      }),
    ).resolves.toMatchObject({ githubExternalId: "20" });

    expect(requester.calls.map((call) => call.route)).toEqual([
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      "GET /repos/{owner}/{repo}/commits/{ref}/statuses",
      "POST /repos/{owner}/{repo}/statuses/{sha}",
    ]);
    expect(requester.calls[2]?.parameters).toMatchObject({
      sha: "a".repeat(40),
      context: "ReviewRouter conflict review",
      state: "success",
    });
  });

  it("requires a strict App bot identity for idempotent writes", () => {
    expect(
      () =>
        new OctokitConflictReviewPostingGateway({
          app: { getInstallationOctokit: () => new FakeRequester() },
        }),
    ).toThrow("conflict_posting_bot_identity_unavailable");
  });
});

function pullRequest(
  overrides: {
    readonly repositoryId?: number | string;
    readonly headRepositoryId?: number | string;
    readonly state?: string;
    readonly draft?: boolean;
    readonly merged?: boolean;
    readonly headSha?: string;
    readonly baseRef?: string;
    readonly baseSha?: string;
  } = {},
): unknown {
  return {
    state: overrides.state ?? "open",
    draft: overrides.draft ?? false,
    merged: overrides.merged ?? false,
    head: {
      sha: overrides.headSha ?? "a".repeat(40),
      repo: {
        id: overrides.headRepositoryId ?? overrides.repositoryId ?? 123456,
      },
    },
    base: {
      ref: overrides.baseRef ?? "main",
      sha: overrides.baseSha ?? "b".repeat(40),
      repo: { id: overrides.repositoryId ?? 123456 },
    },
  };
}

function comment(input: {
  readonly id: number;
  readonly body: string;
  readonly login: string;
  readonly type: "Bot" | "User";
}): unknown {
  return {
    id: input.id,
    html_url: `https://github.com/777genius/example/issues/7#issuecomment-${input.id}`,
    body: input.body,
    user: {
      login: input.login,
      type: input.type,
    },
  };
}

function status(input: {
  readonly id: number;
  readonly context: string;
  readonly description: string;
  readonly state: string;
  readonly login: string;
}): unknown {
  return {
    id: input.id,
    url: `https://api.github.com/repos/777genius/example/statuses/${input.id}`,
    context: input.context,
    description: input.description,
    state: input.state,
    creator: {
      login: input.login,
    },
  };
}
