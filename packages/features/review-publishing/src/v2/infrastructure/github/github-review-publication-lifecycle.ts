import { createHash } from "node:crypto";
import { App } from "@octokit/app";
import {
  LiveReviewPublicationLifecycleStatus,
  type LiveReviewPublicationLifecycleDecision,
  type LiveReviewPublicationLifecyclePort,
  type LiveReviewPublicationLifecycleTargetIdentity,
} from "../../application/ports/review-publication-ports";
import {
  ReviewCommandLedgerVerificationStatus,
  type ReviewCommandLedgerVerificationPort,
} from "../../application/ports/review-command-ledger-verification-port";
import type { ReviewPublicationScope } from "../../domain/review-publication-attempt";
import { extractUniqueReviewFindingFingerprint } from "../../domain/review-finding-marker";
import { reviewLifecycleThreadStateHash } from "../review-lifecycle-thread-state-witness";

const commandLedgerMarkerPresence = /<!--\s*reviewrouter-ledger:v1\b/u;
const maxThreadPages = 100;
const maxCommentPagesPerThread = 100;
const maxCommandLedgerPages = 100;

export type GitHubReviewLifecycleRepository = {
  readonly githubInstallationId: string;
  readonly githubRepositoryId: string;
  readonly repositoryFullName: string;
  readonly owner: string;
  readonly repo: string;
};

export interface GitHubReviewLifecycleRepositoryQueryPort {
  resolve(
    scope: ReviewPublicationScope,
  ): Promise<GitHubReviewLifecycleRepository | null>;
}

export type GitHubGraphqlClient = {
  graphql<T>(
    query: string,
    variables: Readonly<Record<string, unknown>>,
  ): Promise<T>;
};

export interface GitHubInstallationGraphqlClientFactoryPort {
  create(githubInstallationId: string): Promise<GitHubGraphqlClient>;
}

type PageInfo = {
  readonly hasNextPage?: boolean;
  readonly endCursor?: string | null;
};

type ReviewComment = {
  readonly id?: string | null;
  readonly body?: string | null;
  readonly createdAt?: string | null;
  readonly publishedAt?: string | null;
  readonly updatedAt?: string | null;
  readonly lastEditedAt?: string | null;
  readonly viewerDidAuthor?: boolean | null;
  readonly author?: {
    readonly login?: string | null;
  } | null;
};

type IssueComment = {
  readonly body?: string | null;
  readonly viewerDidAuthor?: boolean | null;
  readonly author?: {
    readonly login?: string | null;
  } | null;
};

type ReviewThread = {
  readonly id?: string | null;
  readonly isResolved?: boolean | null;
  readonly comments?: {
    readonly pageInfo?: PageInfo | null;
    readonly nodes?: readonly (ReviewComment | null)[] | null;
  } | null;
};

type ValidReviewThread = Omit<ReviewThread, "id" | "isResolved"> & {
  readonly id: string;
  readonly isResolved: boolean;
};

type ValidReviewComment = Omit<ReviewComment, "id"> & {
  readonly id: string;
};

const inventoryQuery = `
query ReviewRouterPublicationLifecycle(
  $owner: String!
  $repo: String!
  $prNumber: Int!
  $threadsAfter: String
) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $prNumber) {
      headRefOid
      reviewThreads(first: 50, after: $threadsAfter) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          comments(first: 100) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id body createdAt publishedAt updatedAt lastEditedAt viewerDidAuthor
              author { login }
            }
          }
        }
      }
    }
  }
}`;

const commentsQuery = `
query ReviewRouterPublicationLifecycleComments(
  $threadId: ID!
  $commentsAfter: String
) {
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      comments(first: 100, after: $commentsAfter) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id body createdAt publishedAt updatedAt lastEditedAt viewerDidAuthor
          author { login }
        }
      }
    }
  }
}`;

const commandLedgerQuery = `
query ReviewRouterPublicationCommandLedger(
  $owner: String!
  $repo: String!
  $prNumber: Int!
  $commentsAfter: String
) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $prNumber) {
      headRefOid
      comments(first: 100, after: $commentsAfter) {
        pageInfo { hasNextPage endCursor }
        nodes { body viewerDidAuthor author { login } }
      }
    }
  }
}`;

