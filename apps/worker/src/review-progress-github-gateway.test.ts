import { describe, expect, it, vi } from "vitest";
import {
  ReviewProgressGitHubError,
  ReviewProgressGitHubGateway,
  createReviewProgressMarker,
  formatReviewProgressComment,
  type ReviewProgressGitHubRequester,
} from "./review-progress-github-gateway";

const head = "a".repeat(40);
const marker = createReviewProgressMarker("review-42");

describe("ReviewProgressGitHubGateway", () => {
  it("formats exactly one stable marker", () => {
    expect(
      formatReviewProgressComment(`working\n${marker}\n${marker}`, marker),
    ).toBe(`working\n\n${marker}`);
  });

  it("patches the existing marked comment", async () => {
    const fixture = githubFixture([{ id: 8, body: `old\n${marker}` }]);

    await expect(gateway(fixture.request).upsert(input())).resolves.toEqual({
      commentId: 8,
      operation: "updated",
      duplicateCommentIds: [],
    });
    expect(fixture.calls).toContainEqual({
      route: "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
      parameters: expect.objectContaining({
        comment_id: 8,
        body: `working\n\n${marker}`,
      }),
    });
  });

  it("creates a comment when the marker does not exist", async () => {
    const fixture = githubFixture([]);

    await expect(gateway(fixture.request).upsert(input())).resolves.toEqual({
      commentId: 100,
      operation: "created",
      duplicateCommentIds: [],
    });
    expect(fixture.calls.at(-1)).toEqual({
      route: "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      parameters: expect.objectContaining({
        issue_number: 42,
        body: `working\n\n${marker}`,
      }),
    });
  });

  it("reconciles a timed-out POST when the marked comment appeared", async () => {
    const fixture = githubFixture([], { throwAfterPost: true });

    await expect(gateway(fixture.request).upsert(input())).resolves.toEqual({
      commentId: 100,
      operation: "reconciled",
      duplicateCommentIds: [],
    });
    expect(
      fixture.calls.filter(({ route }) => route.startsWith("GET ")),
    ).toHaveLength(4);
  });

  it("reconciles a timed-out PATCH when the marked comment was updated", async () => {
    const fixture = githubFixture([{ id: 8, body: `old\n${marker}` }], {
      throwAfterPatch: true,
    });

    await expect(gateway(fixture.request).upsert(input())).resolves.toEqual({
      commentId: 8,
      operation: "reconciled",
      duplicateCommentIds: [],
    });
  });

  it("patches only the canonical comment and defers every duplicate", async () => {
    const fixture = githubFixture(
      [
        { id: 9, body: `later\n${marker}` },
        { id: 4, body: `first\n${marker}` },
        { id: 7, body: `middle\n${marker}` },
      ],
      { deleteFailureId: 9 },
    );

    await expect(gateway(fixture.request).upsert(input())).resolves.toEqual({
      commentId: 4,
      operation: "updated",
      duplicateCommentIds: [7, 9],
    });
    expect(mutations(fixture.calls)).toEqual([
      expect.objectContaining({
        route: "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
        parameters: expect.objectContaining({ comment_id: 4 }),
      }),
    ]);
  });

  it("deletes exactly one duplicate when the canonical body is already desired", async () => {
    const desired = formatReviewProgressComment("working", marker);
    const fixture = githubFixture([
      { id: 4, body: desired },
      { id: 7, body: `duplicate one\n${marker}` },
      { id: 9, body: `duplicate two\n${marker}` },
    ]);

    await expect(gateway(fixture.request).upsert(input())).resolves.toEqual({
      commentId: 4,
      operation: "duplicate_deleted",
      duplicateCommentIds: [9],
    });
    expect(mutations(fixture.calls)).toEqual([
      expect.objectContaining({
        route: "DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}",
        parameters: expect.objectContaining({ comment_id: 7 }),
      }),
    ]);
  });

  it("performs no mutation when the canonical body is desired and unique", async () => {
    const fixture = githubFixture([
      { id: 4, body: formatReviewProgressComment("working", marker) },
    ]);

    await expect(gateway(fixture.request).upsert(input())).resolves.toEqual({
      commentId: 4,
      operation: "unchanged",
      duplicateCommentIds: [],
    });
    expect(mutations(fixture.calls)).toEqual([]);
  });

  it("does not clean up duplicates while reconciling an ambiguous PATCH", async () => {
    const fixture = githubFixture(
      [
        { id: 4, body: `old\n${marker}` },
        { id: 7, body: `duplicate\n${marker}` },
      ],
      { throwAfterPatch: true },
    );

    await expect(gateway(fixture.request).upsert(input())).resolves.toEqual({
      commentId: 4,
      operation: "reconciled",
      duplicateCommentIds: [7],
    });
    expect(mutations(fixture.calls).map(({ route }) => route)).toEqual([
      "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
    ]);
  });

  it("ignores a spoofed marker from another user", async () => {
    const fixture = githubFixture([
      { id: 3, body: `spoof\n${marker}`, authorLogin: "mallory" },
    ]);

    await expect(
      gateway(fixture.request).upsert(input()),
    ).resolves.toMatchObject({
      commentId: 100,
      operation: "created",
    });
    expect(
      fixture.calls.some(
        ({ route, parameters }) =>
          route.startsWith("PATCH ") && parameters.comment_id === 3,
      ),
    ).toBe(false);
    expect(fixture.calls.some(({ route }) => route.startsWith("DELETE "))).toBe(
      false,
    );
  });

  it("refuses to POST when the bounded scan is inconclusive", async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      body: "unrelated",
    }));
    const fixture = githubFixture(fullPage);

    await expect(
      gateway(fixture.request, { maxCommentPages: 1 }).upsert(input()),
    ).rejects.toMatchObject({
      kind: "pagination_inconclusive",
      metadata: { retryable: true },
    });
    expect(fixture.calls.some(({ route }) => route.startsWith("POST "))).toBe(
      false,
    );
  });

  it("recovers the persisted known comment id before relying on the bounded scan", async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      body: "unrelated",
    }));
    const fixture = githubFixture(
      [...fullPage, { id: 900, body: `known\n${marker}` }],
      { listedComments: fullPage },
    );

    await expect(
      gateway(fixture.request, { maxCommentPages: 1 }).upsert({
        ...input(),
        knownCommentId: 900,
      }),
    ).resolves.toMatchObject({ commentId: 900, operation: "updated" });
    expect(
      fixture.calls.some(
        ({ route, parameters }) =>
          route === "GET /repos/{owner}/{repo}/issues/comments/{comment_id}" &&
          parameters.comment_id === 900,
      ),
    ).toBe(true);
    expect(fixture.calls.some(({ route }) => route.startsWith("POST "))).toBe(
      false,
    );
  });

  it("rechecks the PR head after discovery and before mutation", async () => {
    const fixture = githubFixture([], { staleHeadAfterFirstRead: true });

    await expect(
      gateway(fixture.request).upsert(input()),
    ).rejects.toMatchObject({
      kind: "stale_head",
    });
    expect(fixture.calls.some(({ route }) => route.startsWith("POST "))).toBe(
      false,
    );
  });

  it("rejects a stale head before listing or mutating comments", async () => {
    const fixture = githubFixture([], { currentHead: "b".repeat(40) });

    await expect(
      gateway(fixture.request).upsert(input()),
    ).rejects.toMatchObject({
      kind: "stale_head",
      metadata: { retryable: false },
    });
    expect(fixture.calls).toHaveLength(1);
  });

  it("rejects a closed PR before listing or mutating comments", async () => {
    const fixture = githubFixture([], { currentState: "closed" });

    await expect(
      gateway(fixture.request).upsert(input()),
    ).rejects.toMatchObject({
      kind: "stale_head",
      message: "github_pull_request_not_open",
      metadata: { retryable: false },
    });
    expect(fixture.calls).toHaveLength(1);
  });

  it("classifies revoked GitHub App access as terminal", async () => {
    const request: ReviewProgressGitHubRequester = vi.fn(async () => {
      throw { status: 403, response: { headers: {} } };
    });

    await expect(gateway(request).upsert(input())).rejects.toMatchObject({
      kind: "revoked_app",
      metadata: { status: 403, retryable: false },
    });
  });

  it.each([
    {
      name: "Retry-After",
      error: { status: 429, response: { headers: { "retry-after": "10" } } },
      boundary: "2026-08-12T12:00:10.000Z",
    },
    {
      name: "x-ratelimit-reset",
      error: {
        status: 403,
        response: {
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(
              Date.parse("2026-08-12T12:00:20.000Z") / 1_000,
            ),
          },
        },
      },
      boundary: "2026-08-12T12:00:20.000Z",
    },
  ])(
    "classifies rate limits from $name with jitter-safe metadata",
    async ({ error, boundary }) => {
      const request: ReviewProgressGitHubRequester = vi.fn(async () => {
        throw error;
      });
      const operation = gateway(request, {
        now: () => new Date("2026-08-12T12:00:00.000Z"),
        random: () => 0,
      }).upsert(input());

      const caught = await operation.catch((value: unknown) => value);
      expect(caught).toBeInstanceOf(ReviewProgressGitHubError);
      expect(caught).toMatchObject({
        kind: "rate_limited",
        metadata: { retryable: true, retryNotBefore: new Date(boundary) },
      });
      expect(
        (caught as ReviewProgressGitHubError).metadata.retryAt!.getTime(),
      ).toBeGreaterThanOrEqual(Date.parse(boundary));
    },
  );

  it("classifies GitHub 5xx as retryable without sleeping", async () => {
    const request: ReviewProgressGitHubRequester = vi.fn(async () => {
      throw { status: 503, headers: { "retry-after": "2" } };
    });
    const caught = await gateway(request, {
      now: () => new Date("2026-08-12T12:00:00.000Z"),
      random: () => 1,
    })
      .upsert(input())
      .catch((value: unknown) => value);

    expect(caught).toMatchObject({
      kind: "github_unavailable",
      metadata: {
        status: 503,
        retryable: true,
        retryNotBefore: new Date("2026-08-12T12:00:02.000Z"),
      },
    });
  });
});

