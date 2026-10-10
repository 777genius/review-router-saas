import { canonicalJson } from "../../domain/review-run-control-types";
import type { VerifiedScmRunIdentity } from "../use-cases/manage-review-run-authorizations";

/** Private persisted facts. Admission is reconstructed from the original snapshot,
 * never from mutable configuration or a mirrored account epoch. No capability. */
export type ReviewRunGatewayExecutionBinding = {
  readonly bindingVersion: 1;
  readonly operationId: string;
  readonly executionRef: string;
  readonly accountRef: string;
  readonly authorizationEpoch: number;
  readonly deadline: string;
};

export type ReviewRunGatewayExecutionOwner = {
  readonly authorizationId: string;
  readonly identity: VerifiedScmRunIdentity;
  readonly runtimeSnapshotCanonicalJson: string;
};

export type ReviewRunGatewayExecutionRead =
  | { readonly status: "denied" }
  | {
      readonly status: "live";
      readonly binding: ReviewRunGatewayExecutionBinding | null;
    };
export type ReviewRunGatewayExecutionAttachment =
  | { readonly status: "denied" | "conflict" }
  | {
      readonly status: "attached" | "restored";
      readonly binding: ReviewRunGatewayExecutionBinding;
    };

export interface ReviewRunGatewayExecutionBindingPort {
  /** Rechecks the exact saved owner, original binding and current expiry. */
  read(
    owner: ReviewRunGatewayExecutionOwner,
  ): Promise<ReviewRunGatewayExecutionRead>;
  /** Atomic NULL -> selected facts only. Identical restores; no reset/replacement. */
  attach(
    owner: ReviewRunGatewayExecutionOwner,
    binding: ReviewRunGatewayExecutionBinding,
  ): Promise<ReviewRunGatewayExecutionAttachment>;
}

/** Snapshot only the actual authenticated owned tuple, before any await. */
export function reviewRunGatewayOwnedIdentity(
  identity: VerifiedScmRunIdentity,
): VerifiedScmRunIdentity {
  return {
    workspaceId: identity.workspaceId,
    repositoryConnectionId: identity.repositoryConnectionId,
    scmRepositoryIdentityId: identity.scmRepositoryIdentityId,
    pullRequestNumber: identity.pullRequestNumber,
    baseSha: identity.baseSha,
    mergeBaseSha: identity.mergeBaseSha,
    headSha: identity.headSha,
    reviewRevisionHash: identity.reviewRevisionHash,
    sourceRunId: identity.sourceRunId,
    sourceRunAttempt: identity.sourceRunAttempt,
    workflowIdentityHash: identity.workflowIdentityHash,
    trustDomain: identity.trustDomain,
  };
}

export function parseReviewRunGatewayExecutionBinding(
  value: string,
): ReviewRunGatewayExecutionBinding {
  const fail = (): never => {
    throw new Error("review_run_gateway_execution_binding_invalid");
  };
  if (new TextEncoder().encode(value).byteLength > 2048) fail();
  const row: unknown = JSON.parse(value);
  if (!row || typeof row !== "object" || Array.isArray(row)) return fail();
  const data = row as Record<string, unknown>;
  const names = [
    "bindingVersion",
    "operationId",
    "executionRef",
    "accountRef",
    "authorizationEpoch",
    "deadline",
  ];
  if (
    Object.keys(data).length !== names.length ||
    names.some((key) => !(key in data))
  )
    fail();
  for (const key of ["operationId", "executionRef", "accountRef"]) {
    const reference = data[key];
    if (
      typeof reference !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(reference)
    )
      fail();
  }
  const epoch = data.authorizationEpoch;
  const deadline = data.deadline;
  if (
    data.bindingVersion !== 1 ||
    typeof epoch !== "number" ||
    !Number.isSafeInteger(epoch) ||
    epoch < 0 ||
    typeof deadline !== "string" ||
    !Number.isFinite(Date.parse(deadline)) ||
    new Date(deadline).toISOString() !== deadline ||
    canonicalJson(data) !== value
  )
    return fail();
  return {
    bindingVersion: 1,
    operationId: String(data.operationId),
    executionRef: String(data.executionRef),
    accountRef: String(data.accountRef),
    authorizationEpoch: epoch,
    deadline,
  };
}
