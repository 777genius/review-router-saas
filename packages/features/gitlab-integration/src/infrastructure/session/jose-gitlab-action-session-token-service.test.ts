import { describe, expect, it } from "vitest";
import { JoseGitLabActionSessionTokenService } from "./jose-gitlab-action-session-token-service";
import type { GitLabActionSessionClaims } from "../../domain/gitlab-ci-identity";

const now = new Date("2026-05-30T12:00:00.000Z");
const secret = "x".repeat(32);
const claims: GitLabActionSessionClaims = {
  provider: "gitlab",
  workspaceId: "workspace_1",
  repositoryId: "repo_1",
  repositoryExternalId: "123",
  repositoryFullName: "group/project",
  actorLogin: "ilya",
  ciRun: {
    provider: "gitlab-ci",
    externalRepositoryId: "123",
    runId: "1001",
    runAttempt: "2002",
    actorLogin: "ilya",
  },
  repository: {
    provider: "gitlab",
    externalRepositoryId: "123",
    fullName: "group/project",
    owner: "group",
    name: "project",
  },
  eventName: "merge_request_event",
  changeRequestExternalId: "5",
  headSha: "a".repeat(40),
  protocolVersion: 1,
};

describe("JoseGitLabActionSessionTokenService", () => {
  it("signs and verifies GitLab action sessions", async () => {
    const service = new JoseGitLabActionSessionTokenService(secret);
    const signed = await service.sign({
      claims,
      expiresInSeconds: 900,
      issuedAt: now,
    });

    await expect(service.verify({ token: signed.token, now })).resolves.toEqual(
      claims,
    );
  });

  it("rejects sessions with the wrong provider shape", async () => {
    const service = new JoseGitLabActionSessionTokenService(secret);
    const signed = await service.sign({
      claims: {
        ...claims,
        repository: {
          ...claims.repository,
          provider: "github" as "gitlab",
        },
      },
      expiresInSeconds: 900,
      issuedAt: now,
    });

    await expect(service.verify({ token: signed.token, now })).rejects.toThrow(
      "invalid_gitlab_action_session_repository.provider",
    );
  });
});
