import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GitHubReviewPublicationLifecycleAdapter,
  type GitHubGraphqlClient,
} from "../infrastructure/github/github-review-publication-lifecycle";
import { LiveReviewPublicationLifecycleStatus } from "../application/ports/review-publication-ports";
import type { ReviewPublicationScope } from "../domain/review-publication-attempt";

const scope: ReviewPublicationScope = {
  workspaceId: "workspace-1",
  repositoryConnectionId: "repository-1",
  scmRepositoryIdentityId: "identity-1",
  pullRequestNumber: 42,
};
const headSha = "a".repeat(40);
const fingerprint = "b".repeat(24);

describe("GitHubReviewPublicationLifecycleAdapter", () => {
  it("loads every thread/comment page and derives the Action-compatible target", async () => {
    const calls: Array<Readonly<Record<string, unknown>>> = [];
    const client: GitHubGraphqlClient = {
      async graphql<T>(
        query: string,
        variables: Readonly<Record<string, unknown>>,
      ) {
        calls.push(variables);
        if (query.includes("ReviewRouterPublicationCommandLedger")) {
          return ledgerPage(commandLedgerBody(105), false) as T;
        }
        if (variables.threadId === "thread-1") {
          return {
            node: {
              comments: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  comment("reply-1", "human reply", "2026-07-23T10:00:02Z"),
                ],
              },
            },
          } as T;
        }
        if (variables.threadsAfter === "threads-next") {
          return inventoryPage([], false) as T;
        }
        return inventoryPage(
          [
            {
              id: "thread-1",
              isResolved: false,
              comments: {
                pageInfo: { hasNextPage: true, endCursor: "comments-next" },
                nodes: [
                  comment(
                    "parent-1",
                    `finding\n<!-- review-router-finding:${fingerprint} -->`,
                    "2026-07-23T10:00:00Z",
                  ),
                ],
              },
            },
          ],
          true,
        ) as T;
      },
    };
    const result = await adapter(client).resolve(scope);

    expect(result).toEqual({
      status: LiveReviewPublicationLifecycleStatus.Available,
      reviewedHeadSha: headSha,
      commandLedgerWatermark: 105n,
      targets: [
        {
          targetId: targetId("thread-1", "parent-1", fingerprint),
          threadId: "thread-1",
          markerFingerprint: fingerprint,
          isResolved: false,
          parentOwnedByIntegration: true,
          hasRelevantInteractionAfterParent: true,
          parentCreatedAt: new Date("2026-07-23T10:00:00Z"),
          lastRelevantChangeAt: new Date("2026-07-23T10:00:02Z"),
        },
      ],
    });
    expect(calls).toHaveLength(5);
  });

  it("retains resolved targets and fails closed on incomplete pagination", async () => {
    const resolved = await adapter({
      async graphql<T>(query: string) {
        if (query.includes("ReviewRouterPublicationCommandLedger")) {
          return ledgerPage(null, false) as T;
        }
        return inventoryPage(
          [
            {
              id: "thread-1",
              isResolved: true,
              comments: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  comment(
                    "parent-1",
                    `<!-- review-router-finding:${fingerprint} -->`,
                    "2026-07-23T10:00:00Z",
                  ),
                ],
              },
            },
          ],
          false,
        ) as T;
      },
    }).resolve(scope);
    const incomplete = await adapter({
      async graphql<T>(query: string) {
        if (query.includes("ReviewRouterPublicationCommandLedger")) {
          return ledgerPage(null, false) as T;
        }
        return inventoryPage([], true, null) as T;
      },
    }).resolve(scope);

    expect(resolved).toMatchObject({
      status: LiveReviewPublicationLifecycleStatus.Available,
      targets: [{ isResolved: true, threadId: "thread-1" }],
    });
    expect(incomplete).toEqual({
      status: LiveReviewPublicationLifecycleStatus.Unavailable,
    });
  });

  it("loads current v2 finding markers from GitHub-visible review comments", async () => {
    const result = await adapter({
      async graphql<T>(query: string) {
        if (query.includes("ReviewRouterPublicationCommandLedger")) {
          return ledgerPage(null, false) as T;
        }
        return inventoryPage(
          [
            {
              id: "thread-1",
              isResolved: false,
              comments: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  comment(
                    "parent-1",
                    `finding\n<!-- reviewrouter:finding:v2:${fingerprint} -->`,
                    "2026-07-23T10:00:00Z",
                  ),
                ],
              },
            },
          ],
          false,
        ) as T;
      },
    }).resolve(scope);

    expect(result).toMatchObject({
      status: LiveReviewPublicationLifecycleStatus.Available,
      targets: [
        {
          targetId: targetId("thread-1", "parent-1", fingerprint),
          markerFingerprint: fingerprint,
        },
      ],
    });
  });

  it("fails closed when the app-owned command ledger changes during inventory", async () => {
    let ledgerRead = 0;
    const result = await adapter({
      async graphql<T>(query: string) {
        if (query.includes("ReviewRouterPublicationCommandLedger")) {
          ledgerRead += 1;
          return ledgerPage(
            commandLedgerBody(ledgerRead === 1 ? 105 : 106),
            false,
          ) as T;
        }
        return inventoryPage([], false) as T;
      },
    }).resolve(scope);

    expect(result).toEqual({
      status: LiveReviewPublicationLifecycleStatus.Unavailable,
    });
  });

  it("ignores user-authored ledger markers and rejects ambiguous app ledgers", async () => {
    const ignored = await adapter({
      async graphql<T>(query: string) {
        if (query.includes("ReviewRouterPublicationCommandLedger")) {
          return ledgerPage(commandLedgerBody(105), false, false) as T;
        }
        return inventoryPage([], false) as T;
      },
    }).resolve(scope);
    const ambiguous = await adapter({
      async graphql<T>(query: string) {
        if (query.includes("ReviewRouterPublicationCommandLedger")) {
          return ledgerPage(
            [commandLedgerBody(105), commandLedgerBody(106)],
            false,
          ) as T;
        }
        return inventoryPage([], false) as T;
      },
    }).resolve(scope);

    expect(ignored).toMatchObject({
      status: LiveReviewPublicationLifecycleStatus.Available,
      commandLedgerWatermark: 0n,
    });
    expect(ambiguous).toEqual({
      status: LiveReviewPublicationLifecycleStatus.Unavailable,
    });
  });

  it("fails closed on a malformed app-owned ledger marker", async () => {
    const result = await adapter({
      async graphql<T>(query: string) {
        if (query.includes("ReviewRouterPublicationCommandLedger")) {
          return ledgerPage(
            "<!--   reviewrouter-ledger:v1 payload=broken -->",
            false,
          ) as T;
        }
        return inventoryPage([], false) as T;
      },
    }).resolve(scope);

    expect(result).toEqual({
      status: LiveReviewPublicationLifecycleStatus.Unavailable,
    });
  });
});