export class GitHubReviewPublicationLifecycleAdapter implements LiveReviewPublicationLifecyclePort {
  constructor(
    private readonly repositories: GitHubReviewLifecycleRepositoryQueryPort,
    private readonly clients: GitHubInstallationGraphqlClientFactoryPort,
    private readonly commandLedgers: ReviewCommandLedgerVerificationPort,
    private readonly trustedCommandLedgerAuthors: ReadonlySet<string>,
  ) {}

  async resolve(
    scope: ReviewPublicationScope,
  ): Promise<LiveReviewPublicationLifecycleDecision> {
    try {
      const repository = await this.repositories.resolve(scope);
      if (repository === null) {
        return { status: LiveReviewPublicationLifecycleStatus.Missing };
      }
      const client = await this.clients.create(repository.githubInstallationId);
      return await loadInventory(
        client,
        repository,
        scope,
        this.commandLedgers,
        this.trustedCommandLedgerAuthors,
      );
    } catch (error) {
      if (error instanceof GitHubPullRequestMissingError) {
        return { status: LiveReviewPublicationLifecycleStatus.Missing };
      }
      return { status: LiveReviewPublicationLifecycleStatus.Unavailable };
    }
  }
}

export class OctokitGitHubInstallationGraphqlClientFactory implements GitHubInstallationGraphqlClientFactoryPort {
  private readonly app: App;

  constructor(options: {
    readonly appId: string;
    readonly privateKey: string;
  }) {
    this.app = new App(options);
  }

  async create(githubInstallationId: string): Promise<GitHubGraphqlClient> {
    const installationId = positiveSafeInteger(
      githubInstallationId,
      "github_installation_id",
    );
    return (await this.app.getInstallationOctokit(
      installationId,
    )) as GitHubGraphqlClient;
  }
}

