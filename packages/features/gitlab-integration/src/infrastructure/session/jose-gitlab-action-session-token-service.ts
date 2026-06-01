import { jwtVerify, SignJWT } from "jose";
import type { GitLabActionSessionTokenServicePort } from "../../application/ports/gitlab-action-session-token-service-port";
import {
  gitLabActionSessionAudience,
  type GitLabActionSessionClaims,
} from "../../domain/gitlab-ci-identity";

const sessionIssuer = "reviewrouter-control-plane";
const shaPattern = /^[a-fA-F0-9]{40}$/;

export class JoseGitLabActionSessionTokenService implements GitLabActionSessionTokenServicePort {
  private readonly secretKey: Uint8Array;

  constructor(secret: string) {
    if (secret.length < 32) {
      throw new Error("gitlab_action_session_secret_too_short");
    }
    this.secretKey = new TextEncoder().encode(secret);
  }

  async sign(input: {
    readonly claims: GitLabActionSessionClaims;
    readonly expiresInSeconds: number;
    readonly issuedAt: Date;
  }): Promise<{ readonly token: string; readonly expiresAt: Date }> {
    const issuedAtSeconds = Math.floor(input.issuedAt.getTime() / 1000);
    const expiresAtSeconds = issuedAtSeconds + input.expiresInSeconds;
    const token = await new SignJWT({ ...input.claims })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(sessionIssuer)
      .setAudience(gitLabActionSessionAudience)
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
  }): Promise<GitLabActionSessionClaims> {
    const verified = await jwtVerify(input.token, this.secretKey, {
      issuer: sessionIssuer,
      audience: gitLabActionSessionAudience,
      currentDate: input.now,
      clockTolerance: "5 seconds",
    });
    const payload = verified.payload;
    const repository = assertRepositoryIdentity(payload.repository);
    const ciRun = assertCiRunIdentity(payload.ciRun);

    return {
      provider: "gitlab",
      workspaceId: assertString(payload.workspaceId, "workspaceId"),
      repositoryId: assertString(payload.repositoryId, "repositoryId"),
      repositoryExternalId: assertNumericString(
        payload.repositoryExternalId,
        "repositoryExternalId",
      ),
      repositoryFullName: assertString(
        payload.repositoryFullName,
        "repositoryFullName",
      ),
      actorLogin: assertString(payload.actorLogin, "actorLogin"),
      ciRun,
      repository,
      eventName: assertString(payload.eventName, "eventName"),
      ...(typeof payload.workflowPath === "string" &&
      payload.workflowPath.length > 0
        ? { workflowPath: payload.workflowPath }
        : {}),
      changeRequestExternalId: assertNumericString(
        payload.changeRequestExternalId,
        "changeRequestExternalId",
      ),
      headSha: assertSha(payload.headSha, "headSha").toLowerCase(),
      protocolVersion: assertProtocolVersion(payload.protocolVersion),
    };
  }
}

function assertRepositoryIdentity(
  value: unknown,
): GitLabActionSessionClaims["repository"] {
  if (!isRecord(value)) {
    throw new Error("invalid_gitlab_action_session_repository");
  }
  return {
    provider: assertLiteral(value.provider, "gitlab", "repository.provider"),
    externalRepositoryId: assertNumericString(
      value.externalRepositoryId,
      "repository.externalRepositoryId",
    ),
    fullName: assertString(value.fullName, "repository.fullName"),
    owner: assertString(value.owner, "repository.owner"),
    name: assertString(value.name, "repository.name"),
  };
}

function assertCiRunIdentity(
  value: unknown,
): GitLabActionSessionClaims["ciRun"] {
  if (!isRecord(value)) {
    throw new Error("invalid_gitlab_action_session_ciRun");
  }
  return {
    provider: assertLiteral(value.provider, "gitlab-ci", "ciRun.provider"),
    externalRepositoryId: assertNumericString(
      value.externalRepositoryId,
      "ciRun.externalRepositoryId",
    ),
    runId: assertNumericString(value.runId, "ciRun.runId"),
    runAttempt: assertNumericString(value.runAttempt, "ciRun.runAttempt"),
    actorLogin: assertString(value.actorLogin, "ciRun.actorLogin"),
  };
}

function assertLiteral<T extends string>(
  value: unknown,
  expected: T,
  claim: string,
): T {
  if (value !== expected) {
    throw new Error(`invalid_gitlab_action_session_${claim}`);
  }
  return expected;
}

function assertProtocolVersion(value: unknown): 1 {
  if (value !== 1) {
    throw new Error("invalid_gitlab_action_session_protocolVersion");
  }
  return 1;
}

function assertString(value: unknown, claim: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid_gitlab_action_session_${claim}`);
  }
  return value;
}

function assertNumericString(value: unknown, claim: string): string {
  const stringValue = assertString(value, claim);
  if (!/^[1-9][0-9]*$/.test(stringValue)) {
    throw new Error(`invalid_gitlab_action_session_${claim}`);
  }
  return stringValue;
}

function assertSha(value: unknown, claim: string): string {
  const stringValue = assertString(value, claim);
  if (!shaPattern.test(stringValue)) {
    throw new Error(`invalid_gitlab_action_session_${claim}`);
  }
  return stringValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
