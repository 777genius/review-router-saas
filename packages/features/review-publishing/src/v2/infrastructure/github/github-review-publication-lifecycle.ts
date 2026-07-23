import { createHash } from "node:crypto";
import { App } from "@octokit/app";
import {
  LiveReviewPublicationLifecycleStatus,
  type LiveReviewPublicationLifecycleDecision,
  type LiveReviewPublicationLifecyclePort,
  type LiveReviewPublicationLifecycleTargetIdentity,
} from "../../application/ports/review-publication-ports";
import type { ReviewPublicationScope } from "../../domain/review-publication-attempt";

const findingMarker = /<!--\s*review-router-finding:([a-f0-9]{24,64})\s*-->/iu;
const commandLedgerMarker =
  /<!--\s*reviewrouter-ledger:v1\s+payload=([A-Za-z0-9_-]+)\s+signature=([a-f0-9]{64})\s*-->/iu;
const commandLedgerMarkerPresence = /<!--\s*reviewrouter-ledger:v1\b/iu;
const maxThreadPages = 100;
const maxCommentPagesPerThread = 100;
const maxCommandLedgerPages = 100;

export type GitHubReviewLifecycleRepository = {
  readonly githubInstallationId: string;
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
  readonly updatedAt?: string | null;
  readonly lastEditedAt?: string | null;
  readonly viewerDidAuthor?: boolean | null;
};

type IssueComment = {
  readonly body?: string | null;
  readonly viewerDidAuthor?: boolean | null;
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
              id body createdAt updatedAt lastEditedAt viewerDidAuthor
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
        nodes { id body createdAt updatedAt lastEditedAt viewerDidAuthor }
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
        nodes { body viewerDidAuthor }
      }
    }
  }
}`;

export class GitHubReviewPublicationLifecycleAdapter implements LiveReviewPublicationLifecyclePort {
  constructor(
    private readonly repositories: GitHubReviewLifecycleRepositoryQueryPort,
    private readonly clients: GitHubInstallationGraphqlClientFactoryPort,
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
      return await loadInventory(client, repository, scope.pullRequestNumber);
    } catch {
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
  pullRequestNumber: number,
): Promise<LiveReviewPublicationLifecycleDecision> {
  const commandLedgerBefore = await loadCommandLedger(
    client,
    repository,
    pullRequestNumber,
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
      prNumber: pullRequestNumber,
      threadsAfter: cursor,
    });
    const pullRequest = response.repository?.pullRequest;
    const connection = pullRequest?.reviewThreads;
    if (!pullRequest || !connection || !Array.isArray(connection.nodes)) {
      return { status: LiveReviewPublicationLifecycleStatus.Missing };
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
      const fingerprint = findingMarker.exec(parent?.body ?? "")?.[1];
      if (!parent || !fingerprint) continue;
      const parentCreatedAt = timestamp(
        parent.createdAt,
        "github_parent_created_at",
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
        targetId: targetIdFor(thread.id, parent.id, fingerprint.toLowerCase()),
        threadId: thread.id,
        markerFingerprint: fingerprint.toLowerCase(),
        isResolved: thread.isResolved,
        parentOwnedByIntegration: requiredBoolean(
          parent.viewerDidAuthor,
          "github_parent_ownership",
        ),
        hasRelevantInteractionAfterParent:
          comments.length > 1 || parent.lastEditedAt != null,
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
        pullRequestNumber,
      );
      if (
        commandLedgerAfter.reviewedHeadSha !== reviewedHeadSha ||
        commandLedgerAfter.commandLedgerWatermark !==
          commandLedgerBefore.commandLedgerWatermark
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
  pullRequestNumber: number,
): Promise<{
  readonly reviewedHeadSha: string;
  readonly commandLedgerWatermark: bigint;
}> {
  let cursor: string | null = null;
  let reviewedHeadSha: string | null = null;
  let commandLedgerWatermark: bigint | null = null;
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
      prNumber: pullRequestNumber,
      commentsAfter: cursor,
    });
    const pullRequest = response.repository?.pullRequest;
    const connection = pullRequest?.comments;
    if (!pullRequest || !connection || !Array.isArray(connection.nodes)) {
      throw new Error("github_command_ledger_missing");
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
        !requiredBoolean(comment.viewerDidAuthor, "github_ledger_ownership")
      ) {
        continue;
      }
      if (commandLedgerWatermark !== null) {
        throw new Error("github_command_ledger_ambiguous");
      }
      commandLedgerWatermark = parseCommandLedgerWatermark(
        body,
        repository,
        pullRequestNumber,
      );
    }

    const pageInfo = requiredPageInfo(connection.pageInfo);
    if (!pageInfo.hasNextPage) {
      if (reviewedHeadSha === null) {
        throw new Error("github_command_ledger_head_sha_missing");
      }
      return {
        reviewedHeadSha,
        commandLedgerWatermark: commandLedgerWatermark ?? 0n,
      };
    }
    cursor = nextCursor(pageInfo, seenCursors, "github_ledger_cursor");
  }
  throw new Error("github_command_ledger_pagination_limit_exceeded");
}

function parseCommandLedgerWatermark(
  body: string,
  repository: GitHubReviewLifecycleRepository,
  pullRequestNumber: number,
): bigint {
  const encoded = commandLedgerMarker.exec(body)?.[1];
  if (!encoded) throw new Error("github_command_ledger_marker_invalid");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("github_command_ledger_payload_invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("github_command_ledger_payload_invalid");
  }
  const payload = value as Readonly<Record<string, unknown>>;
  if (
    payload.version !== 1 ||
    payload.repo !== `${repository.owner}/${repository.repo}` ||
    payload.pr !== pullRequestNumber ||
    !Array.isArray(payload.entries)
  ) {
    throw new Error("github_command_ledger_payload_invalid");
  }
  let watermark = 0n;
  for (const candidate of payload.entries) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw new Error("github_command_ledger_entry_invalid");
    }
    const entry = candidate as Readonly<Record<string, unknown>>;
    if (entry.action !== "skip" && entry.action !== "unskip") {
      throw new Error("github_command_ledger_entry_invalid");
    }
    const rawId = entry.commandCommentId ?? entry.parentCommentId;
    if (
      typeof rawId !== "number" ||
      !Number.isSafeInteger(rawId) ||
      rawId <= 0
    ) {
      throw new Error("github_command_ledger_entry_invalid");
    }
    const id = BigInt(rawId);
    if (id > watermark) watermark = id;
  }
  return watermark;
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

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field}_invalid`);
  return value;
}

function timestamp(value: string | null | undefined, field: string): Date {
  if (typeof value !== "string") throw new Error(`${field}_invalid`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${field}_invalid`);
  return parsed;
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
