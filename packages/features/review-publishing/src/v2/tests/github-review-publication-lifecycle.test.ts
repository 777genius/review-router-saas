import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GitHubReviewPublicationLifecycleAdapter,
  trustedReviewCommandLedgerAuthorsFromEnv,
  type GitHubGraphqlClient,
} from "../infrastructure/github/github-review-publication-lifecycle";
import {
  CurrentPublicationLifecycleStatus,
  LiveReviewPublicationLifecycleStatus,
  ReviewPublicationLifecycleExpectationStatus,
} from "../application/ports/review-publication-ports";
import { ResolveCurrentPublicationLifecycle } from "../application/use-cases/resolve-current-publication-lifecycle";
import type { ReviewPublicationScope } from "../domain/review-publication-attempt";
import { canonicalReviewPublicationJson } from "../domain/canonical-review-publication-json";
import { HmacReviewCommandLedgerVerifier } from "../infrastructure/hmac-review-command-ledger-verifier";

const scope: ReviewPublicationScope = {
  workspaceId: "workspace-1",
  repositoryConnectionId: "repository-1",
  scmRepositoryIdentityId: "identity-1",
  pullRequestNumber: 42,
};
const headSha = "a".repeat(40);
const fingerprint = "b".repeat(24);
const lineageFingerprint = "rrl_0123456789abcdef0123456789abcdef";
const ledgerKey = "ledger-key-material-for-tests-00000000000000000000";

