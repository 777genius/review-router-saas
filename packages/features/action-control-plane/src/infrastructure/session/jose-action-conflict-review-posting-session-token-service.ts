import { jwtVerify, SignJWT } from "jose";
import {
  isSafeConflictReviewDispatchId,
  isSafeGitHubBranchName,
} from "@reviewrouter/shared";
import {
  actionConflictReviewPostingSessionAudience,
  type ActionConflictReviewPostingSessionClaims,
} from "../../domain/action-control-plane.js";
import type { ActionConflictReviewPostingSessionTokenServicePort } from "../../application/ports/action-conflict-review-posting-session-token-service-port.js";

const postingSessionIssuer = "reviewrouter-conflict-posting-control-plane";

export class JoseActionConflictReviewPostingSessionTokenService implements ActionConflictReviewPostingSessionTokenServicePort {
  private readonly secretKey: Uint8Array;

  constructor(secret: string) {
    if (secret.length < 32) {
      throw new Error("conflict_posting_session_secret_too_short");
    }
    this.secretKey = new TextEncoder().encode(secret);
  }

  async sign(input: {
    readonly claims: ActionConflictReviewPostingSessionClaims;
    readonly expiresInSeconds: number;
    readonly issuedAt: Date;
  }): Promise<{ readonly token: string; readonly expiresAt: Date }> {
    const issuedAtSeconds = Math.floor(input.issuedAt.getTime() / 1000);
    const expiresAtSeconds = issuedAtSeconds + input.expiresInSeconds;
    const token = await new SignJWT({ ...input.claims })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(postingSessionIssuer)
      .setAudience(actionConflictReviewPostingSessionAudience)
      .setIssuedAt(issuedAtSeconds)
      .setExpirationTime(expiresAtSeconds)
      .sign(this.secretKey);

    return {
      token,
      expiresAt: new Date(expiresAtSeconds * 1000),
    };
  }

  async verify(input: {
    readonly token: string;
    readonly now: Date;
  }): Promise<ActionConflictReviewPostingSessionClaims> {
    const verified = await jwtVerify(input.token, this.secretKey, {
      issuer: postingSessionIssuer,
      audience: actionConflictReviewPostingSessionAudience,
      currentDate: input.now,
      clockTolerance: "5 seconds",
    });
    const payload = verified.payload;

    if (payload.purpose !== "conflict-review-posting") {
      throw new Error("invalid_conflict_posting_session_purpose");
    }
    return {
      purpose: "conflict-review-posting",
      attemptId: assertString(payload.attemptId, "attemptId"),
      workspaceId: assertString(payload.workspaceId, "workspaceId"),
      repositoryId: assertString(payload.repositoryId, "repositoryId"),
      githubRepositoryId: assertNumericString(
        payload.githubRepositoryId,
        "githubRepositoryId",
      ),
      githubInstallationId: assertNumericString(
        payload.githubInstallationId,
        "githubInstallationId",
      ),
      repository: assertString(payload.repository, "repository"),
      githubRunId: assertString(payload.githubRunId, "githubRunId"),
      githubRunAttempt: assertString(
        payload.githubRunAttempt,
        "githubRunAttempt",
      ),
      dispatchId: assertConflictDispatchId(payload.dispatchId),
      pullRequestNumber: assertPositiveInteger(
        payload.pullRequestNumber,
        "pullRequestNumber",
      ),
      headSha: assertSha(payload.headSha, "headSha"),
      baseRef: assertSafeBaseRef(payload.baseRef),
      baseSha: assertSha(payload.baseSha, "baseSha"),
      configSnapshotId: assertString(
        payload.configSnapshotId,
        "configSnapshotId",
      ),
      manifestHash: assertSha256(payload.manifestHash, "manifestHash"),
      operationScopeHash: assertSha256(
        payload.operationScopeHash,
        "operationScopeHash",
      ),
      protocolVersion: 1,
    };
  }
}

function assertString(value: unknown, claim: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid_conflict_posting_session_${claim}`);
  }
  return value;
}

function assertNumericString(value: unknown, claim: string): string {
  const stringValue = assertString(value, claim);
  if (!/^[0-9]+$/.test(stringValue)) {
    throw new Error(`invalid_conflict_posting_session_${claim}`);
  }
  return stringValue;
}

function assertPositiveInteger(value: unknown, claim: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`invalid_conflict_posting_session_${claim}`);
  }
  return value;
}

function assertSha(value: unknown, claim: string): string {
  const stringValue = assertString(value, claim);
  if (!/^[a-fA-F0-9]{40}$/.test(stringValue)) {
    throw new Error(`invalid_conflict_posting_session_${claim}`);
  }
  return stringValue;
}

function assertSha256(value: unknown, claim: string): string {
  const stringValue = assertString(value, claim);
  if (!/^[a-fA-F0-9]{64}$/.test(stringValue)) {
    throw new Error(`invalid_conflict_posting_session_${claim}`);
  }
  return stringValue;
}

function assertConflictDispatchId(value: unknown): string {
  const dispatchId = assertString(value, "dispatchId");
  if (!isSafeConflictReviewDispatchId(dispatchId)) {
    throw new Error("invalid_conflict_posting_session_dispatchId");
  }
  return dispatchId;
}

function assertSafeBaseRef(value: unknown): string {
  const baseRef = assertString(value, "baseRef");
  if (!isSafeGitHubBranchName(baseRef)) {
    throw new Error("invalid_conflict_posting_session_baseRef");
  }
  return baseRef;
}
