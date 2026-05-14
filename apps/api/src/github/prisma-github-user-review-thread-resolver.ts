import type { PrismaClient } from "@reviewrouter/platform-db";
import {
  getValidGitHubUserAccessToken,
  resolveGitHubUserAuthorizationAppSlug,
} from "@reviewrouter/features-auth";
import type {
  ActionReviewThreadLifecycleReasonCode,
  ActionReviewThreadLifecycleResolveResponse,
} from "@reviewrouter/features-action-control-plane";
import type {
  GitHubReviewThreadLifecycleResolverPort,
  ResolveGitHubReviewThreadLifecycleInput,
} from "@reviewrouter/features-action-control-plane";

type FetchLike = typeof fetch;

type ResolverEnvironment = {
  readonly [key: string]: string | undefined;
};

type GraphQLPageInfo = {
  readonly hasNextPage?: boolean | null;
  readonly endCursor?: string | null;
};

type GraphQLComment = {
  readonly id?: string | null;
  readonly author?: { readonly login?: string | null } | null;
  readonly body?: string | null;
  readonly createdAt?: string | null;
  readonly updatedAt?: string | null;
};

type GraphQLThread = {
  readonly id?: string | null;
  readonly isResolved?: boolean | null;
  readonly viewerCanResolve?: boolean | null;
  readonly comments?: {
    readonly pageInfo?: GraphQLPageInfo | null;
    readonly nodes?: readonly GraphQLComment[] | null;
  } | null;
};

const githubGraphqlUrl = "https://api.github.com/graphql";
const githubApiVersion = "2022-11-28";
const maxResolverCandidates = 8;

const headQuery = `
query ReviewRouterUserResolveHeadGuard($owner: String!, $repo: String!, $prNumber: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $prNumber) {
      headRefOid
    }
  }
}`;

const threadQuery = `
query ReviewRouterUserResolveThreadGuard($threadId: ID!) {
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      id
      isResolved
      viewerCanResolve
      comments(first: 100) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          author { login }
          body
          createdAt
          updatedAt
        }
      }
    }
  }
}`;

const resolveMutation = `
mutation ReviewRouterUserResolveReviewThread($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread {
      id
      isResolved
    }
  }
}`;

