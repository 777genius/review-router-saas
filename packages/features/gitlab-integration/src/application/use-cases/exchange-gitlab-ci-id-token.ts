import type { Clock } from "@reviewrouter/shared";
import {
  buildGitLabActionSessionClaims,
  gitLabActionSessionTtlSeconds,
  validateGitLabCiClaimsAgainstRepository,
  validateGitLabMergeRequestForSession,
} from "../../domain/gitlab-ci-identity";
import type { GitLabActionSessionTokenServicePort } from "../ports/gitlab-action-session-token-service-port";
import type { GitLabCiIdTokenVerifierPort } from "../ports/gitlab-ci-id-token-verifier-port";
import type {
  GitLabMergeRequestPort,
  GitLabRepositoryPort,
} from "../ports/gitlab-repository-port";

export type ExchangeGitLabCiIdTokenDependencies = {
  readonly verifier: GitLabCiIdTokenVerifierPort;
  readonly repositories: GitLabRepositoryPort;
  readonly mergeRequests: GitLabMergeRequestPort;
  readonly sessions: GitLabActionSessionTokenServicePort;
  readonly clock: Clock;
};

export async function exchangeGitLabCiIdToken(
  input: {
    readonly idToken: string;
    readonly audience: string;
    readonly mergeRequestIid: string;
    readonly headSha: string;
  },
  dependencies: ExchangeGitLabCiIdTokenDependencies,
): Promise<{
  readonly protocolVersion: 1;
  readonly sessionToken: string;
  readonly expiresAt: string;
  readonly repository: string;
}> {
  if (!/^[1-9][0-9]*$/.test(input.mergeRequestIid)) {
    throw new Error("gitlab_merge_request_iid_invalid");
  }
  if (!/^[a-fA-F0-9]{40}$/.test(input.headSha)) {
    throw new Error("gitlab_head_sha_invalid");
  }

  const claims = await dependencies.verifier.verify({
    token: input.idToken,
    audience: input.audience,
  });
  const projectId = claims.job_project_id ?? claims.project_id;
  const repository =
    await dependencies.repositories.findSelectedRepositoryByGitLabProjectId(
      projectId,
    );
  if (!repository) {
    throw new Error("repository_not_registered");
  }

  validateGitLabCiClaimsAgainstRepository({ claims, repository });
  const mergeRequest = await dependencies.mergeRequests.getMergeRequest({
    projectId: repository.gitlabProjectId,
    mergeRequestIid: input.mergeRequestIid,
  });
  validateGitLabMergeRequestForSession({
    mergeRequest,
    repository,
    mergeRequestIid: input.mergeRequestIid,
    headSha: input.headSha,
  });

  const issuedAt = dependencies.clock.now();
  const session = await dependencies.sessions.sign({
    claims: buildGitLabActionSessionClaims({
      repository,
      claims,
      mergeRequestIid: input.mergeRequestIid,
      headSha: input.headSha,
    }),
    expiresInSeconds: gitLabActionSessionTtlSeconds,
    issuedAt,
  });

  return {
    protocolVersion: 1,
    sessionToken: session.token,
    expiresAt: session.expiresAt.toISOString(),
    repository: repository.fullName,
  };
}
