import {
  assertIdentifier,
  assertReviewExecutionScope,
  assertSha256,
  type ReviewExecutionScope,
} from "./review-execution";
import { ReviewRequestedTriggerKind } from "./review-requested-intent";

export const reviewRequestIngressEventType = "review.request.ingress";
export const reviewRequestIngressEventVersion = 1;

export enum ReviewRequestIngressCommandKind {
  Request = "request",
  Cancel = "cancel",
}

export type ReviewRequestIngressRepository = ReviewExecutionScope & {
  readonly githubInstallationId: string;
  readonly repositoryFullName: string;
};

type ReviewRequestIngressBase = ReviewRequestIngressRepository & {
  readonly protocolVersion: 1;
  readonly commandKind: ReviewRequestIngressCommandKind;
  readonly deliveryIdentityHash: string;
};

export type ReviewRequestIngressPayload =
  | (ReviewRequestIngressBase & {
      readonly commandKind: ReviewRequestIngressCommandKind.Request;
      readonly requestId: string;
      readonly triggerKind: ReviewRequestedTriggerKind;
      readonly expectedBaseSha: string | null;
      readonly expectedHeadSha: string;
      readonly quietPeriodMs: number;
      readonly retentionMs: number;
    })
  | (ReviewRequestIngressBase & {
      readonly commandKind: ReviewRequestIngressCommandKind.Cancel;
    });

export function parseReviewRequestIngressPayload(
  value: unknown,
): ReviewRequestIngressPayload {
  if (!isRecord(value) || value.protocolVersion !== 1) {
    throw new Error("review_request_ingress_payload_invalid");
  }
  const repository = parseRepository(value);
  const deliveryIdentityHash = requiredString(
    value.deliveryIdentityHash,
    "delivery_identity_hash",
  );
  assertSha256(deliveryIdentityHash, "delivery_identity_hash");
  if (value.commandKind === ReviewRequestIngressCommandKind.Cancel) {
    return {
      protocolVersion: 1,
      commandKind: ReviewRequestIngressCommandKind.Cancel,
      ...repository,
      deliveryIdentityHash,
    };
  }
  if (value.commandKind !== ReviewRequestIngressCommandKind.Request) {
    throw new Error("review_request_ingress_command_invalid");
  }
  const requestId = requiredString(value.requestId, "request_id");
  assertIdentifier(requestId, "request_id");
  const triggerKind = parseReviewRequestedTriggerKind(value.triggerKind);
  const expectedBaseSha = nullableCommitSha(value.expectedBaseSha);
  const expectedHeadSha = commitSha(value.expectedHeadSha);
  const quietPeriodMs = boundedDuration(value.quietPeriodMs, 0, 300_000);
  const retentionMs = boundedDuration(
    value.retentionMs,
    60_000,
    90 * 24 * 60 * 60 * 1_000,
  );
  return {
    protocolVersion: 1,
    commandKind: ReviewRequestIngressCommandKind.Request,
    ...repository,
    deliveryIdentityHash,
    requestId,
    triggerKind,
    expectedBaseSha,
    expectedHeadSha,
    quietPeriodMs,
    retentionMs,
  };
}

function parseReviewRequestedTriggerKind(
  value: unknown,
): ReviewRequestedTriggerKind {
  switch (value) {
    case ReviewRequestedTriggerKind.PullRequestSynchronized:
      return ReviewRequestedTriggerKind.PullRequestSynchronized;
    case ReviewRequestedTriggerKind.PullRequestReadyForReview:
      return ReviewRequestedTriggerKind.PullRequestReadyForReview;
    case ReviewRequestedTriggerKind.ManualCommand:
      return ReviewRequestedTriggerKind.ManualCommand;
    case ReviewRequestedTriggerKind.LifecycleChanged:
      return ReviewRequestedTriggerKind.LifecycleChanged;
    default:
      throw new Error("review_request_ingress_trigger_invalid");
  }
}

function parseRepository(
  value: Readonly<Record<string, unknown>>,
): ReviewRequestIngressRepository {
  const repository = {
    workspaceId: requiredString(value.workspaceId, "workspace_id"),
    repositoryConnectionId: requiredString(
      value.repositoryConnectionId,
      "repository_connection_id",
    ),
    scmRepositoryIdentityId: requiredString(
      value.scmRepositoryIdentityId,
      "scm_repository_identity_id",
    ),
    pullRequestNumber: value.pullRequestNumber,
    githubInstallationId: requiredString(
      value.githubInstallationId,
      "github_installation_id",
    ),
    repositoryFullName: requiredString(
      value.repositoryFullName,
      "repository_full_name",
    ),
  };
  assertReviewExecutionScope(repository as ReviewExecutionScope);
  if (!/^[1-9][0-9]*$/.test(repository.githubInstallationId)) {
    throw new Error("review_request_ingress_installation_invalid");
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository.repositoryFullName)) {
    throw new Error("review_request_ingress_repository_invalid");
  }
  return repository as ReviewRequestIngressRepository;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`review_request_ingress_${field}_invalid`);
  }
  return value;
}

function commitSha(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/i.test(value)) {
    throw new Error("review_request_ingress_commit_sha_invalid");
  }
  return value.toLowerCase();
}

function nullableCommitSha(value: unknown): string | null {
  return value === null ? null : commitSha(value);
}

function boundedDuration(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error("review_request_ingress_duration_invalid");
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
