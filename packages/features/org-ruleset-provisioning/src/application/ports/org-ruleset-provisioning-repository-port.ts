import type {
  OrgRulesetProvisioningRequest,
  OrgRulesetProvisioningStatus,
  OrgRulesetProvisioningTarget,
  OrgRulesetScope,
  OrgRulesetEnforcement,
} from "../../domain/org-ruleset-provisioning";

export type OrgRulesetProvisioningRecord = {
  readonly id: string;
  readonly workspaceId: string;
  readonly installationId: string;
  readonly githubInstallationId: string;
  readonly organizationLogin: string;
  readonly status: OrgRulesetProvisioningStatus;
  readonly scope: OrgRulesetScope;
  readonly enforcement: OrgRulesetEnforcement;
  readonly sourceRepositoryId: string | null;
  readonly sourceGithubRepositoryId: string | null;
  readonly sourceRepositoryFullName: string | null;
  readonly sourceWorkflowPath: string;
  readonly sourceWorkflowRef: string;
  readonly sourceWorkflowSha: string | null;
  readonly rulesetId: string | null;
  readonly rulesetUrl: string | null;
  readonly targetRepositoryIds: readonly string[];
  readonly safeErrorCode: string | null;
  readonly safeErrorSummary: string | null;
  readonly requestedBy: string;
  readonly requestedAt: Date;
  readonly lastAttemptAt: Date | null;
  readonly configuredAt: Date | null;
  readonly updatedAt: Date;
};

export interface OrgRulesetProvisioningRepositoryPort {
  findTargetByInstallation(input: {
    readonly workspaceId: string;
    readonly githubInstallationId: string;
  }): Promise<OrgRulesetProvisioningTarget | null>;

  findById(id: string): Promise<OrgRulesetProvisioningRecord | null>;

  findByWorkspaceId(
    workspaceId: string,
  ): Promise<OrgRulesetProvisioningRecord | null>;

  listConfiguredTrustedWorkflows(input: {
    readonly workspaceId: string;
    readonly githubRepositoryId: string;
  }): Promise<readonly string[]>;

  upsertRequested(
    request: OrgRulesetProvisioningRequest,
  ): Promise<OrgRulesetProvisioningRecord>;

  markProcessing(input: {
    readonly id: string;
    readonly attemptedAt: Date;
  }): Promise<void>;

  markConfigured(input: {
    readonly id: string;
    readonly sourceWorkflowSha: string | null;
    readonly rulesetId: string;
    readonly rulesetUrl: string | null;
    readonly configuredAt: Date;
  }): Promise<void>;

  markFailed(input: {
    readonly id: string;
    readonly safeErrorCode: string;
    readonly safeErrorSummary: string;
  }): Promise<void>;
}
