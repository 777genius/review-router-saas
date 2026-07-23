import type { Clock } from "@reviewrouter/shared";
import {
  actionConflictReviewPostingSessionTtlSeconds,
  validateActionSessionAgainstRepository,
  type ActionSessionClaims,
} from "../../domain/action-control-plane.js";
import type { ActionConflictReviewPrePostValidatorPort } from "../ports/action-conflict-review-pre-post-validator-port.js";
import type { ActionConflictReviewPostingSessionRepositoryPort } from "../ports/action-conflict-review-posting-session-repository-port.js";
import type { ActionConflictReviewPostingSessionTokenServicePort } from "../ports/action-conflict-review-posting-session-token-service-port.js";
import type { ActionConflictReviewRuntimeGatePort } from "../ports/action-conflict-review-runtime-gate-port.js";
import type { ActionControlPlaneRepositoryPort } from "../ports/action-control-plane-repository-port.js";
import type { ActionEntitlementPolicyPort } from "../ports/action-entitlement-policy-port.js";
import type { ActionSessionTokenServicePort } from "../ports/action-session-token-service-port.js";
import {
  LegacyReviewMutationOperation,
  type LegacyReviewMutationAdmissionPort,
} from "../ports/legacy-review-mutation-admission-port.js";

export type RequestConflictReviewPostingSessionDependencies = {
  readonly repositories: ActionControlPlaneRepositoryPort;
  readonly sessions: ActionSessionTokenServicePort;
  readonly entitlements?: ActionEntitlementPolicyPort;
  readonly conflictReviewRuntimeGate?: ActionConflictReviewRuntimeGatePort;
  readonly conflictPrePostValidator?: ActionConflictReviewPrePostValidatorPort;
  readonly conflictPostingSessions?: ActionConflictReviewPostingSessionRepositoryPort;
  readonly postingSessions?: ActionConflictReviewPostingSessionTokenServicePort;
  readonly legacyMutationAdmission?: LegacyReviewMutationAdmissionPort;
  readonly clock: Clock;
};

export async function requestConflictReviewPostingSession(
  input: {
    readonly sessionToken: string;
    readonly protocolVersion: 1;
    readonly manifestHash: string;
  },
  dependencies: RequestConflictReviewPostingSessionDependencies,
): Promise<{
  readonly protocolVersion: 1;
  readonly postingSessionToken: string;
  readonly expiresAt: string;
  readonly manifestHash: string;
  readonly scope: {
    readonly dispatchId: string;
    readonly pullRequestNumber: number;
    readonly headSha: string;
    readonly baseRef: string;
    readonly baseSha: string;
    readonly allowedOperations: readonly ["summary_comment", "advisory_status"];
  };
}> {
  validatePostingManifestHash(input.manifestHash);
  const session = await dependencies.sessions.verify({
    token: input.sessionToken,
    now: dependencies.clock.now(),
  });
  assertConflictHeadSession(session);
  const repository =
    await dependencies.repositories.findSelectedRepositoryByGithubId(
      session.githubRepositoryId,
    );
  if (!repository) {
    throw new Error("repository_not_registered");
  }
  validateActionSessionAgainstRepository({ session, repository });
  await dependencies.entitlements?.assertActionControlPlaneAllowed({
    workspaceId: session.workspaceId,
    repositoryId: session.repositoryId,
    repositoryFullName: session.repository,
  });
  await dependencies.legacyMutationAdmission?.assertLegacyReviewMutationAllowed(
    {
      operation: LegacyReviewMutationOperation.ConflictPostingSession,
      githubRepositoryId: repository.githubRepositoryId,
      repositoryFullName: repository.fullName,
    },
  );
  await dependencies.conflictReviewRuntimeGate?.assertConflictReviewRuntimeEnabled(
    {
      phase: "posting_session",
      workspaceId: session.workspaceId,
      repositoryId: session.repositoryId,
      repositoryFullName: session.repository,
    },
  );
  if (
    !dependencies.conflictPostingSessions ||
    !dependencies.postingSessions ||
    !dependencies.conflictPrePostValidator
  ) {
    throw new Error("conflict_review_posting_session_unavailable");
  }
  await dependencies.conflictPrePostValidator.assertConflictReviewPrePostState({
    githubInstallationId: repository.githubInstallationId,
    githubRepositoryId: repository.githubRepositoryId,
    repositoryFullName: repository.fullName,
    pullRequestNumber: session.pullRequestNumber,
    headSha: session.headSha,
    baseRef: session.baseRef,
    baseSha: session.baseSha,
  });
  const issuedAt = dependencies.clock.now();
  const scope =
    await dependencies.conflictPostingSessions.issueConflictReviewPostingSession(
      {
        session,
        manifestHash: input.manifestHash,
        issuedAt,
      },
    );
  const postingSession = await dependencies.postingSessions.sign({
    claims: scope,
    expiresInSeconds: actionConflictReviewPostingSessionTtlSeconds,
    issuedAt,
  });

  return {
    protocolVersion: 1,
    postingSessionToken: postingSession.token,
    expiresAt: postingSession.expiresAt.toISOString(),
    manifestHash: scope.manifestHash,
    scope: {
      dispatchId: scope.dispatchId,
      pullRequestNumber: scope.pullRequestNumber,
      headSha: scope.headSha,
      baseRef: scope.baseRef,
      baseSha: scope.baseSha,
      allowedOperations: ["summary_comment", "advisory_status"],
    },
  };
}

type ConflictHeadActionSessionClaims = ActionSessionClaims & {
  readonly reviewKind: "conflict-head";
  readonly conflictDispatchId: string;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly configSnapshotId: string;
};

function assertConflictHeadSession(
  session: ActionSessionClaims,
): asserts session is ConflictHeadActionSessionClaims {
  if (
    session.reviewKind !== "conflict-head" ||
    !session.conflictDispatchId ||
    !session.pullRequestNumber ||
    !session.headSha ||
    !session.baseRef ||
    !session.baseSha ||
    !session.configSnapshotId
  ) {
    throw new Error("conflict_review_session_required");
  }
}

function validatePostingManifestHash(manifestHash: string): void {
  if (!/^[a-f0-9]{64}$/i.test(manifestHash)) {
    throw new Error("conflict_review_posting_manifest_invalid");
  }
}
