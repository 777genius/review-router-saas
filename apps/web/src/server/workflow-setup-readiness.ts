import type { RepositoryWorkflowProbePort } from "@reviewrouter/features-repo-health";
import type { ProviderKind } from "@reviewrouter/features-review-providers";
import {
  defaultCodexRotatingWorkflowPath,
  defaultWorkflowPath,
  getCodexRotatingWorkflowSetupContentMarkerGroups,
  getWorkflowSetupContentMarkerGroups,
} from "@reviewrouter/features-workflow-provisioning";

export type WorkflowSetupReadinessInput = {
  readonly githubInstallationId: string;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly actionRef: string;
  readonly providerKind?: ProviderKind;
  readonly conflictReviewFallbackEnabled?: boolean;
  readonly codexRotatingProviderInstanceId?: string;
};

export async function isWorkflowSetupAlreadyCurrent(
  input: WorkflowSetupReadinessInput,
  dependencies: {
    readonly workflowProbe: RepositoryWorkflowProbePort;
  },
): Promise<boolean> {
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