async function loadInventory(
  client: GitHubGraphqlClient,
  repository: GitHubReviewLifecycleRepository,
  scope: ReviewPublicationScope,
  commandLedgers: ReviewCommandLedgerVerificationPort,
  trustedCommandLedgerAuthors: ReadonlySet<string>,
): Promise<LiveReviewPublicationLifecycleDecision> {
  const commandLedgerBefore = await loadCommandLedger(
    client,
    repository,
    scope,
    commandLedgers,
    trustedCommandLedgerAuthors,
  );
  let cursor: string | null = null;
  const seenCursors = new Set<string>();
  const targets: LiveReviewPublicationLifecycleTargetIdentity[] = [];
  let reviewedHeadSha: string | null = null;

  for (let page = 0; page < maxThreadPages; page += 1) {
    const response = await client.graphql<{
      readonly repository?: {
        readonly pullRequest?: {
          readonly headRefOid?: string | null;
          readonly reviewThreads?: {
            readonly pageInfo?: PageInfo | null;
            readonly nodes?: readonly (ReviewThread | null)[] | null;
          } | null;
        } | null;
      } | null;
    }>(inventoryQuery, {
      owner: repository.owner,
      repo: repository.repo,
      prNumber: scope.pullRequestNumber,
      threadsAfter: cursor,
    });
    const pullRequest = requiredPullRequest(response, "github_lifecycle");
    const connection = pullRequest?.reviewThreads;
    if (!connection || !Array.isArray(connection.nodes)) {
      throw new Error("github_lifecycle_threads_unavailable");
    }
    const pageHeadSha = commitSha(pullRequest.headRefOid);
    if (pageHeadSha !== commandLedgerBefore.reviewedHeadSha) {
      throw new Error("github_lifecycle_head_changed_during_inventory");
    }
    if (reviewedHeadSha !== null && reviewedHeadSha !== pageHeadSha) {
      throw new Error("github_lifecycle_head_changed_during_pagination");
    }
    reviewedHeadSha = pageHeadSha;

    for (const candidate of connection.nodes) {
      if (candidate === null) throw new Error("github_thread_null");
      const thread = requiredThread(candidate);
      const comments = await loadAllComments(client, thread);
      const parent = comments[0];
      const fingerprint = extractUniqueReviewFindingFingerprint(
        parent?.body ?? "",
      );
      if (!parent || !fingerprint) continue;
      const parentOwnedByIntegration = isTrustedGitHubCommentAuthor(
        parent,
        trustedCommandLedgerAuthors,
        "github_parent",
      );
      if (!parentOwnedByIntegration) continue;
      const parentCreatedAt = timestamp(
        parent.createdAt,
        "github_parent_created_at",
      );
      const parentHasRelevantTimestampChange = hasRelevantParentTimestampChange(
        parent,
        parentCreatedAt,
      );
      let lastRelevantChangeAt = parentCreatedAt;
      for (const comment of comments) {
        const changedAt = laterDate(
          comment.createdAt,
          comment.updatedAt,
          comment.lastEditedAt,
        );
        if (changedAt > lastRelevantChangeAt) {
          lastRelevantChangeAt = changedAt;
        }
      }
      targets.push({
        targetId: targetIdFor(thread.id, parent.id, fingerprint),
        threadId: thread.id,
        markerFingerprint: fingerprint,
        threadStateHash: reviewLifecycleThreadStateHash({
          threadId: thread.id,
          comments: comments.map((comment) => ({
            id: comment.id,
            authorLogin: commentAuthorLogin(comment),
            body: comment.body ?? "",
            createdAt: requiredTimestampValue(
              comment.createdAt,
              "github_comment_created_at",
            ),
            updatedAt: comment.updatedAt ?? null,
          })),
        }),
        isResolved: thread.isResolved,
        parentOwnedByIntegration,
        hasRelevantInteractionAfterParent:
          comments.length > 1 || parentHasRelevantTimestampChange,
        parentCreatedAt,
        lastRelevantChangeAt,
      });
    }

    const pageInfo = requiredPageInfo(connection.pageInfo);
    if (!pageInfo.hasNextPage) {
      if (reviewedHeadSha === null) {
        throw new Error("github_lifecycle_head_sha_missing");
      }
      const commandLedgerAfter = await loadCommandLedger(
        client,
        repository,
        scope,
        commandLedgers,
        trustedCommandLedgerAuthors,
      );
      if (
        commandLedgerAfter.reviewedHeadSha !== reviewedHeadSha ||
        commandLedgerAfter.commandLedgerWatermark !==
          commandLedgerBefore.commandLedgerWatermark ||
        commandLedgerAfter.commandLedgerStateDigest !==
          commandLedgerBefore.commandLedgerStateDigest
      ) {
        throw new Error("github_command_ledger_changed_during_inventory");
      }
      const sortedTargets = [...targets].sort(compareTargets);
      assertUniqueTargets(sortedTargets);
      return {
        status: LiveReviewPublicationLifecycleStatus.Available,
        reviewedHeadSha,
        commandLedgerWatermark: commandLedgerAfter.commandLedgerWatermark,
        targets: Object.freeze(sortedTargets),
      };
    }
    cursor = nextCursor(pageInfo, seenCursors, "github_thread_cursor");
  }
  throw new Error("github_thread_pagination_limit_exceeded");
}

