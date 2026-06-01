import type { Clock } from "@reviewrouter/shared";
import type { GitLabInstallationPort } from "../ports/gitlab-installation-port";
import {
  buildGitLabCiConfigPath,
  buildGitLabInstallPlan,
  buildGitLabReviewRouterVariables,
  buildGitLabSetupBranchName,
  isReviewRouterManagedCiConfigPath,
  renderGitLabReviewRouterSetupInclude,
  type GitLabCiVariableSpec,
  type GitLabCiVariableTarget,
  type GitLabInstallPlan,
} from "../../domain/gitlab-installation";

export type ProvisionGitLabReviewRouterProjectDependencies = {
  readonly installation: GitLabInstallationPort;
  readonly clock: Clock;
};

export async function provisionGitLabReviewRouterProject(
  input: {
    readonly projectId: string;
    readonly controlProjectPath: string;
    readonly controlProjectConfigPath?: string | undefined;
    readonly controlProjectRef?: string | undefined;
    readonly reviewRouterApiBaseUrl: string;
    readonly idTokenAudience: string;
    readonly variableTarget?: GitLabCiVariableTarget | undefined;
    readonly reviewToken?: string | undefined;
  },
  dependencies: ProvisionGitLabReviewRouterProjectDependencies,
): Promise<
  | {
      readonly mode: "ci_config_path";
      readonly ciConfigPath: string;
      readonly variablesConfigured: number;
    }
  | {
      readonly mode: "setup_merge_request";
      readonly reason: Extract<
        GitLabInstallPlan,
        { mode: "setup_merge_request" }
      >["reason"];
      readonly mergeRequestIid: string;
      readonly mergeRequestUrl: string;
      readonly variablesConfigured: number;
      readonly lintErrors: readonly string[];
    }
  | {
      readonly mode: "skipped";
      readonly reason: Extract<
        GitLabInstallPlan,
        { mode: "skipped" }
      >["reason"];
      readonly lintErrors: readonly string[];
    }
> {
  const project = await dependencies.installation.getProjectSettings({
    projectId: input.projectId,
  });
  const desiredCiConfigPath = buildGitLabCiConfigPath({
    controlProjectPath: input.controlProjectPath,
    configPath: input.controlProjectConfigPath,
    ref: input.controlProjectRef,
  });
  const setupIncludeContent = renderGitLabReviewRouterSetupInclude({
    controlProjectPath: input.controlProjectPath,
    configPath: input.controlProjectConfigPath,
    ref: input.controlProjectRef,
  });
  const variables = input.variableTarget
    ? buildGitLabReviewRouterVariables({
        target: input.variableTarget,
        apiBaseUrl: input.reviewRouterApiBaseUrl,
        idTokenAudience: input.idTokenAudience,
        reviewToken: input.reviewToken,
      })
    : [];
  const existingCiConfigPath = project.ciConfigPath?.trim() || null;
  const canAttemptCiConfigPath =
    project.canEditProjectSettings &&
    (!existingCiConfigPath ||
      isReviewRouterManagedCiConfigPath({
        existingCiConfigPath,
        desiredCiConfigPath,
      }));
  const lintResult = canAttemptCiConfigPath
    ? await dependencies.installation.lintCiConfig({
        projectId: project.projectId,
        content: setupIncludeContent,
        ref: project.defaultBranch,
      })
    : undefined;

  const plan = buildGitLabInstallPlan({
    project,
    desiredCiConfigPath,
    setupIncludeContent,
    sourceBranch: buildGitLabSetupBranchName({
      projectId: project.projectId,
      now: dependencies.clock.now(),
    }),
    variables,
    lintResult,
  });

  if (plan.mode === "skipped") {
    return {
      mode: "skipped",
      reason: plan.reason,
      lintErrors: plan.lintErrors,
    };
  }

  await configureVariables({
    installation: dependencies.installation,
    variables: plan.variables,
  });

  if (plan.mode === "ci_config_path") {
    await dependencies.installation.updateProjectCiConfigPath({
      projectId: plan.projectId,
      ciConfigPath: plan.ciConfigPath,
    });
    return {
      mode: "ci_config_path",
      ciConfigPath: plan.ciConfigPath,
      variablesConfigured: plan.variables.length,
    };
  }

  const mergeRequest = await dependencies.installation.createSetupMergeRequest({
    projectId: plan.projectId,
    sourceBranch: plan.sourceBranch,
    targetBranch: plan.targetBranch,
    title: plan.title,
    description: plan.description,
    files: plan.files,
  });
  return {
    mode: "setup_merge_request",
    reason: plan.reason,
    mergeRequestIid: mergeRequest.iid,
    mergeRequestUrl: mergeRequest.webUrl,
    variablesConfigured: plan.variables.length,
    lintErrors: plan.lintErrors,
  };
}

async function configureVariables(input: {
  readonly installation: GitLabInstallationPort;
  readonly variables: readonly GitLabCiVariableSpec[];
}): Promise<void> {
  for (const variable of input.variables) {
    await input.installation.upsertCiVariable({ variable });
  }
}
