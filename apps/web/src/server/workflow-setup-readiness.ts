import type { RepositoryWorkflowProbePort } from "@reviewrouter/features-repo-health";
import type { ProviderKind } from "@reviewrouter/features-review-providers";
import {
  defaultCodexRotatingWorkflowPath,
  defaultWorkflowPath,
  getCodexRotatingWorkflowSetupContentMarkerGroups,
  getWorkflowSetupContentMarkerGroups,
  type ReviewRouterDiscussionMode,
} from "@reviewrouter/features-workflow-provisioning";

export type WorkflowSetupReadinessInput = {
  readonly githubInstallationId: string;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly actionRef: string;
  readonly providerKind?: ProviderKind;
  readonly discussionMode?: ReviewRouterDiscussionMode;
  readonly conflictReviewFallbackEnabled?: boolean;
  readonly codexRotatingProviderInstanceId?: string;
  readonly codexRotatingClaudeCodeOAuthTokenSecret?: boolean;
  readonly codexRotatingOpenRouterApiKeySecret?: boolean;
};

export async function isWorkflowSetupAlreadyCurrent(
  input: WorkflowSetupReadinessInput,
  dependencies: {
    readonly workflowProbe: RepositoryWorkflowProbePort;
  },
): Promise<boolean> {
  if (input.discussionMode === "suggest") {
    return false;
  }

  const workflowCheck = await dependencies.workflowProbe.probeWorkflow({
    githubInstallationId: input.githubInstallationId,
    owner: input.owner,
    name: input.name,
    defaultBranch: input.defaultBranch,
    workflowPath: input.codexRotatingProviderInstanceId
      ? defaultCodexRotatingWorkflowPath
      : defaultWorkflowPath,
    expectedActionRef: input.actionRef,
    ...(input.codexRotatingProviderInstanceId
      ? {
          expectedContentMarkerGroups:
            getCodexRotatingWorkflowSetupContentMarkerGroups({
              providerInstanceId: input.codexRotatingProviderInstanceId,
              claudeCodeOAuthTokenSecret:
                input.codexRotatingClaudeCodeOAuthTokenSecret === true,
              openRouterApiKeySecret:
                input.codexRotatingOpenRouterApiKeySecret === true,
            }),
        }
      : input.providerKind || input.conflictReviewFallbackEnabled === true
        ? {
            expectedContentMarkerGroups: getWorkflowSetupContentMarkerGroups({
              providerKind: input.providerKind,
              conflictReviewFallbackEnabled:
                input.conflictReviewFallbackEnabled === true,
            }),
          }
        : {}),
  });

  return (
    workflowCheck.status === "present" &&
    workflowCheck.expectedActionRefFound &&
    (workflowCheck.expectedContentMarkersFound ?? true)
  );
}