async function loadCommandLedger(
  client: GitHubGraphqlClient,
  repository: GitHubReviewLifecycleRepository,
  scope: ReviewPublicationScope,
  commandLedgers: ReviewCommandLedgerVerificationPort,
  trustedCommandLedgerAuthors: ReadonlySet<string>,
): Promise<{
  readonly reviewedHeadSha: string;
  readonly commandLedgerWatermark: bigint;
  readonly commandLedgerStateDigest: string | null;
}> {
  let cursor: string | null = null;
  let reviewedHeadSha: string | null = null;
  let latestCommandLedger: {
    readonly watermark: bigint;
    readonly stateDigest: string;
  } | null = null;
  let markerWithoutValidSignature = false;
  const seenCursors = new Set<string>();

  for (let page = 0; page < maxCommandLedgerPages; page += 1) {
    const response = await client.graphql<{
      readonly repository?: {
        readonly pullRequest?: {
          readonly headRefOid?: string | null;
          readonly comments?: {
            readonly pageInfo?: PageInfo | null;
            readonly nodes?: readonly (IssueComment | null)[] | null;
          } | null;
        } | null;
      } | null;
    }>(commandLedgerQuery, {
      owner: repository.owner,
      repo: repository.repo,
      prNumber: scope.pullRequestNumber,
      commentsAfter: cursor,
    });
    const pullRequest = requiredPullRequest(response, "github_command_ledger");
    const connection = pullRequest?.comments;
    if (!connection || !Array.isArray(connection.nodes)) {
      throw new Error("github_command_ledger_unavailable");
    }
    const pageHeadSha = commitSha(pullRequest.headRefOid);
    if (reviewedHeadSha !== null && reviewedHeadSha !== pageHeadSha) {
      throw new Error("github_command_ledger_head_changed_during_pagination");
    }
    reviewedHeadSha = pageHeadSha;

    for (const comment of connection.nodes) {
      if (comment === null) throw new Error("github_issue_comment_null");
      const body = comment.body ?? "";
      if (!commandLedgerMarkerPresence.test(body)) continue;
      if (
        !isTrustedGitHubCommentAuthor(
          comment,
          trustedCommandLedgerAuthors,
          "github_command_ledger",
        )
      ) {
        continue;
      }
      const verification = await commandLedgers.verify({
        scope,
        repository,
        markerBody: body,
      });
      if (verification.status === ReviewCommandLedgerVerificationStatus.Valid) {
        if (
          latestCommandLedger !== null &&
          verification.commandLedgerWatermark ===
            latestCommandLedger.watermark &&
          verification.commandLedgerStateDigest !==
            latestCommandLedger.stateDigest
        ) {
          throw new Error("github_command_ledger_ambiguous");
        }
        if (
          latestCommandLedger === null ||
          verification.commandLedgerWatermark > latestCommandLedger.watermark
        ) {
          latestCommandLedger = {
            watermark: verification.commandLedgerWatermark,
            stateDigest: verification.commandLedgerStateDigest,
          };
        }
      } else {
        markerWithoutValidSignature = true;
      }
    }

    const pageInfo = requiredPageInfo(connection.pageInfo);
    if (!pageInfo.hasNextPage) {
      if (reviewedHeadSha === null) {
        throw new Error("github_command_ledger_head_sha_missing");
      }
      if (latestCommandLedger === null && markerWithoutValidSignature) {
        throw new Error("github_command_ledger_unverifiable");
      }
      return {
        reviewedHeadSha,
        commandLedgerWatermark: latestCommandLedger?.watermark ?? 0n,
        commandLedgerStateDigest: latestCommandLedger?.stateDigest ?? null,
      };
    }
    cursor = nextCursor(pageInfo, seenCursors, "github_ledger_cursor");
  }
  throw new Error("github_command_ledger_pagination_limit_exceeded");
}

export function trustedReviewCommandLedgerAuthorsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): ReadonlySet<string> {
  const appSlugs = [
    env.GITHUB_APP_SLUG,
    env.REVIEW_APP_SLUG,
    env.REVIEW_ROUTER_APP_SLUG,
    env.REVIEWROUTER_APP_SLUG,
    env.AI_ROBOT_REVIEW_APP_SLUG,
  ];
  const configuredAuthors = [
    env.REVIEW_APP_BOT_LOGIN,
    env.REVIEW_ROUTER_APP_BOT_LOGIN,
    env.REVIEWROUTER_APP_BOT_LOGIN,
    ...splitCommaSeparated(env.REVIEW_THREAD_LIFECYCLE_TRUSTED_AUTHORS),
    ...splitCommaSeparated(env.REVIEW_ROUTER_TRUSTED_BOT_AUTHORS),
  ];
  const githubActionsAuthor =
    env.REVIEWROUTER_COMMENT_TOKEN_MODE !== "app-oidc" ||
    env.REVIEW_ROUTER_COMMENT_TOKEN_STATUS === "fallback"
      ? "github-actions[bot]"
      : undefined;
  return new Set(
    [
      "review-router-ai[bot]",
      githubActionsAuthor,
      ...appSlugs.map((slug) => {
        const normalized = slug?.trim();
        return normalized ? `${normalized}[bot]` : undefined;
      }),
      ...configuredAuthors,
    ]
      .map(canonicalGitHubLogin)
      .filter((value): value is string => value !== null),
  );
}

