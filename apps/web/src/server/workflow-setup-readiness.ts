import type { RepositoryWorkflowProbePort } from "@reviewrouter/features-repo-health";
import type { ProviderKind } from "@reviewrouter/features-review-providers";
import {
  defaultWorkflowPath,
  getWorkflowProviderContentMarkerGroups,
} from "@reviewrouter/features-workflow-provisioning";

export type WorkflowSetupReadinessInput = {
  readonly githubInstallationId: string;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly actionRef: string;
  readonly providerKind?: ProviderKind;
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
    workflowPath: defaultWorkflowPath,
    expectedActionRef: input.actionRef,
    ...(input.providerKind
      ? {
          expectedContentMarkerGroups: getWorkflowProviderContentMarkerGroups({
            providerKind: input.providerKind,
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
