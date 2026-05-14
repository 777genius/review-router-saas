import { createHash } from "node:crypto";
import type { Clock } from "@reviewrouter/shared";
import { conflictReviewAdvisoryStatusContext } from "../../domain/action-control-plane.js";
import type { ActionConflictReviewPostingGatewayPort } from "../ports/action-conflict-review-posting-gateway-port.js";
import type { ActionConflictReviewPostingSessionRepositoryPort } from "../ports/action-conflict-review-posting-session-repository-port.js";
import type { ActionConflictReviewPostingSessionTokenServicePort } from "../ports/action-conflict-review-posting-session-token-service-port.js";
import type { ActionConflictReviewPrePostValidatorPort } from "../ports/action-conflict-review-pre-post-validator-port.js";

export type PostConflictReviewStatusDependencies = {
  readonly conflictPostingSessions?: ActionConflictReviewPostingSessionRepositoryPort;
  readonly postingSessions?: ActionConflictReviewPostingSessionTokenServicePort;
  readonly conflictPostingGateway?: ActionConflictReviewPostingGatewayPort;
  readonly conflictPrePostValidator?: ActionConflictReviewPrePostValidatorPort;
  readonly clock: Clock;
};

export async function postConflictReviewStatus(
  input: {
    readonly postingSessionToken: string;
    readonly protocolVersion: 1;
    readonly state: "success" | "failure" | "error";
    readonly description?: string | undefined;
  },
  dependencies: PostConflictReviewStatusDependencies,
): Promise<{
  readonly protocolVersion: 1;
  readonly status: "posted" | "already_posted";
  readonly githubExternalId: string;
  readonly githubUrl: string | null;
}> {
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
  const description = validateStatusDescription(
    input.description ??
      "Advisory conflict-head review completed. Resolve conflicts for normal merge-result review.",
  );
  const bodyHash = sha256(
    canonicalJson({
      context: conflictReviewAdvisoryStatusContext,
      description,
      headSha: scope.headSha,
      state: input.state,
    }),
  );
  const operationFingerprint = sha256(
    canonicalJson({
      kind: "advisory_status",
      dispatchId: scope.dispatchId,
      manifestHash: scope.manifestHash,
      bodyHash,
    }),
  );
  const intent =
    await dependencies.conflictPostingSessions.reserveConflictReviewPostingIntent(
      {
        scope,
        operationKind: "advisory_status",
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
      await dependencies.conflictPostingGateway.postConflictReviewAdvisoryStatus(
        {
          githubInstallationId: scope.githubInstallationId,
          githubRepositoryId: scope.githubRepositoryId,
          repositoryFullName: scope.repository,
          pullRequestNumber: scope.pullRequestNumber,
          headSha: scope.headSha,
          baseRef: scope.baseRef,
          baseSha: scope.baseSha,
          context: conflictReviewAdvisoryStatusContext,
          state: input.state,
          description,
        },
      );
    await dependencies.conflictPostingSessions.commitConflictReviewPostingIntent(
      {
        scope,
        intentId: intent.intentId,
        operationKind: "advisory_status",
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
        operationKind: "advisory_status",
        safeErrorCode: "conflict_status_post_ambiguous",
        safeErrorSummary: safePostingErrorSummary(error),
        failedAt: dependencies.clock.now(),
      },
    );
    throw error;
  }
}

function validateStatusDescription(description: string): string {
  const trimmed = description.trim();
  if (trimmed.length === 0 || trimmed.length > 140) {
    throw new Error("conflict_review_status_description_invalid");
  }
  if (/required|merge result reviewed/i.test(trimmed)) {
    throw new Error("conflict_review_status_claim_forbidden");
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