function isTrustedGitHubCommentAuthor(
  comment: IssueComment | ReviewComment,
  trustedAuthors: ReadonlySet<string>,
  field: string,
): boolean {
  if (comment.viewerDidAuthor === true) return true;
  if (comment.viewerDidAuthor !== false) {
    throw new Error(`${field}_author_ownership_invalid`);
  }
  if (!Object.prototype.hasOwnProperty.call(comment, "author")) {
    throw new Error(`${field}_author_missing`);
  }
  if (comment.author === null) return false;
  const login = canonicalGitHubLogin(comment.author?.login);
  if (login === null) {
    throw new Error(`${field}_author_invalid`);
  }
  return trustedAuthors.has(login);
}

function canonicalGitHubLogin(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
}

function splitCommaSeparated(value: string | undefined): readonly string[] {
  return (
    value
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean) ?? []
  );
}

async function loadAllComments(
  client: GitHubGraphqlClient,
  thread: ValidReviewThread,
): Promise<readonly ValidReviewComment[]> {
  const initial = thread.comments;
  if (!initial || !Array.isArray(initial.nodes)) {
    throw new Error("github_thread_comments_missing");
  }
  const comments = initial.nodes.map(requiredComment);
  let pageInfo = requiredPageInfo(initial.pageInfo);
  const seenCursors = new Set<string>();

  for (let page = 0; page < maxCommentPagesPerThread; page += 1) {
    if (!pageInfo.hasNextPage) return comments;
    const cursor = nextCursor(pageInfo, seenCursors, "github_comment_cursor");
    const response = await client.graphql<{
      readonly node?: {
        readonly comments?: {
          readonly pageInfo?: PageInfo | null;
          readonly nodes?: readonly (ReviewComment | null)[] | null;
        } | null;
      } | null;
    }>(commentsQuery, { threadId: thread.id, commentsAfter: cursor });
    const connection = response.node?.comments;
    if (!connection || !Array.isArray(connection.nodes)) {
      throw new Error("github_thread_comments_missing");
    }
    comments.push(...connection.nodes.map(requiredComment));
    pageInfo = requiredPageInfo(connection.pageInfo);
  }
  throw new Error("github_comment_pagination_limit_exceeded");
}

function requiredThread(thread: ReviewThread): ValidReviewThread {
  if (typeof thread.id !== "string" || thread.id.length === 0) {
    throw new Error("github_thread_id_invalid");
  }
  if (typeof thread.isResolved !== "boolean") {
    throw new Error("github_thread_resolution_invalid");
  }
  return { ...thread, id: thread.id, isResolved: thread.isResolved };
}

function requiredComment(comment: ReviewComment | null): ValidReviewComment {
  if (!comment || typeof comment.id !== "string" || comment.id.length === 0) {
    throw new Error("github_comment_id_invalid");
  }
  return { ...comment, id: comment.id };
}

class GitHubPullRequestMissingError extends Error {
  constructor() {
    super("github_pull_request_missing");
    this.name = "GitHubPullRequestMissingError";
  }
}

function requiredPullRequest<T extends object>(
  response: {
    readonly repository?: {
      readonly pullRequest?: T | null;
    } | null;
  },
  field: string,
): T {
  const repository = response.repository;
  if (
    !repository ||
    !Object.prototype.hasOwnProperty.call(repository, "pullRequest") ||
    repository.pullRequest === undefined
  ) {
    throw new Error(`${field}_repository_payload_invalid`);
  }
  if (repository.pullRequest === null) {
    throw new GitHubPullRequestMissingError();
  }
  return repository.pullRequest;
}

function commentAuthorLogin(comment: ValidReviewComment): string | null {
  if (!Object.prototype.hasOwnProperty.call(comment, "author")) {
    throw new Error("github_comment_author_missing");
  }
  if (comment.author === null) return null;
  const login = comment.author?.login;
  if (typeof login !== "string" || login.length === 0) {
    throw new Error("github_comment_author_invalid");
  }
  return login;
}

