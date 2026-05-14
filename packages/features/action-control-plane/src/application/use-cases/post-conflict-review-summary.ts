import { createHash } from "node:crypto";
import type { Clock } from "@reviewrouter/shared";
import { conflictReviewSummaryMaxBytes } from "../../domain/action-control-plane.js";
import type { ActionConflictReviewPostingGatewayPort } from "../ports/action-conflict-review-posting-gateway-port.js";
import type { ActionConflictReviewPostingSessionRepositoryPort } from "../ports/action-conflict-review-posting-session-repository-port.js";
import type { ActionConflictReviewPostingSessionTokenServicePort } from "../ports/action-conflict-review-posting-session-token-service-port.js";
import type { ActionConflictReviewPrePostValidatorPort } from "../ports/action-conflict-review-pre-post-validator-port.js";

export type PostConflictReviewSummaryDependencies = {
  readonly conflictPostingSessions?: ActionConflictReviewPostingSessionRepositoryPort;
  readonly postingSessions?: ActionConflictReviewPostingSessionTokenServicePort;
  readonly conflictPostingGateway?: ActionConflictReviewPostingGatewayPort;
  readonly conflictPrePostValidator?: ActionConflictReviewPrePostValidatorPort;
  readonly clock: Clock;
};

export async function postConflictReviewSummary(
  input: {
    readonly postingSessionToken: string;
    readonly protocolVersion: 1;
    readonly summaryMarkdown: string;
  },
  dependencies: PostConflictReviewSummaryDependencies,
): Promise<{
  readonly protocolVersion: 1;
  readonly status: "posted" | "already_posted";
  readonly githubExternalId: string;
  readonly githubUrl: string | null;
}> {
  const summaryMarkdown = validateSummaryMarkdown(input.summaryMarkdown);
  if (
    !dependencies.conflictPostingSessions ||
    !dependencies.postingSessions ||
    !dependencies.conflictPostingGateway ||
    !dependencies.conflictPrePostValidator
  ) {
    throw new Error("conflict_review_posting_session_unavailable");
  }
  const scope = await dependencies.postingSessions.verify({
    token: input.postingSessionToken,
    now: dependencies.clock.now(),
  });
  await dependencies.conflictPrePostValidator.assertConflictReviewPrePostState({
    githubInstallationId: scope.githubInstallationId,
    githubRepositoryId: scope.githubRepositoryId,
    repositoryFullName: scope.repository,
    pullRequestNumber: scope.pullRequestNumber,
    headSha: scope.headSha,
    baseRef: scope.baseRef,
    baseSha: scope.baseSha,
  });
  const marker = buildConflictReviewSummaryMarker(scope);
  const body = buildConflictReviewSummaryBody({
    marker,
    summaryMarkdown,
    headSha: scope.headSha,
    baseRef: scope.baseRef,
    baseSha: scope.baseSha,
  });
  const bodyHash = sha256(body);
  const operationFingerprint = sha256(
    canonicalJson({
      kind: "summary_comment",
      dispatchId: scope.dispatchId,
      manifestHash: scope.manifestHash,
      bodyHash,
    }),
  );
  const intent =
    await dependencies.conflictPostingSessions.reserveConflictReviewPostingIntent(
      {
        scope,
        operationKind: "summary_comment",
        operationFingerprint,
        bodyHash,
        requestedAt: dependencies.clock.now(),
      },
    );
  if (intent.status === "completed") {
    return {
      protocolVersion: 1,
      status: "already_posted",
      githubExternalId: intent.githubExternalId,
      githubUrl: intent.githubUrl,
    };
  }
  if (intent.status === "pending") {
    throw new Error("conflict_review_posting_intent_pending");
  }

  try {
    const posted =
      await dependencies.conflictPostingGateway.upsertConflictReviewSummary({
        githubInstallationId: scope.githubInstallationId,
        githubRepositoryId: scope.githubRepositoryId,
        repositoryFullName: scope.repository,
        pullRequestNumber: scope.pullRequestNumber,
        headSha: scope.headSha,
        baseRef: scope.baseRef,
        baseSha: scope.baseSha,
        marker,
        body,
      });
    await dependencies.conflictPostingSessions.commitConflictReviewPostingIntent(
      {
        scope,
        intentId: intent.intentId,
        operationKind: "summary_comment",
        githubExternalId: posted.githubExternalId,
        githubUrl: posted.githubUrl,
        bodyHash,
        completedAt: dependencies.clock.now(),
      },
    );
    return {
      protocolVersion: 1,
      status: "posted",
      githubExternalId: posted.githubExternalId,
      githubUrl: posted.githubUrl ?? null,
    };
  } catch (error) {
    await dependencies.conflictPostingSessions.markConflictReviewPostingIntentAmbiguous(
      {
        scope,
        intentId: intent.intentId,
        operationKind: "summary_comment",
        safeErrorCode: "conflict_summary_post_ambiguous",
        safeErrorSummary: safePostingErrorSummary(error),
        failedAt: dependencies.clock.now(),
      },
    );
    throw error;
  }
}

