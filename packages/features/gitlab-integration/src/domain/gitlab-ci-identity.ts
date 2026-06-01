import {
  type CiRunIdentity,
  type ScmRepositoryIdentity,
} from "@reviewrouter/shared";
import { z } from "zod";

export const defaultGitLabIssuer = "https://gitlab.com";
export const defaultGitLabAudience = "reviewrouter";
export const gitLabActionSessionTtlSeconds = 15 * 60;
export const gitLabActionSessionAudience = "reviewrouter-gitlab-action-api";

const numericString = z.preprocess(
  (value) => (typeof value === "number" ? String(value) : value),
  z.string().regex(/^[1-9][0-9]*$/),
);
const optionalNumericString = z.preprocess(
  (value) => (value === null ? undefined : value),
  numericString.optional(),
);
const optionalNonEmptyString = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.string().min(1).optional(),
);
const optionalEmail = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.string().email().optional(),
);
const shaSchema = z.string().regex(/^[a-fA-F0-9]{40}$/);
const optionalShaSchema = z.preprocess(
  (value) => (value === null ? undefined : value),
  shaSchema.optional(),
);

export const gitLabCiIdTokenClaimsSchema = z
  .object({
    iss: z.string().url(),
    sub: z.string().min(1),
    aud: z.union([z.string(), z.array(z.string())]),
    namespace_id: numericString,
    namespace_path: z.string().min(1),
    project_id: numericString,
    project_path: z.string().min(1),
    job_project_id: optionalNumericString,
    job_project_path: optionalNonEmptyString,
    job_namespace_id: optionalNumericString,
    job_namespace_path: optionalNonEmptyString,
    user_id: numericString,
    user_login: z.string().min(1),
    user_email: optionalEmail,
    pipeline_id: numericString,
    pipeline_source: z.string().min(1),
    job_id: numericString,
    ref: z.string().min(1),
    ref_type: z.enum(["branch", "tag"]).or(z.string().min(1)),
    ref_path: optionalNonEmptyString,
    ref_protected: z
      .preprocess(
        (value) => (value === null ? undefined : value),
        z.union([z.boolean(), z.string()]).optional(),
      )
      .optional(),
    sha: shaSchema,
    ci_config_ref_uri: optionalNonEmptyString,
    ci_config_sha: optionalShaSchema,
    iat: z.number().optional(),
    nbf: z.number().optional(),
    exp: z.number().optional(),
    jti: z.string().min(1).optional(),
  })
  .passthrough();

export type GitLabCiIdTokenClaims = z.infer<typeof gitLabCiIdTokenClaimsSchema>;

export type GitLabRepositoryContext = {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly gitlabProjectId: string;
  readonly fullName: string;
  readonly owner: string;
  readonly selected: boolean;
  readonly installationStatus:
    | "active"
    | "pending"
    | "suspended"
    | "removed"
    | "permission_error"
    | "sync_error"
    | string;
};

export type GitLabMergeRequestIdentity = {
  readonly projectId: string;
  readonly mergeRequestIid: string;
  readonly headSha: string;
  readonly sourceProjectId: string;
  readonly targetProjectId: string;
  readonly state: "opened" | "closed" | "merged" | string;
};

export type GitLabActionSessionClaims = {
  readonly provider: "gitlab";
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly repositoryExternalId: string;
  readonly repositoryFullName: string;
  readonly actorLogin: string;
  readonly ciRun: CiRunIdentity;
  readonly repository: ScmRepositoryIdentity;
  readonly eventName: string;
  readonly workflowPath?: string | undefined;
  readonly changeRequestExternalId: string;
  readonly headSha: string;
  readonly protocolVersion: 1;
};

export function validateGitLabCiClaimsAgainstRepository(input: {
  readonly claims: GitLabCiIdTokenClaims;
  readonly repository: GitLabRepositoryContext;
}): void {
  const jobProjectId = input.claims.job_project_id ?? input.claims.project_id;
  const jobProjectPath =
    input.claims.job_project_path ?? input.claims.project_path;
  if (input.repository.selected !== true) {
    throw new Error("repository_not_selected");
  }
  if (input.repository.installationStatus !== "active") {
    throw new Error("installation_not_active");
  }
  if (jobProjectId !== input.repository.gitlabProjectId) {
    throw new Error("gitlab_project_id_mismatch");
  }
  if (
    jobProjectPath.toLowerCase() !== input.repository.fullName.toLowerCase()
  ) {
    throw new Error("gitlab_project_path_mismatch");
  }
  if (input.claims.pipeline_source !== "merge_request_event") {
    throw new Error("gitlab_pipeline_source_not_supported");
  }
}

export function validateGitLabMergeRequestForSession(input: {
  readonly mergeRequest: GitLabMergeRequestIdentity;
  readonly repository: GitLabRepositoryContext;
  readonly mergeRequestIid: string;
  readonly headSha: string;
}): void {
  if (input.mergeRequest.projectId !== input.repository.gitlabProjectId) {
    throw new Error("gitlab_merge_request_project_mismatch");
  }
  if (input.mergeRequest.mergeRequestIid !== input.mergeRequestIid) {
    throw new Error("gitlab_merge_request_iid_mismatch");
  }
  if (input.mergeRequest.targetProjectId !== input.repository.gitlabProjectId) {
    throw new Error("gitlab_merge_request_target_project_mismatch");
  }
  if (
    input.mergeRequest.sourceProjectId !== input.mergeRequest.targetProjectId
  ) {
    throw new Error("gitlab_merge_request_fork_unsupported");
  }
  if (input.mergeRequest.state !== "opened") {
    throw new Error("gitlab_merge_request_not_opened");
  }
  if (
    input.mergeRequest.headSha.toLowerCase() !== input.headSha.toLowerCase()
  ) {
    throw new Error("gitlab_merge_request_head_sha_mismatch");
  }
}

export function buildGitLabActionSessionClaims(input: {
  readonly repository: GitLabRepositoryContext;
  readonly claims: GitLabCiIdTokenClaims;
  readonly mergeRequestIid: string;
  readonly headSha: string;
}): GitLabActionSessionClaims {
  const [owner, name] = splitGitLabProjectPath(input.repository.fullName);
  return {
    provider: "gitlab",
    workspaceId: input.repository.workspaceId,
    repositoryId: input.repository.repositoryId,
    repositoryExternalId: input.repository.gitlabProjectId,
    repositoryFullName: input.repository.fullName,
    actorLogin: input.claims.user_login,
    ciRun: {
      provider: "gitlab-ci",
      externalRepositoryId: input.repository.gitlabProjectId,
      runId: input.claims.pipeline_id,
      runAttempt: input.claims.job_id,
      actorLogin: input.claims.user_login,
    },
    repository: {
      provider: "gitlab",
      externalRepositoryId: input.repository.gitlabProjectId,
      fullName: input.repository.fullName,
      owner,
      name,
    },
    eventName: input.claims.pipeline_source,
    ...(input.claims.ci_config_ref_uri
      ? { workflowPath: input.claims.ci_config_ref_uri }
      : {}),
    changeRequestExternalId: input.mergeRequestIid,
    headSha: input.headSha.toLowerCase(),
    protocolVersion: 1,
  };
}

function splitGitLabProjectPath(fullName: string): readonly [string, string] {
  const parts = fullName.split("/");
  const name = parts.pop();
  const owner = parts.join("/");
  if (!owner || !name) {
    throw new Error("gitlab_project_path_invalid");
  }
  return [owner, name];
}
