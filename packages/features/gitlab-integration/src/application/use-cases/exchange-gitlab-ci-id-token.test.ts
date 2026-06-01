import { describe, expect, it } from "vitest";
import type { Clock } from "@reviewrouter/shared";
import type { GitLabActionSessionTokenServicePort } from "../ports/gitlab-action-session-token-service-port";
import type { GitLabCiIdTokenVerifierPort } from "../ports/gitlab-ci-id-token-verifier-port";
import type {
  GitLabMergeRequestPort,
  GitLabRepositoryPort,
} from "../ports/gitlab-repository-port";
import {
  type GitLabActionSessionClaims,
  type GitLabCiIdTokenClaims,
  type GitLabMergeRequestIdentity,
  type GitLabRepositoryContext,
} from "../../domain/gitlab-ci-identity";
import { exchangeGitLabCiIdToken } from "./exchange-gitlab-ci-id-token";

const fixedNow = new Date("2026-05-30T12:00:00.000Z");
const clock: Clock = { now: () => fixedNow };
const headSha = "a".repeat(40);

const repository: GitLabRepositoryContext = {
  workspaceId: "workspace_1",
  repositoryId: "repo_1",
  gitlabProjectId: "123",
  fullName: "group/project",
  owner: "group",
  selected: true,
  installationStatus: "active",
};

const claims: GitLabCiIdTokenClaims = {
  iss: "https://gitlab.com",
  sub: "project_path:group/project:ref_type:branch:ref:feature",
  aud: "reviewrouter",
  namespace_id: "12",
  namespace_path: "group",
  project_id: "123",
  project_path: "group/project",
  job_project_id: "123",
  job_project_path: "group/project",
  user_id: "7",
  user_login: "ilya",
  pipeline_id: "1001",
  pipeline_source: "merge_request_event",
  job_id: "2002",
  ref: "feature",
  ref_type: "branch",
  sha: headSha,
};

const mergeRequest: GitLabMergeRequestIdentity = {
  projectId: "123",
  mergeRequestIid: "5",
  headSha,
  sourceProjectId: "123",
  targetProjectId: "123",
  state: "opened",
};

class StaticVerifier implements GitLabCiIdTokenVerifierPort {
  constructor(
    private readonly verifiedClaims: GitLabCiIdTokenClaims = claims,
  ) {}

  async verify(): Promise<GitLabCiIdTokenClaims> {
    return this.verifiedClaims;
  }
}

class InMemoryRepositories implements GitLabRepositoryPort {
  public repository: GitLabRepositoryContext | null = repository;

  async findSelectedRepositoryByGitLabProjectId(
    gitlabProjectId: string,
  ): Promise<GitLabRepositoryContext | null> {
    return this.repository?.gitlabProjectId === gitlabProjectId
      ? this.repository
      : null;
  }
}

class StaticMergeRequests implements GitLabMergeRequestPort {
  constructor(
    private readonly result: GitLabMergeRequestIdentity = mergeRequest,
  ) {}

  async getMergeRequest(): Promise<GitLabMergeRequestIdentity> {
    return this.result;
  }
}

class StaticSessions implements GitLabActionSessionTokenServicePort {
  public signedClaims: GitLabActionSessionClaims | null = null;

  async sign(input: {
    readonly claims: GitLabActionSessionClaims;
    readonly expiresInSeconds: number;
    readonly issuedAt: Date;
  }) {
    this.signedClaims = input.claims;
    return {
      token: "signed-gitlab-session",
      expiresAt: new Date(
        input.issuedAt.getTime() + input.expiresInSeconds * 1000,
      ),
    };
  }

  async verify(): Promise<GitLabActionSessionClaims> {
    if (!this.signedClaims) {
      throw new Error("no_session_signed");
    }
    return this.signedClaims;
  }
}

describe("exchangeGitLabCiIdToken", () => {
  it("issues a provider-neutral action session after GitLab API revalidation", async () => {
    const sessions = new StaticSessions();

    await expect(
      exchangeGitLabCiIdToken(
        {
          idToken: "id-token",
          audience: "reviewrouter",
          mergeRequestIid: "5",
          headSha,
        },
        {
          verifier: new StaticVerifier(),
          repositories: new InMemoryRepositories(),
          mergeRequests: new StaticMergeRequests(),
          sessions,
          clock,
        },
      ),
    ).resolves.toEqual({
      protocolVersion: 1,
      sessionToken: "signed-gitlab-session",
      expiresAt: "2026-05-30T12:15:00.000Z",
      repository: "group/project",
    });

    expect(sessions.signedClaims).toMatchObject({
      provider: "gitlab",
      repositoryExternalId: "123",
      repositoryFullName: "group/project",
      changeRequestExternalId: "5",
      headSha,
      ciRun: {
        provider: "gitlab-ci",
        externalRepositoryId: "123",
        runId: "1001",
        runAttempt: "2002",
      },
      repository: {
        provider: "gitlab",
        externalRepositoryId: "123",
        fullName: "group/project",
      },
    });
  });

  it("rejects fork merge requests for the MVP trust boundary", async () => {
    await expect(
      exchangeGitLabCiIdToken(
        {
          idToken: "id-token",
          audience: "reviewrouter",
          mergeRequestIid: "5",
          headSha,
        },
        {
          verifier: new StaticVerifier(),
          repositories: new InMemoryRepositories(),
          mergeRequests: new StaticMergeRequests({
            ...mergeRequest,
            sourceProjectId: "999",
          }),
          sessions: new StaticSessions(),
          clock,
        },
      ),
    ).rejects.toThrow("gitlab_merge_request_fork_unsupported");
  });

  it("rejects stale head SHA before issuing a session", async () => {
    await expect(
      exchangeGitLabCiIdToken(
        {
          idToken: "id-token",
          audience: "reviewrouter",
          mergeRequestIid: "5",
          headSha,
        },
        {
          verifier: new StaticVerifier(),
          repositories: new InMemoryRepositories(),
          mergeRequests: new StaticMergeRequests({
            ...mergeRequest,
            headSha: "b".repeat(40),
          }),
          sessions: new StaticSessions(),
          clock,
        },
      ),
    ).rejects.toThrow("gitlab_merge_request_head_sha_mismatch");
  });
});