function adapter(client: GitHubGraphqlClient) {
  return new GitHubReviewPublicationLifecycleAdapter(
    {
      async resolve() {
        return {
          githubInstallationId: "130834037",
          owner: "777genius",
          repo: "agent-teams-ai",
        };
      },
    },
    {
      async create() {
        return client;
      },
    },
  );
}

function inventoryPage(
  nodes: readonly unknown[],
  hasNextPage: boolean,
  endCursor: string | null = "threads-next",
) {
  return {
    repository: {
      pullRequest: {
        headRefOid: headSha,
        reviewThreads: {
          pageInfo: { hasNextPage, endCursor },
          nodes,
        },
      },
    },
  };
}

function ledgerPage(
  body: string | readonly string[] | null,
  hasNextPage: boolean,
  viewerDidAuthor = true,
  endCursor: string | null = "ledger-next",
) {
  const bodies = body === null ? [] : typeof body === "string" ? [body] : body;
  return {
    repository: {
      pullRequest: {
        headRefOid: headSha,
        comments: {
          pageInfo: { hasNextPage, endCursor },
          nodes: bodies.map((value) => ({ body: value, viewerDidAuthor })),
        },
      },
    },
  };
}

function commandLedgerBody(commandCommentId: number) {
  const payload = Buffer.from(
    JSON.stringify({
      version: 1,
      repo: "777genius/agent-teams-ai",
      pr: 42,
      entries: [
        {
          action: "skip",
          parentCommentId: 99,
          commandCommentId,
        },
      ],
    }),
    "utf8",
  ).toString("base64url");
  return [
    "<!-- reviewrouter-ledger:v1",
    `payload=${payload}`,
    `signature=${"a".repeat(64)}`,
    "-->",
  ].join("\n");
}

function comment(
  id: string,
  body: string,
  at: string,
  overrides?: {
    readonly lastEditedAt?: string | null;
    readonly viewerDidAuthor?: boolean;
  },
) {
  return {
    id,
    body,
    createdAt: at,
    updatedAt: at,
    lastEditedAt: overrides?.lastEditedAt ?? null,
    viewerDidAuthor: overrides?.viewerDidAuthor ?? true,
  };
}

function targetId(threadId: string, commentId: string, marker: string) {
  return `rrt_${createHash("sha256")
    .update(`${threadId}\n${commentId}\n${marker}`)
    .digest("hex")
    .slice(0, 16)}`;
}
