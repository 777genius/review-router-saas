import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  isSafeGitHubBranchName,
  safeConflictReviewDispatchId,
  safeGitHubBranchName,
} from "@reviewrouter/shared";
import { z } from "zod";

export const conflictReviewFallbackVersion = 1;
export const conflictReviewDispatchEventType = "reviewrouter_conflict_review";
export const conflictReviewOutboxEventType =
  "conflict_review.detection_requested";
export const conflictReviewReviewKind = "conflict-head";
export const conflictReviewStatusContext = "ReviewRouter conflict review";
export const conflictReviewAttemptExchangeTtlMs = 60 * 60 * 1000;

export type ConflictReviewSkipReason =
  | "repository_not_registered"
  | "repository_not_selected"
  | "installation_not_active"
  | "workflow_not_configured"
  | "workflow_missing_conflict_capability"
  | "pr_not_open"
  | "pr_is_draft"
  | "fork_pr"
  | "base_ref_unsafe"
  | "mergeable_state_not_conflict"
  | "github_mergeability_unknown"
  | "dispatch_already_recorded";

export type ConflictReviewAttemptStatus =
  | "recorded"
  | "dispatched"
  | "started"
  | "completed"
  | "failed"
  | "skipped"
  | "stale";

export type ConflictReviewRepository = {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly githubRepositoryId: string;
  readonly githubInstallationId: string;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly selected: boolean;
  readonly installationStatus: string;
};

export type ConflictReviewPullRequestSnapshot = {
  readonly repositoryFullName: string;
  readonly number: number;
  readonly state: "open" | "closed" | string;
  readonly draft: boolean;
  readonly merged: boolean;
  readonly headSha: string;
  readonly headRef: string;
  readonly headRepositoryFullName: string;
  readonly baseSha: string;
  readonly baseRef: string;
  readonly baseRepositoryFullName: string;
  readonly mergeable: boolean | null;
  readonly mergeableState: string | null;
};

export type ConflictReviewEligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: ConflictReviewSkipReason };

export type ConflictReviewAttemptIdentity = {
  readonly repositoryId: string;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly fallbackVersion: number;
};

export type NewConflictReviewAttempt = ConflictReviewAttemptIdentity & {
  readonly workspaceId: string;
  readonly githubRepositoryId: string;
  readonly githubInstallationId: string;
  readonly dispatchId: string;
  readonly dispatchNonceHash: string;
  readonly dispatchEventType: typeof conflictReviewDispatchEventType;
  readonly createdAt: Date;
};

export type ConflictReviewAttempt = NewConflictReviewAttempt & {
  readonly id: string;
  readonly status: ConflictReviewAttemptStatus;
};

export const conflictReviewDispatchPayloadSchema = z
  .object({
    protocol_version: z.literal(1),
    dispatch_id: safeConflictReviewDispatchId,
    nonce: z.string().min(32).max(160),
    repository_id: z.string().regex(/^[0-9]+$/),
    pr_number: z.number().int().positive(),
    head_sha: z.string().regex(/^[a-fA-F0-9]{40}$/),
    base_ref: safeGitHubBranchName,
    base_sha: z.string().regex(/^[a-fA-F0-9]{40}$/),
    fallback_version: z.literal(conflictReviewFallbackVersion),
  })
  .strict();

export type ConflictReviewDispatchPayload = z.infer<
  typeof conflictReviewDispatchPayloadSchema
>;

export function classifyConflictReviewEligibility(input: {
  readonly repository: ConflictReviewRepository;
  readonly pullRequest: ConflictReviewPullRequestSnapshot;
}): ConflictReviewEligibility {
  if (!input.repository.selected) {
    return { eligible: false, reason: "repository_not_selected" };
  }
  if (input.repository.installationStatus !== "active") {
    return { eligible: false, reason: "installation_not_active" };
  }
  if (input.pullRequest.state !== "open" || input.pullRequest.merged) {
    return { eligible: false, reason: "pr_not_open" };
  }
  if (input.pullRequest.draft) {
    return { eligible: false, reason: "pr_is_draft" };
  }
  if (
    input.pullRequest.headRepositoryFullName.toLowerCase() !==
      input.repository.fullName.toLowerCase() ||
    input.pullRequest.baseRepositoryFullName.toLowerCase() !==
      input.repository.fullName.toLowerCase()
  ) {
    return { eligible: false, reason: "fork_pr" };
  }
  if (!isSafeGitHubBranchName(input.pullRequest.baseRef)) {
    return { eligible: false, reason: "base_ref_unsafe" };
  }
  if (
    input.pullRequest.mergeable === false &&
    input.pullRequest.mergeableState === "dirty"
  ) {
    return { eligible: true };
  }
  if (
    input.pullRequest.mergeable === null ||
    !input.pullRequest.mergeableState
  ) {
    return { eligible: false, reason: "github_mergeability_unknown" };
  }
  return { eligible: false, reason: "mergeable_state_not_conflict" };
}

export function buildConflictReviewAttemptKey(
  identity: ConflictReviewAttemptIdentity,
): string {
  return [
    "conflict-review",
    identity.repositoryId,
    identity.pullRequestNumber,
    identity.headSha,
    identity.baseRef,
    identity.baseSha,
    identity.fallbackVersion,
  ].join(":");
}

export function createConflictReviewDispatchIdentity(input: {
  readonly githubRepositoryId: string;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly baseRef: string;
  readonly baseSha: string;
}): {
  readonly dispatchId: string;
  readonly nonce: string;
  readonly nonceHash: string;
  readonly payload: ConflictReviewDispatchPayload;
} {
  const dispatchId = `cr_${randomUUID()}`;
  const nonce = randomBytes(32).toString("base64url");
  const payload = conflictReviewDispatchPayloadSchema.parse({
    protocol_version: 1,
    dispatch_id: dispatchId,
    nonce,
    repository_id: input.githubRepositoryId,
    pr_number: input.pullRequestNumber,
    head_sha: input.headSha,
    base_ref: input.baseRef,
    base_sha: input.baseSha,
    fallback_version: conflictReviewFallbackVersion,
  });
  return {
    dispatchId,
    nonce,
    nonceHash: hashConflictReviewDispatchNonce(nonce),
    payload,
  };
}

export function hashConflictReviewDispatchNonce(nonce: string): string {
  return createHash("sha256").update(nonce, "utf8").digest("hex");
}

export function assertSafeConflictReviewDispatchPayload(
  payload: unknown,
): ConflictReviewDispatchPayload {
  return conflictReviewDispatchPayloadSchema.parse(payload);
}

export function safeConflictReviewErrorSummary(
  error: unknown,
  secrets: readonly string[] = [],
): string {
  const message = error instanceof Error ? error.message : "unknown_error";
  let summary = message.replaceAll(/\s+/g, " ");
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    summary = summary.replaceAll(secret, "[redacted]");
  }
  return summary.slice(0, 500);
}
