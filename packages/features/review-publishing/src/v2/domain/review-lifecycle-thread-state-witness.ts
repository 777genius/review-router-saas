export enum ReviewPublicationLifecycleObservationVersion {
  ThreadStateV1 = "review_lifecycle_observation.v1",
}

export const reviewLifecycleThreadStateVersion =
  "review_lifecycle_thread_state.v1" as const;

export type ReviewLifecycleThreadStateComment = Readonly<{
  id: string;
  authorLogin: string | null;
  bodyHash: string;
  createdAt: string | Date;
  updatedAt: string | Date;
}>;

/** Canonical portable preimage shared by Action producers and SaaS adapters. */
export function canonicalReviewLifecycleThreadStatePreimage(input: {
  readonly threadId: string;
  readonly comments: readonly ReviewLifecycleThreadStateComment[];
}): string {
  const threadId = requiredIdentifier(input.threadId, "thread_id");
  if (input.comments.length === 0) {
    throw new Error("thread_comments_empty");
  }
  const seenIds = new Set<string>();
  const comments = [...input.comments]
    .map((comment) => {
      const id = requiredIdentifier(comment.id, "comment_id");
      if (seenIds.has(id)) {
        throw new Error("comment_id_duplicate");
      }
      seenIds.add(id);
      return {
        id,
        authorLogin: normalizedAuthorLogin(comment.authorLogin),
        bodyHash: requiredSha256(comment.bodyHash, "comment_body_hash"),
        createdAt: normalizedTimestamp(comment.createdAt, "comment_created_at"),
        updatedAt: normalizedTimestamp(comment.updatedAt, "comment_updated_at"),
      };
    })
    .sort((left, right) => compareIdentifiers(left.id, right.id));

  return JSON.stringify([
    reviewLifecycleThreadStateVersion,
    threadId,
    comments.map((comment) => [
      comment.id,
      comment.authorLogin,
      comment.bodyHash,
      comment.createdAt,
      comment.updatedAt,
    ]),
  ]);
}

function normalizedAuthorLogin(value: string | null): string | null {
  if (value === null) return null;
  return requiredIdentifier(value, "comment_author_login").toLowerCase();
}

function normalizedTimestamp(value: string | Date, field: string): string {
  const parsed = new Date(value instanceof Date ? value.getTime() : value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`${field}_invalid`);
  }
  return parsed.toISOString();
}

function requiredIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field}_invalid`);
  }
  return value;
}

function requiredSha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${field}_invalid`);
  }
  return value;
}

function compareIdentifiers(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
