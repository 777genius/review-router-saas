import type { RepositoryWorkflowCheck } from "../../domain/repository-health";

export type { RepositoryWorkflowCheck };

export type RepositoryWorkflowProbeInput = {
  readonly githubInstallationId: string;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly workflowPath: string;
  readonly expectedActionRef: string;
  readonly expectedContentMarkerGroups?: readonly (readonly string[])[];
};

export interface RepositoryWorkflowProbePort {
  probeWorkflow(
    input: RepositoryWorkflowProbeInput,
  ): Promise<RepositoryWorkflowCheck>;
}