function requiredPageInfo(value?: PageInfo | null): Required<PageInfo> {
  if (!value || typeof value.hasNextPage !== "boolean") {
    throw new Error("github_page_info_invalid");
  }
  return {
    hasNextPage: value.hasNextPage,
    endCursor: value.endCursor ?? null,
  };
}

function nextCursor(
  pageInfo: Required<PageInfo>,
  seen: Set<string>,
  field: string,
): string {
  const cursor = pageInfo.endCursor;
  if (typeof cursor !== "string" || cursor.length === 0 || seen.has(cursor)) {
    throw new Error(`${field}_invalid`);
  }
  seen.add(cursor);
  return cursor;
}

function laterDate(
  createdAt: string | null | undefined,
  updatedAt: string | null | undefined,
  lastEditedAt: string | null | undefined,
): Date {
  const created = timestamp(createdAt, "github_comment_created_at");
  const updated = timestamp(
    updatedAt ?? createdAt,
    "github_comment_updated_at",
  );
  const edited =
    lastEditedAt == null
      ? created
      : timestamp(lastEditedAt, "github_comment_last_edited_at");
  return new Date(
    Math.max(created.getTime(), updated.getTime(), edited.getTime()),
  );
}

function hasRelevantParentTimestampChange(
  parent: ValidReviewComment,
  createdAt: Date,
): boolean {
  // GitHub advances updatedAt when a pending review is submitted without editing its body.
  const updatedAt = timestamp(
    parent.updatedAt ?? parent.createdAt,
    "github_comment_updated_at",
  );
  const publishedAt =
    parent.publishedAt == null
      ? null
      : timestamp(parent.publishedAt, "github_comment_published_at");
  const lastEditedAt =
    parent.lastEditedAt == null
      ? null
      : timestamp(parent.lastEditedAt, "github_comment_last_edited_at");
  if (
    updatedAt < createdAt ||
    (publishedAt !== null &&
      (publishedAt < createdAt || updatedAt < publishedAt)) ||
    (lastEditedAt !== null && lastEditedAt < createdAt)
  ) {
    throw new Error("github_comment_timestamp_order_invalid");
  }
  if (lastEditedAt !== null) return true;
  return publishedAt === null
    ? updatedAt.getTime() !== createdAt.getTime()
    : updatedAt.getTime() !== publishedAt.getTime();
}

function timestamp(value: string | null | undefined, field: string): Date {
  if (typeof value !== "string") throw new Error(`${field}_invalid`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${field}_invalid`);
  return parsed;
}

function requiredTimestampValue(
  value: string | null | undefined,
  field: string,
): string {
  if (typeof value !== "string") {
    throw new Error(`${field}_invalid`);
  }
  timestamp(value, field);
  return value;
}

function commitSha(value: string | null | undefined): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/iu.test(value)) {
    throw new Error("github_lifecycle_head_sha_invalid");
  }
  return value.toLowerCase();
}

function positiveSafeInteger(value: string, field: string): number {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${field}_invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${field}_invalid`);
  return parsed;
}

function targetIdFor(
  threadId: string,
  parentCommentId: string,
  fingerprint: string,
): string {
  return `rrt_${createHash("sha256")
    .update(`${threadId}\n${parentCommentId}\n${fingerprint}`)
    .digest("hex")
    .slice(0, 16)}`;
}

function compareTargets(
  left: LiveReviewPublicationLifecycleTargetIdentity,
  right: LiveReviewPublicationLifecycleTargetIdentity,
): number {
  return (
    left.targetId.localeCompare(right.targetId) ||
    left.threadId.localeCompare(right.threadId)
  );
}

function assertUniqueTargets(
  targets: readonly LiveReviewPublicationLifecycleTargetIdentity[],
): void {
  const identities = new Set<string>();
  for (const target of targets) {
    const identity = `${target.targetId}\n${target.threadId}`;
    if (identities.has(identity)) {
      throw new Error("github_lifecycle_target_duplicate");
    }
    identities.add(identity);
  }
}
