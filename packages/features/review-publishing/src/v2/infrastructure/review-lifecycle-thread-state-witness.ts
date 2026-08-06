import { createHash } from "node:crypto";
import {
  canonicalReviewLifecycleThreadStatePreimage,
  type ReviewLifecycleThreadStateComment,
} from "../domain/review-lifecycle-thread-state-witness";

export type ReviewLifecycleThreadStateRawComment = Readonly<{
  id: string;
  authorLogin: string | null;
  body?: string | null;
  createdAt: string | Date;
  updatedAt?: string | Date | null;
}>;

export function reviewLifecycleThreadStateHash(input: {
  readonly threadId: string;
  readonly comments: readonly ReviewLifecycleThreadStateRawComment[];
}): string {
  const comments: ReviewLifecycleThreadStateComment[] = input.comments.map(
    (comment) => ({
      id: comment.id,
      authorLogin: comment.authorLogin,
      bodyHash: sha256(comment.body ?? ""),
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt ?? comment.createdAt,
    }),
  );
  return sha256(
    canonicalReviewLifecycleThreadStatePreimage({
      threadId: input.threadId,
      comments,
    }),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