export function buildConflictReviewSummaryMarker(input: {
  readonly githubRepositoryId?: string;
  readonly pullRequestNumber?: number;
  readonly headSha?: string;
  readonly baseRef?: string;
  readonly baseSha?: string;
  readonly configSnapshotId?: string;
  readonly dispatchId: string;
  readonly manifestHash: string;
}): string {
  return [
    "<!-- reviewrouter:conflict-review:v1",
    `repository_id=${encodeMarkerValue(input.githubRepositoryId ?? "")}`,
    `pr=${encodeMarkerValue(input.pullRequestNumber?.toString() ?? "")}`,
    `head_sha=${encodeMarkerValue(input.headSha ?? "")}`,
    `base_ref=${encodeMarkerValue(input.baseRef ?? "")}`,
    `base_sha=${encodeMarkerValue(input.baseSha ?? "")}`,
    `config_snapshot=${encodeMarkerValue(input.configSnapshotId ?? "")}`,
    `dispatch_id=${encodeMarkerValue(input.dispatchId)}`,
    `manifest_hash=${encodeMarkerValue(input.manifestHash)}`,
    "-->",
  ].join(" ");
}

function buildConflictReviewSummaryBody(input: {
  readonly marker: string;
  readonly summaryMarkdown: string;
  readonly headSha: string;
  readonly baseRef: string;
  readonly baseSha: string;
}): string {
  return [
    "## ReviewRouter conflict review",
    "",
    "> Advisory review for the PR head while the merge result has conflicts. This does not replace the normal ReviewRouter merge-result review after conflicts are resolved.",
    "",
    `Reviewed head: \`${input.headSha}\``,
    `Base ref: \`${input.baseRef}\``,
    `Base SHA: \`${input.baseSha}\``,
    "",
    input.summaryMarkdown.trim(),
    "",
    input.marker,
  ].join("\n");
}

function validateSummaryMarkdown(summaryMarkdown: string): string {
  const trimmed = summaryMarkdown.trim();
  if (
    trimmed.length === 0 ||
    Buffer.byteLength(trimmed, "utf8") > conflictReviewSummaryMaxBytes
  ) {
    throw new Error("conflict_review_summary_invalid");
  }
  if (/reviewrouter:conflict-review/i.test(trimmed)) {
    throw new Error("conflict_review_summary_marker_forbidden");
  }
  if (/merge result was reviewed|required review passed/i.test(trimmed)) {
    throw new Error("conflict_review_summary_claim_forbidden");
  }
  return trimmed;
}

function safePostingErrorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown_error";
  return redactSecretLikeValues(message).replaceAll(/\s+/g, " ").slice(0, 500);
}

function redactSecretLikeValues(message: string): string {
  return message
    .replaceAll(/\bgh[spou]_[A-Za-z0-9_]+\b/g, "[redacted]")
    .replaceAll(/\bgithub_pat_[A-Za-z0-9_]+\b/g, "[redacted]")
    .replaceAll(/\bsk-[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replaceAll(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replaceAll(
      /\b(token|secret|nonce|api[_-]?key|authorization)\s*[:=]\s*\S+/gi,
      "$1=[redacted]",
    );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function encodeMarkerValue(value: string): string {
  return encodeURIComponent(value);
}
