import { jwtVerify, SignJWT } from "jose";
import {
  isSafeConflictReviewDispatchId,
  isSafeGitHubBranchName,
} from "@reviewrouter/shared";
import {
  actionSessionAudience,
  allowedActionEvents,
  type ActionSessionClaims,
} from "../../domain/action-control-plane.js";
import type { ActionSessionTokenServicePort } from "../../application/ports/action-session-token-service-port.js";

const sessionIssuer = "reviewrouter-control-plane";

export class JoseActionSessionTokenService implements ActionSessionTokenServicePort {
  private readonly secretKey: Uint8Array;

  constructor(secret: string) {
    if (secret.length < 32) {
      throw new Error("action_session_secret_too_short");
    }
    this.secretKey = new TextEncoder().encode(secret);
  }

  async sign(input: {
    readonly claims: ActionSessionClaims;
    readonly expiresInSeconds: number;
    readonly issuedAt: Date;
  }): Promise<{ readonly token: string; readonly expiresAt: Date }> {
    const issuedAtSeconds = Math.floor(input.issuedAt.getTime() / 1000);
    const expiresAtSeconds = issuedAtSeconds + input.expiresInSeconds;
    const token = await new SignJWT({ ...input.claims })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(sessionIssuer)
      .setAudience(actionSessionAudience)
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
  }): Promise<ActionSessionClaims> {
    const verified = await jwtVerify(input.token, this.secretKey, {
      issuer: sessionIssuer,
      audience: actionSessionAudience,
      currentDate: input.now,
      clockTolerance: "5 seconds",
    });
    const payload = verified.payload;

    return {
      workspaceId: assertString(payload.workspaceId, "workspaceId"),
      repositoryId: assertString(payload.repositoryId, "repositoryId"),
      githubRepositoryId: assertString(
        payload.githubRepositoryId,
        "githubRepositoryId",
      ),
      repository: assertString(payload.repository, "repository"),
      githubRunId: assertString(payload.githubRunId, "githubRunId"),
      githubRunAttempt: assertString(
        payload.githubRunAttempt,
        "githubRunAttempt",
      ),
      eventName: assertEventName(payload.eventName),
      ...optionalConflictReviewClaims(payload),
      protocolVersion: 1,
    };
  }
}

function assertString(value: unknown, claim: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid_action_session_${claim}`);
  }
  return value;
}

function assertEventName(value: unknown): ActionSessionClaims["eventName"] {
  if (
    typeof value === "string" &&
    (allowedActionEvents as readonly string[]).includes(value)
  ) {
    return value as ActionSessionClaims["eventName"];
  }
  throw new Error("invalid_action_session_eventName");
}

function optionalConflictReviewClaims(
  payload: Record<string, unknown>,
): Partial<ActionSessionClaims> {
  if (payload.reviewKind === undefined) {
    return {};
  }
  if (
    payload.reviewKind !== "conflict-head" &&
    payload.reviewKind !== "normal"
  ) {
    throw new Error("invalid_action_session_reviewKind");
  }
  if (payload.reviewKind === "normal") {
    return { reviewKind: payload.reviewKind };
  }
  const conflictDispatchId = assertConflictDispatchId(
    payload.conflictDispatchId,
  );
  const pullRequestNumber = assertPositiveInteger(
    payload.pullRequestNumber,
    "pullRequestNumber",
  );
  const headSha = assertSha(payload.headSha, "headSha");
  const baseRef = assertSafeBaseRef(payload.baseRef);
  const baseSha = assertSha(payload.baseSha, "baseSha");
  const configSnapshotId = assertString(
    payload.configSnapshotId,
    "configSnapshotId",
  );
  return {
    reviewKind: payload.reviewKind,
    conflictDispatchId,
    pullRequestNumber,
    headSha,
    baseRef,
    baseSha,
    configSnapshotId,
  };
}

function assertPositiveInteger(value: unknown, claim: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`invalid_action_session_${claim}`);
  }
  return value;
}

function assertSha(value: unknown, claim: string): string {
  const stringValue = assertString(value, claim);
  if (!/^[a-fA-F0-9]{40}$/.test(stringValue)) {
    throw new Error(`invalid_action_session_${claim}`);
  }
  return stringValue;
}

function assertConflictDispatchId(value: unknown): string {
  const dispatchId = assertString(value, "conflictDispatchId");
  if (!isSafeConflictReviewDispatchId(dispatchId)) {
    throw new Error("invalid_action_session_conflictDispatchId");
  }
  return dispatchId;
}

function assertSafeBaseRef(value: unknown): string {
  const baseRef = assertString(value, "baseRef");
  if (!isSafeGitHubBranchName(baseRef)) {
    throw new Error("invalid_action_session_baseRef");
  }
  return baseRef;
}