export class PrismaGitHubUserReviewThreadResolver implements GitHubReviewThreadLifecycleResolverPort {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: {
      readonly env?: ResolverEnvironment;
      readonly fetch?: FetchLike;
    } = {},
  ) {}

  async resolveReviewThreadLifecycle(
    input: ResolveGitHubReviewThreadLifecycleInput,
  ): Promise<ActionReviewThreadLifecycleResolveResponse> {
    const candidates = await this.findCandidateUserIds(input);
    if (candidates.length === 0) {
      return response("missing_user_authorization", [
        "missing_user_authorization",
      ]);
    }

    const tokenFailures = new Set<ActionReviewThreadLifecycleReasonCode>();
    let sawResolverPermissionDenied = false;

    for (const userId of candidates) {
      const token = await getValidGitHubUserAccessToken({
        prisma: this.prisma,
        userId,
        env: this.options.env ?? process.env,
        now: input.now,
        fetch: this.options.fetch ?? fetch,
      });
      if (token.status !== "ready") {
        tokenFailures.add(tokenStatusReason(token.status));
        continue;
      }

      try {
        const result = await this.resolveWithUserToken({
          input,
          accessToken: token.accessToken,
        });
        if (result.status === "missing_resolver_permission") {
          sawResolverPermissionDenied = true;
          continue;
        }
        return result;
      } catch (error) {
        if (isPermissionDenied(error)) {
          sawResolverPermissionDenied = true;
          continue;
        }
        return response("failed", ["mutation_failed"], safeErrorCode(error));
      }
    }

    if (sawResolverPermissionDenied) {
      return response("missing_resolver_permission", [
        "mutation_permission_denied",
      ]);
    }
    return response(
      "missing_user_authorization",
      tokenFailures.size > 0
        ? [...tokenFailures]
        : ["missing_user_authorization"],
    );
  }

  private async findCandidateUserIds(
    input: ResolveGitHubReviewThreadLifecycleInput,
  ): Promise<string[]> {
    const env = this.options.env ?? process.env;
    const appSlug = resolveGitHubUserAuthorizationAppSlug(env);
    const permissionRows = await this.prisma.repositoryPermissionCache.findMany(
      {
        where: {
          repositoryId: input.repository.repositoryId,
          canManage: true,
          expiresAt: { gt: input.now },
          user: {
            githubAuthorizations: {
              some: {
                appSlug,
                revokedAt: null,
              },
            },
          },
        },
        orderBy: [{ checkedAt: "desc" }, { updatedAt: "desc" }],
        take: maxResolverCandidates,
        select: { userId: true },
      },
    );
    const memberRows = await this.prisma.workspaceMember.findMany({
      where: {
        workspaceId: input.repository.workspaceId,
        role: { in: ["owner", "admin"] },
        userId: { not: null },
        user: {
          githubAuthorizations: {
            some: {
              appSlug,
              revokedAt: null,
            },
          },
        },
      },
      orderBy: { updatedAt: "desc" },
      take: maxResolverCandidates,
      select: { userId: true },
    });

    return uniqueStrings([
      ...permissionRows.map((row) => row.userId),
      ...memberRows.flatMap((row) => (row.userId ? [row.userId] : [])),
    ]).slice(0, maxResolverCandidates);
  }

  private async resolveWithUserToken(input: {
    readonly input: ResolveGitHubReviewThreadLifecycleInput;
    readonly accessToken: string;
  }): Promise<ActionReviewThreadLifecycleResolveResponse> {
    const repositoryParts = input.input.repository.fullName.split("/");
    const owner = repositoryParts[0];
    const repo = repositoryParts.slice(1).join("/");
    if (!owner || !repo) {
      return response("failed", ["mutation_failed"], "invalid_repository_name");
    }

    const head = await this.graphql<{
      readonly repository?: {
        readonly pullRequest?: { readonly headRefOid?: string | null } | null;
      } | null;
    }>({
      accessToken: input.accessToken,
      query: headQuery,
      variables: {
        owner,
        repo,
        prNumber: input.input.request.pullRequestNumber,
      },
    });
    const headRefOid = head.repository?.pullRequest?.headRefOid ?? null;
    if (!headRefOid) {
      return response("missing_resolver_permission", [
        "mutation_permission_denied",
      ]);
    }
    if (headRefOid !== input.input.request.reviewedHeadSha) {
      return response("skipped", ["head_sha_changed"]);
    }

    const thread = await this.graphql<{ readonly node?: GraphQLThread | null }>(
      {
        accessToken: input.accessToken,
        query: threadQuery,
        variables: {
          threadId: input.input.request.target.threadId,
        },
      },
    );
    const guard = this.guardThread(input.input.request.target, thread.node);
    if (guard.status !== "ready") {
      return guard;
    }

    const resolved = await this.graphql<{
      readonly resolveReviewThread?: {
        readonly thread?: { readonly isResolved?: boolean | null } | null;
      } | null;
    }>({
      accessToken: input.accessToken,
      query: resolveMutation,
      variables: {
        threadId: input.input.request.target.threadId,
      },
    });
    if (!resolved.resolveReviewThread?.thread?.isResolved) {
      return response("failed", ["mutation_failed"], "github_not_resolved");
    }

    return {
      protocolVersion: 1,
      status: "resolved",
      resolvedBy: "github_user",
      reasonCodes: [],
    };
  }

  private guardThread(
    target: ResolveGitHubReviewThreadLifecycleInput["request"]["target"],
    thread: GraphQLThread | null | undefined,
  ): ActionReviewThreadLifecycleResolveResponse | { readonly status: "ready" } {
    if (!thread) {
      return response("skipped", ["thread_not_found"]);
    }
    if (thread.isResolved) {
      return {
        protocolVersion: 1,
        status: "already_resolved",
        resolvedBy: "external",
        reasonCodes: ["already_resolved"],
      };
    }
    if (thread.viewerCanResolve === false) {
      return response("missing_resolver_permission", ["viewer_cannot_resolve"]);
    }

    const comments = thread.comments?.nodes ?? [];
    if (thread.comments?.pageInfo?.hasNextPage) {
      return response("skipped", ["pagination_incomplete"]);
    }

    const parentIndex = comments.findIndex(
      (comment) => comment.id === target.parentCommentId,
    );
    const parent = parentIndex >= 0 ? comments[parentIndex] : undefined;
    if (!parent) {
      return response("skipped", ["thread_changed_before_mutation"]);
    }
    if (!isTrustedReviewRouterAuthor(parent.author?.login, this.options.env)) {
      return response("manual_attention", ["untrusted_author"]);
    }
    if (extractFindingFingerprint(parent.body || "") !== target.fingerprint) {
      return response("skipped", ["thread_changed_before_mutation"]);
    }

    const parentUpdatedAt =
      parent.updatedAt || parent.createdAt || new Date(0).toISOString();
    if (parentUpdatedAt !== target.parentCommentUpdatedAt) {
      return response("skipped", ["thread_changed_before_mutation"]);
    }

    const hasHumanReply = comments.some(
      (comment, index) =>
        index > parentIndex &&
        comment.id !== target.parentCommentId &&
        !isTrustedReviewRouterAuthor(comment.author?.login, this.options.env),
    );
    if (comments.length !== target.threadCommentCount) {
      return hasHumanReply
        ? response("manual_attention", ["human_reply"])
        : response("skipped", ["thread_changed_before_mutation"]);
    }
    if (hasHumanReply) {
      return response("manual_attention", ["human_reply"]);
    }

    return { status: "ready" };
  }

  private async graphql<T>(input: {
    readonly accessToken: string;
    readonly query: string;
    readonly variables: Record<string, unknown>;
  }): Promise<T> {
    const responseValue = await (this.options.fetch ?? fetch)(
      githubGraphqlUrl,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${input.accessToken}`,
          "content-type": "application/json",
          "x-github-api-version": githubApiVersion,
        },
        body: JSON.stringify({
          query: input.query,
          variables: input.variables,
        }),
      },
    );
    const body = (await responseValue.json().catch(() => null)) as {
      readonly data?: T;
      readonly errors?: readonly { readonly message?: string }[];
    } | null;
    if (!responseValue.ok || body?.errors?.length) {
      throw Object.assign(
        new Error(
          body?.errors?.map((error) => error.message).join("; ") ||
            `github_graphql_${responseValue.status}`,
        ),
        { status: responseValue.status },
      );
    }
    if (!body || !("data" in body)) {
      throw new Error("github_graphql_invalid_response");
    }
    return body.data as T;
  }
}

function response(
  status: ActionReviewThreadLifecycleResolveResponse["status"],
  reasonCodes: readonly ActionReviewThreadLifecycleReasonCode[],
  errorCode?: string,
): ActionReviewThreadLifecycleResolveResponse {
  return {
    protocolVersion: 1,
    status,
    reasonCodes: [...reasonCodes],
    ...(errorCode ? { errorCode } : {}),
  };
}

function tokenStatusReason(
  status: Exclude<
    Awaited<ReturnType<typeof getValidGitHubUserAccessToken>>["status"],
    "ready"
  >,
): ActionReviewThreadLifecycleReasonCode {
  switch (status) {
    case "revoked":
      return "token_revoked";
    case "expired":
      return "token_expired";
    case "refresh_failed":
      return "token_refresh_failed";
    case "token_decryption_failed":
      return "token_decryption_failed";
    case "token_encryption_misconfigured":
      return "token_encryption_misconfigured";
    case "missing":
      return "missing_user_authorization";
    default:
      return "missing_user_authorization";
  }
}

function isPermissionDenied(error: unknown): boolean {
  const maybe = error as {
    readonly status?: number;
    readonly message?: string;
  };
  const message = maybe?.message || String(error);
  return (
    maybe?.status === 401 ||
    maybe?.status === 403 ||
    /permission|forbidden|resource not accessible|not found/i.test(message)
  );
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

function extractFindingFingerprint(body: string): string | null {
  const match = body.match(
    /<!--\s*review-router-finding:([a-z0-9][a-z0-9:_-]{7,127})\s*-->/i,
  );
  return match?.[1] ?? null;
}

function isTrustedReviewRouterAuthor(
  login: string | null | undefined,
  env: ResolverEnvironment | undefined,
): boolean {
  const normalized = login?.trim().toLowerCase();
  if (!normalized) return false;
  return trustedReviewRouterAuthors(env).has(normalized);
}

function trustedReviewRouterAuthors(
  env: ResolverEnvironment | undefined,
): ReadonlySet<string> {
  const values = [
    "review-router-ai[bot]",
    "github-actions[bot]",
    env?.REVIEW_APP_BOT_LOGIN,
    env?.REVIEW_ROUTER_APP_BOT_LOGIN,
    env?.REVIEWROUTER_APP_BOT_LOGIN,
    botLoginFromSlug(env?.GITHUB_APP_SLUG),
    botLoginFromSlug(env?.REVIEW_APP_SLUG),
    botLoginFromSlug(env?.REVIEW_ROUTER_APP_SLUG),
    botLoginFromSlug(env?.REVIEWROUTER_APP_SLUG),
    botLoginFromSlug(env?.AI_ROBOT_REVIEW_APP_SLUG),
    ...splitCommaSeparated(env?.REVIEW_THREAD_LIFECYCLE_TRUSTED_AUTHORS),
    ...splitCommaSeparated(env?.REVIEW_ROUTER_TRUSTED_BOT_AUTHORS),
  ];
  return new Set(
    values
      .filter((value): value is string => Boolean(value?.trim()))
      .map((value) => value.trim().toLowerCase()),
  );
}

function botLoginFromSlug(slug: string | undefined): string | undefined {
  const normalized = slug?.trim();
  return normalized ? `${normalized}[bot]` : undefined;
}

function splitCommaSeparated(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}
