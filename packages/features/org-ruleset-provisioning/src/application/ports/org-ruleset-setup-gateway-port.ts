import type { GitHubOrgRulesetPayload } from "../../domain/org-ruleset-provisioning";

export type OrgRulesetPermissionProbeResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly safeErrorCode:
        | "org_admin_permission_required"
        | "org_rulesets_not_supported"
        | "org_ruleset_permission_update_pending";
      readonly safeErrorSummary: string;
    };

export type SourceWorkflowWriteResult = {
  readonly sha: string | null;
};

export type OrgRulesetWriteResult = {
  readonly id: string;
  readonly url: string | null;
};

export interface OrgRulesetSetupGatewayPort {
  probeOrganizationRulesetAccess(input: {
    readonly organizationLogin: string;
  }): Promise<OrgRulesetPermissionProbeResult>;

  writeSourceWorkflow(input: {
    readonly owner: string;
    readonly repo: string;
    readonly branch: string;
    readonly path: string;
    readonly content: string;
    readonly message: string;
  }): Promise<SourceWorkflowWriteResult>;

  createOrUpdateOrganizationRuleset(input: {
    readonly organizationLogin: string;
    readonly name: string;
    readonly payload: GitHubOrgRulesetPayload;
  }): Promise<OrgRulesetWriteResult>;
}
