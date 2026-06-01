import {
  buildGitLabReviewRouterVariables,
  type GitLabCiVariableSpec,
  type GitLabCiVariableTarget,
} from "../../domain/gitlab-installation";
import {
  provisionGitLabReviewRouterProject,
  type ProvisionGitLabReviewRouterProjectDependencies,
} from "./provision-gitlab-reviewrouter-project";

const maxBulkProjectCount = 100;

type SingleProjectProvisionResult = Awaited<
  ReturnType<typeof provisionGitLabReviewRouterProject>
>;

export type GitLabBulkProvisionProjectResult =
  | {
      readonly projectId: string;
      readonly status: "fulfilled";
      readonly result: SingleProjectProvisionResult;
    }
  | {
      readonly projectId: string;
      readonly status: "rejected";
      readonly error: {
        readonly code: string;
        readonly retryable: boolean;
      };
    };

export type GitLabBulkProvisionResult = {
  readonly protocolVersion: 1;
  readonly requested: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly sharedVariablesConfigured: number;
  readonly results: readonly GitLabBulkProvisionProjectResult[];
};

export async function provisionGitLabReviewRouterProjects(
  input: {
    readonly projectIds: readonly string[];
    readonly controlProjectPath: string;
    readonly controlProjectConfigPath?: string | undefined;
    readonly controlProjectRef?: string | undefined;
    readonly reviewRouterApiBaseUrl: string;
    readonly idTokenAudience: string;
    readonly variableTarget?: GitLabCiVariableTarget | undefined;
    readonly reviewToken?: string | undefined;
  },
  dependencies: ProvisionGitLabReviewRouterProjectDependencies,
): Promise<GitLabBulkProvisionResult> {
  const projectIds = orderedUniqueProjectIds(input.projectIds);
  const sharedVariables = buildSharedVariables(input);
  await configureVariables({
    installation: dependencies.installation,
    variables: sharedVariables,
  });
  const results: GitLabBulkProvisionProjectResult[] = [];

  for (const projectId of projectIds) {
    try {
      const result = await provisionGitLabReviewRouterProject(
        {
          projectId,
          controlProjectPath: input.controlProjectPath,
          ...(input.controlProjectConfigPath
            ? { controlProjectConfigPath: input.controlProjectConfigPath }
            : {}),
          ...(input.controlProjectRef
            ? { controlProjectRef: input.controlProjectRef }
            : {}),
          reviewRouterApiBaseUrl: input.reviewRouterApiBaseUrl,
          idTokenAudience: input.idTokenAudience,
          ...(input.variableTarget?.kind === "project"
            ? { variableTarget: { kind: "project" as const, id: projectId } }
            : {}),
          ...(input.variableTarget?.kind === "project" && input.reviewToken
            ? { reviewToken: input.reviewToken }
            : {}),
        },
        dependencies,
      );
      results.push({ projectId, status: "fulfilled", result });
    } catch (error) {
      const code = safeGitLabBulkErrorCode(error);
      results.push({
        projectId,
        status: "rejected",
        error: {
          code,
          retryable: isRetryableGitLabBulkError(code),
        },
      });
    }
  }

  const failed = results.filter(
    (result) => result.status === "rejected",
  ).length;
  return {
    protocolVersion: 1,
    requested: projectIds.length,
    succeeded: results.length - failed,
    failed,
    sharedVariablesConfigured: sharedVariables.length,
    results,
  };
}

async function configureVariables(input: {
  readonly installation: ProvisionGitLabReviewRouterProjectDependencies["installation"];
  readonly variables: readonly GitLabCiVariableSpec[];
}): Promise<void> {
  for (const variable of input.variables) {
    await input.installation.upsertCiVariable({ variable });
  }
}

function buildSharedVariables(input: {
  readonly variableTarget?: GitLabCiVariableTarget | undefined;
  readonly reviewRouterApiBaseUrl: string;
  readonly idTokenAudience: string;
  readonly reviewToken?: string | undefined;
}): readonly GitLabCiVariableSpec[] {
  if (input.variableTarget?.kind !== "group") {
    return [];
  }
  return buildGitLabReviewRouterVariables({
    target: input.variableTarget,
    apiBaseUrl: input.reviewRouterApiBaseUrl,
    idTokenAudience: input.idTokenAudience,
    ...(input.reviewToken ? { reviewToken: input.reviewToken } : {}),
  });
}

function orderedUniqueProjectIds(
  projectIds: readonly string[],
): readonly string[] {
  const seen = new Set<string>();
  const uniqueProjectIds: string[] = [];
  for (const projectId of projectIds) {
    const normalized = projectId.trim();
    if (!/^[1-9][0-9]*$/.test(normalized)) {
      throw new Error("gitlab_bulk_project_id_invalid");
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      uniqueProjectIds.push(normalized);
    }
  }
  if (uniqueProjectIds.length === 0) {
    throw new Error("gitlab_bulk_project_ids_required");
  }
  if (uniqueProjectIds.length > maxBulkProjectCount) {
    throw new Error("gitlab_bulk_project_limit_exceeded");
  }
  return uniqueProjectIds;
}

function safeGitLabBulkErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown_error";
  const code = message.split(":")[0] ?? "unknown_error";
  return /^[a-z0-9_]{1,96}$/.test(code) ? code : "unknown_error";
}

function isRetryableGitLabBulkError(code: string): boolean {
  return (
    code.endsWith("_unavailable") ||
    code.includes("_timeout") ||
    code.startsWith("gitlab_api_error_5")
  );
}