function input() {
  return {
    owner: "acme",
    repo: "rocket",
    pullNumber: 42,
    expectedHeadSha: head,
    expectedBotLogin: "review-router[bot]",
    marker,
    body: "working",
  } as const;
}

function gateway(
  request: ReviewProgressGitHubRequester,
  options: ConstructorParameters<typeof ReviewProgressGitHubGateway>[1] = {},
) {
  return new ReviewProgressGitHubGateway(request, options);
}

function githubFixture(
  initialComments: Array<{ id: number; body: string; authorLogin?: string }>,
  options: {
    readonly currentHead?: string;
    readonly currentState?: string;
    readonly throwAfterPost?: boolean;
    readonly throwAfterPatch?: boolean;
    readonly deleteFailureId?: number;
    readonly listedComments?: Array<{
      id: number;
      body: string;
      authorLogin?: string;
    }>;
    readonly staleHeadAfterFirstRead?: boolean;
  } = {},
) {
  const comments = initialComments.map(toStoredComment);
  let pullReads = 0;
  const calls: Array<{
    route: string;
    parameters: Readonly<Record<string, unknown>>;
  }> = [];
  const request: ReviewProgressGitHubRequester = async (
    route,
    parameters = {},
  ) => {
    calls.push({ route, parameters });
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
      pullReads += 1;
      return {
        data: {
          state: options.currentState ?? "open",
          head: {
            sha:
              options.staleHeadAfterFirstRead && pullReads > 1
                ? "b".repeat(40)
                : (options.currentHead ?? head),
          },
          base: { repo: { full_name: "acme/rocket" } },
        },
      };
    }
    if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments") {
      return {
        data: (options.listedComments?.map(toStoredComment) ?? comments).map(
          toResponseComment,
        ),
      };
    }
    if (route === "GET /repos/{owner}/{repo}/issues/comments/{comment_id}") {
      const comment = comments.find(({ id }) => id === parameters.comment_id);
      if (!comment) throw { status: 404 };
      return { data: toResponseComment(comment) };
    }
    if (route === "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}") {
      const comment = comments.find(({ id }) => id === parameters.comment_id)!;
      comment.body = parameters.body as string;
      if (options.throwAfterPatch) throw new Error("socket_closed_after_write");
      return { data: toResponseComment(comment) };
    }
    if (route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments") {
      const created = {
        id: 100,
        body: parameters.body as string,
        authorLogin: "review-router[bot]",
      };
      comments.push(created);
      if (options.throwAfterPost) throw new Error("socket_closed_after_write");
      return { data: toResponseComment(created) };
    }
    if (route === "DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}") {
      if (parameters.comment_id === options.deleteFailureId)
        throw new Error("delete_failed");
      const index = comments.findIndex(
        ({ id }) => id === parameters.comment_id,
      );
      if (index >= 0) comments.splice(index, 1);
      return { data: undefined };
    }
    throw new Error(`unexpected_route:${route}`);
  };
  return { request, calls };
}

function toStoredComment(comment: {
  id: number;
  body: string;
  authorLogin?: string;
}) {
  return {
    id: comment.id,
    body: comment.body,
    authorLogin: comment.authorLogin ?? "review-router[bot]",
  };
}

function toResponseComment(comment: {
  id: number;
  body: string;
  authorLogin: string;
}) {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: comment.authorLogin },
  };
}

function mutations(
  calls: Array<{
    route: string;
    parameters: Readonly<Record<string, unknown>>;
  }>,
) {
  return calls.filter(({ route }) => /^(?:POST|PATCH|DELETE) /u.test(route));
}