describe("GitHubReviewPublicationLifecycleAdapter", () => {
  it("loads every thread/comment page and derives the Action-compatible target", async () => {
    const calls: Array<Readonly<Record<string, unknown>>> = [];
    const queries: string[] = [];
    const client: GitHubGraphqlClient = {
      async graphql<T>(
        query: string,
        variables: Readonly<Record<string, unknown>>,
      ) {
        calls.push(variables);
        queries.push(query);
        if (query.includes("ReviewRouterPublicationCommandLedger")) {
          return ledgerPage(commandLedgerBody(105), false) as T;
        }
        if (variables.threadId === "thread-1") {
          return {
            node: {
              comments: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  comment("reply-1", "human reply", "2026-07-23T10:00:02Z", {
                    viewerDidAuthor: false,
                  }),
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
          threadStateHash:
            "335da2c351c35228f035d4031f510eb98d93a5d0169c5ed79ff2d2c1427d2127",
          isResolved: false,
          parentOwnedByIntegration: true,
          hasRelevantInteractionAfterParent: true,
          parentCreatedAt: new Date("2026-07-23T10:00:00Z"),
          lastRelevantChangeAt: new Date("2026-07-23T10:00:02Z"),
        },
      ],
    });
    expect(calls).toHaveLength(5);
    expect(
      queries
        .filter((query) => !query.includes("PublicationCommandLedger"))
        .every((query) => query.includes("author { login }")),
    ).toBe(true);
  });

  it("recognizes an Action lineage marker in the live inventory", async () => {
    const result = await adapter({
      async graphql<T>(query: string) {
        if (query.includes("ReviewRouterPublicationCommandLedger")) {
          return ledgerPage(null, false) as T;
        }
        return inventoryPage(
          [
            {
              id: "thread-lineage",
              isResolved: false,
              comments: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  comment(
                    "parent-lineage",
                    `reviewrouter:finding:v2:${lineageFingerprint}`,
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
          threadId: "thread-lineage",
          markerFingerprint: lineageFingerprint,
        },
      ],
    });
  });

  it.each([
    {
      name: "pending review creation",
      timestamps: { publishedAt: null },
      expectedInteraction: false,
      expectedLastRelevantChangeAt: "2026-07-23T10:00:00.000Z",
    },
    {
      name: "unexplained pending review update",
      timestamps: {
        publishedAt: null,
        updatedAt: "2026-07-23T10:00:11Z",
      },
      expectedInteraction: true,
      expectedLastRelevantChangeAt: "2026-07-23T10:00:11.000Z",
    },
    {
      name: "pending-to-submitted review transition",
      timestamps: {
        publishedAt: "2026-07-23T10:00:11Z",
        updatedAt: "2026-07-23T10:00:11Z",
      },
      expectedInteraction: false,
      expectedLastRelevantChangeAt: "2026-07-23T10:00:00.000Z",
    },
    {
      name: "parent comment edit",
      timestamps: {
        publishedAt: "2026-07-23T10:00:05Z",
        updatedAt: "2026-07-23T10:00:11Z",
        lastEditedAt: "2026-07-23T10:00:11Z",
      },
      expectedInteraction: true,
      expectedLastRelevantChangeAt: "2026-07-23T10:00:11.000Z",
    },
    {
      name: "pending-to-submitted propagation lag",
      timestamps: {
        publishedAt: "2026-07-23T10:00:05Z",
        updatedAt: "2026-07-23T10:00:11Z",
      },
      expectedInteraction: false,
      expectedLastRelevantChangeAt: "2026-07-23T10:00:00.000Z",
    },
  ])("classifies $name without weakening freshness", async (testCase) => {
    const result = await resolveSingleTarget(testCase.timestamps);

    expect(result).toMatchObject({
      status: LiveReviewPublicationLifecycleStatus.Available,
      targets: [
        {
          hasRelevantInteractionAfterParent: testCase.expectedInteraction,
          lastRelevantChangeAt: new Date(testCase.expectedLastRelevantChangeAt),
        },
      ],
    });
  });

  it("keeps a submitted publication current through GitHub timestamp propagation lag", async () => {
    const live = await resolveSingleTarget({
      publishedAt: "2026-07-23T10:00:05Z",
      updatedAt: "2026-07-23T10:00:11Z",
    });
    const result = await new ResolveCurrentPublicationLifecycle({
      expectations: {
        async resolve() {
          return {
            status: ReviewPublicationLifecycleExpectationStatus.Available,
            reviewedHeadSha: headSha,
            lifecycleStateHash: "lifecycle-hash",
            commandLedgerWatermark: 0n,
            observedNotAfter: new Date("2026-07-23T09:59:59.000Z"),
            lifecycleObservationVersion: null,
            targets: [],
            createdTargetFingerprints: [lineageFingerprint],
          };
        },
      },
      live: {
        async resolve() {
          return live;
        },
      },
    }).resolve(scope);

    expect(result.status).toBe(CurrentPublicationLifecycleStatus.Current);
  });

  it("fails closed on reversed GitHub publication timestamps", async () => {
    const result = await resolveSingleTarget(
      {
        publishedAt: "2026-07-23T10:00:05Z",
        updatedAt: "2026-07-23T10:00:05Z",
      },
      "2026-07-23T10:00:10Z",
    );

    expect(result).toEqual({
      status: LiveReviewPublicationLifecycleStatus.Unavailable,
    });
  });

  it("fails closed when GitHub reports an edit after its latest update", async () => {
    const result = await resolveSingleTarget({
      publishedAt: "2026-07-23T10:00:05Z",
      updatedAt: "2026-07-23T10:00:08Z",
      lastEditedAt: "2026-07-23T10:00:11Z",
    });

    expect(result).toEqual({
      status: LiveReviewPublicationLifecycleStatus.Unavailable,
    });
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
                    {
                      viewerDidAuthor: false,
                      authorLogin: "github-actions[bot]",
                    },
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
          parentOwnedByIntegration: true,
        },
      ],
    });
  });

  it("ignores finding markers copied by an untrusted review author", async () => {
    const result = await adapter({
      async graphql<T>(query: string) {
        if (query.includes("ReviewRouterPublicationCommandLedger")) {
          return ledgerPage(null, false) as T;
        }
        return inventoryPage(
          [
            {
              id: "thread-spoof",
              isResolved: false,
              comments: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  comment(
                    "comment-spoof",
                    `<!-- review-router-finding:${fingerprint} -->`,
                    "2026-07-23T10:00:00Z",
                    {
                      viewerDidAuthor: false,
                      authorLogin: "pull-request-author",
                    },
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
      targets: [],
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

  it("fails closed when signed ledger state changes without advancing its watermark", async () => {
    let ledgerRead = 0;
    const result = await adapter({
      async graphql<T>(query: string) {
        if (query.includes("ReviewRouterPublicationCommandLedger")) {
          ledgerRead += 1;
          return ledgerPage(
            commandLedgerBody(
              105,
              undefined,
              "777genius/agent-teams-ai",
              ledgerRead === 1 ? "skip" : "unskip",
            ),
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

  it.each([
    ["GitHub App", true],
    ["github-actions", false],
  ] as const)(
    "accepts a valid signed ledger authored by %s",
    async (_, viewerDidAuthor) => {
      const result = await adapter({
        async graphql<T>(query: string) {
          if (query.includes("ReviewRouterPublicationCommandLedger")) {
            return ledgerPage(
              commandLedgerBody(105),
              false,
              viewerDidAuthor,
            ) as T;
          }
          return inventoryPage([], false) as T;
        },
      }).resolve(scope);

      expect(result).toMatchObject({
        status: LiveReviewPublicationLifecycleStatus.Available,
        commandLedgerWatermark: 105n,
      });
    },
  );

  it("selects the highest verified watermark and ignores exact signed replays", async () => {
    const current = commandLedgerBody(106);
    const result = await adapter({
      async graphql<T>(query: string) {
        if (query.includes("ReviewRouterPublicationCommandLedger")) {
          return ledgerPage(
            [commandLedgerBody(105), current, current],
            false,
          ) as T;
        }
        return inventoryPage([], false) as T;
      },
    }).resolve(scope);

    expect(result).toMatchObject({
      status: LiveReviewPublicationLifecycleStatus.Available,
      commandLedgerWatermark: 106n,
    });
  });

  it("rejects different signed ledger states with the same watermark", async () => {
    const ambiguous = await adapter({
      async graphql<T>(query: string) {
        if (query.includes("ReviewRouterPublicationCommandLedger")) {
          return ledgerPage(
            [
              commandLedgerBody(105),
              commandLedgerBody(
                105,
                undefined,
                "777genius/agent-teams-ai",
                "unskip",
              ),
            ],
            false,
          ) as T;
        }
        return inventoryPage([], false) as T;
      },
    }).resolve(scope);

    expect(ambiguous).toEqual({
      status: LiveReviewPublicationLifecycleStatus.Unavailable,
    });
  });

  it("keeps the trusted ledger when PR commenters add invalid and replayed markers", async () => {
    const result = await adapter({
      async graphql<T>(query: string) {
        if (query.includes("ReviewRouterPublicationCommandLedger")) {
          return {
            repository: {
              pullRequest: {
                headRefOid: headSha,
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      body: commandLedgerBody(105),
                      viewerDidAuthor: true,
                      author: { login: "review-router-ai[bot]" },
                    },
                    {
                      body: commandLedgerBody(104),
                      viewerDidAuthor: false,
                      author: { login: "pull-request-author" },
                    },
                    {
                      body: commandLedgerBody(106, "0".repeat(64)),
                      viewerDidAuthor: false,
                      author: { login: "pull-request-author" },
                    },
                  ],
                },
              },
            },
          } as T;
        }
        return inventoryPage([], false) as T;
      },
    }).resolve(scope);

    expect(result).toMatchObject({
      status: LiveReviewPublicationLifecycleStatus.Available,
      commandLedgerWatermark: 105n,
    });
  });

  it("does not trust github-actions when the App token is authoritative", () => {
    expect(
      trustedReviewCommandLedgerAuthorsFromEnv({
        REVIEWROUTER_COMMENT_TOKEN_MODE: "app-oidc",
        REVIEW_ROUTER_COMMENT_TOKEN_STATUS: "ready",
      }),
    ).not.toContain("github-actions[bot]");
  });

  it("fails closed on an invalid signature unless one unique valid ledger exists", async () => {
    const invalidOnly = await adapter({
      async graphql<T>(query: string) {
        if (query.includes("ReviewRouterPublicationCommandLedger")) {
          return ledgerPage(commandLedgerBody(105, "0".repeat(64)), false) as T;
        }
        return inventoryPage([], false) as T;
      },
    }).resolve(scope);
    const validWithInvalidNoise = await adapter({
      async graphql<T>(query: string) {
        if (query.includes("ReviewRouterPublicationCommandLedger")) {
          return ledgerPage(
            [commandLedgerBody(104, "0".repeat(64)), commandLedgerBody(105)],
            false,
          ) as T;
        }
        return inventoryPage([], false) as T;
      },
    }).resolve(scope);

    expect(invalidOnly).toEqual({
      status: LiveReviewPublicationLifecycleStatus.Unavailable,
    });
    expect(validWithInvalidNoise).toMatchObject({
      status: LiveReviewPublicationLifecycleStatus.Available,
      commandLedgerWatermark: 105n,
    });
  });

  it("fails closed when a valid signature is bound to another repository", async () => {
    const result = await adapter({
      async graphql<T>(query: string) {
        if (query.includes("ReviewRouterPublicationCommandLedger")) {
          return ledgerPage(
            commandLedgerBody(105, undefined, "another-owner/another-repo"),
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

  it("distinguishes proven absence from incomplete GitHub payloads", async () => {
    const repositoryMappingMissing =
      await new GitHubReviewPublicationLifecycleAdapter(
        {
          async resolve() {
            return null;
          },
        },
        {
          async create() {
            throw new Error("client_must_not_be_created");
          },
        },
        commandLedgerVerifier(),
        trustedReviewCommandLedgerAuthorsFromEnv({}),
      ).resolve(scope);
    const pullRequestMissing = await adapter({
      async graphql<T>() {
        return { repository: { pullRequest: null } } as T;
      },
    }).resolve(scope);
    const malformedThreads = await adapter({
      async graphql<T>(query: string) {
        if (query.includes("ReviewRouterPublicationCommandLedger")) {
          return ledgerPage(null, false) as T;
        }
        return {
          repository: {
            pullRequest: {
              headRefOid: headSha,
              reviewThreads: { nodes: null },
            },
          },
        } as T;
      },
    }).resolve(scope);
    const missingThreads = await adapter({
      async graphql<T>(query: string) {
        if (query.includes("ReviewRouterPublicationCommandLedger")) {
          return ledgerPage(null, false) as T;
        }
        return {
          repository: { pullRequest: { headRefOid: headSha } },
        } as T;
      },
    }).resolve(scope);
    const malformedPageInfo = await adapter({
      async graphql<T>(query: string) {
        if (query.includes("ReviewRouterPublicationCommandLedger")) {
          return ledgerPage(null, false) as T;
        }
        return {
          repository: {
            pullRequest: {
              headRefOid: headSha,
              reviewThreads: { nodes: [], pageInfo: null },
            },
          },
        } as T;
      },
    }).resolve(scope);
    const transientFailure = await adapter({
      async graphql() {
        throw new Error("github_unavailable");
      },
    }).resolve(scope);

    expect(repositoryMappingMissing).toEqual({
      status: LiveReviewPublicationLifecycleStatus.Missing,
    });
    expect(pullRequestMissing).toEqual({
      status: LiveReviewPublicationLifecycleStatus.Missing,
    });
    expect(malformedThreads).toEqual({
      status: LiveReviewPublicationLifecycleStatus.Unavailable,
    });
    expect(missingThreads).toEqual({
      status: LiveReviewPublicationLifecycleStatus.Unavailable,
    });
    expect(malformedPageInfo).toEqual({
      status: LiveReviewPublicationLifecycleStatus.Unavailable,
    });
    expect(transientFailure).toEqual({
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
          githubRepositoryId: "987654321",
          repositoryFullName: "777genius/agent-teams-ai",
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
    commandLedgerVerifier(),
    trustedReviewCommandLedgerAuthorsFromEnv({}),
  );
}

async function resolveSingleTarget(
  timestamps: NonNullable<Parameters<typeof comment>[3]>,
  createdAt = "2026-07-23T10:00:00Z",
) {
  return adapter({
    async graphql<T>(query: string) {
      if (query.includes("ReviewRouterPublicationCommandLedger")) {
        return ledgerPage(null, false) as T;
      }
      return inventoryPage(
        [
          {
            id: "thread-timestamp",
            isResolved: false,
            comments: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                comment(
                  "parent-timestamp",
                  `reviewrouter:finding:v2:${lineageFingerprint}`,
                  createdAt,
                  timestamps,
                ),
              ],
            },
          },
        ],
        false,
      ) as T;
    },
  }).resolve(scope);
}

function commandLedgerVerifier() {
  return new HmacReviewCommandLedgerVerifier({
    deriveLedgerKey() {
      return ledgerKey;
    },
  });
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
  authorLogin = viewerDidAuthor
    ? "review-router-ai[bot]"
    : "github-actions[bot]",
  endCursor: string | null = "ledger-next",
) {
  const bodies = body === null ? [] : typeof body === "string" ? [body] : body;
  return {
    repository: {
      pullRequest: {
        headRefOid: headSha,
        comments: {
          pageInfo: { hasNextPage, endCursor },
          nodes: bodies.map((value) => ({
            body: value,
            viewerDidAuthor,
            author: { login: authorLogin },
          })),
        },
      },
    },
  };
}

function commandLedgerBody(
  commandCommentId: number,
  signatureOverride?: string,
  repositoryFullName = "777genius/agent-teams-ai",
  action: "skip" | "unskip" = "skip",
) {
  const payloadText = canonicalReviewPublicationJson({
    entries: [
      {
        action,
        commandCommentId,
        parentCommentId: 99,
      },
    ],
    pr: 42,
    repo: repositoryFullName,
    version: 1,
  });
  const payload = Buffer.from(payloadText, "utf8").toString("base64url");
  const signature =
    signatureOverride ??
    createHmac("sha256", ledgerKey).update(payloadText).digest("hex");
  return [
    "<!-- reviewrouter-ledger:v1",
    `payload=${payload}`,
    `signature=${signature}`,
    "-->",
  ].join("\n");
}

function comment(
  id: string,
  body: string,
  at: string,
  overrides?: {
    readonly lastEditedAt?: string | null;
    readonly publishedAt?: string | null;
    readonly updatedAt?: string | null;
    readonly viewerDidAuthor?: boolean;
    readonly authorLogin?: string | null;
  },
) {
  const viewerDidAuthor = overrides?.viewerDidAuthor ?? true;
  const authorLogin =
    overrides?.authorLogin === undefined
      ? viewerDidAuthor
        ? "review-router-ai[bot]"
        : "human.user"
      : overrides.authorLogin;
  return {
    id,
    body,
    createdAt: at,
    publishedAt:
      overrides?.publishedAt === undefined ? at : overrides.publishedAt,
    updatedAt: overrides?.updatedAt ?? at,
    lastEditedAt: overrides?.lastEditedAt ?? null,
    viewerDidAuthor,
    author: authorLogin === null ? null : { login: authorLogin },
  };
}

function targetId(threadId: string, commentId: string, marker: string) {
  return `rrt_${createHash("sha256")
    .update(`${threadId}\n${commentId}\n${marker}`)
    .digest("hex")
    .slice(0, 16)}`;
}
