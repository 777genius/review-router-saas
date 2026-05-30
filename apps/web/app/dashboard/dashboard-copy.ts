type DashboardWorkspaceInstallation = {
  readonly accountLogin: string;
  readonly accountType: string;
  readonly githubInstallationId: string;
  readonly repositorySelection: string;
};

export function dashboardNoticeText(
  notice: string,
  repository: string,
): string {
  switch (notice) {
    case "app_installed":
      return "GitHub App is connected. Search for one repository, create the setup PR, then seed provider credentials from this dashboard.";
    case "sync_requested":
      return "Repository metadata refresh was queued. Reload in a few seconds if the repository list does not update immediately.";
    case "sync_already_requested":
      return "Repository metadata refresh was already queued for this installation recently.";
    case "repository_access_refreshed":
      return "GitHub repository access was refreshed for your account.";
    case "setup_pr_ready":
      return repository
        ? `Setup PR is ready for ${repository}.`
        : "Setup PR is ready.";
    case "setup_pr_merged":
      return repository
        ? `Setup PR merge was confirmed for ${repository}.`
        : "Setup PR merge was confirmed.";
    case "provider_setup_confirmed":
      return repository
        ? `Provider setup progress was updated for ${repository}.`
        : "Provider setup progress was updated.";
    case "workflow_already_current":
      return repository
        ? `ReviewRouter workflow is already current for ${repository}.`
        : "ReviewRouter workflow is already current.";
    case "org_ruleset_queued":
      return "Organization-wide required workflow setup was queued. The worker will create or update the central workflow and GitHub ruleset after the permission probe passes.";
    case "review_config_saved":
      return "Review configuration was saved. Future action runs can fetch it through OIDC.";
    case "repository_review_config_saved":
      return repository
        ? `Repository review configuration was saved for ${repository}.`
        : "Repository review configuration was saved.";
    case "repository_review_config_cleared":
      return repository
        ? `${repository} now inherits the workspace review configuration.`
        : "Repository override was cleared.";
    case "memory_saved":
      return "Memory was saved after policy and safety checks.";
    case "memory_suggestion_confirmed":
      return "Suggested memory was confirmed and queued for retrieval indexing.";
    case "memory_suggestion_rejected":
      return "Suggested memory was rejected and will not be used in runtime context.";
    case "memory_disabled":
      return "Memory was disabled and queued for removal from retrieval.";
    case "memory_deleted":
      return "Memory was deleted and queued for removal from retrieval.";
    case "memory_duplicate":
      return "A matching active memory already exists, so nothing was changed.";
    case "memory_already_confirmed":
    case "memory_already_rejected":
    case "memory_already_disabled":
    case "memory_already_deleted":
      return "Memory state was already up to date.";
    case "memory_noop":
      return "No memory change was needed.";
    case "outbox_retry_queued":
      return "Failed background event was queued for retry. Refresh in a few seconds after background processing catches up.";
    case "outbox_retry_not_found":
      return "Failed background event was not found for this workspace.";
    case "outbox_retry_not_dead_letter":
      return "Background event is no longer in dead-letter state and was not manually retried.";
    default:
      return "Dashboard action completed.";
  }
}

export function dashboardNoticeTitle(notice: string): string {
  switch (notice) {
    case "app_installed":
      return "GitHub App installed";
    case "sync_requested":
    case "sync_already_requested":
      return "Refresh queued";
    case "repository_access_refreshed":
      return "Access refreshed";
    case "setup_pr_ready":
      return "Setup PR ready";
    case "setup_pr_merged":
      return "Setup PR merged";
    case "provider_setup_confirmed":
      return "Provider setup confirmed";
    case "workflow_already_current":
      return "Workflow installed";
    case "org_ruleset_queued":
      return "Org-wide setup queued";
    case "review_config_saved":
    case "repository_review_config_saved":
    case "repository_review_config_cleared":
      return "Model settings saved";
    case "memory_saved":
      return "Memory saved";
    case "memory_suggestion_confirmed":
      return "Suggestion approved";
    case "memory_suggestion_rejected":
      return "Suggestion rejected";
    case "memory_disabled":
      return "Memory disabled";
    case "memory_deleted":
      return "Memory deleted";
    case "memory_duplicate":
      return "Duplicate skipped";
    case "memory_already_confirmed":
    case "memory_already_rejected":
    case "memory_already_disabled":
    case "memory_already_deleted":
    case "memory_noop":
      return "Memory unchanged";
    case "outbox_retry_queued":
    case "outbox_retry_not_found":
    case "outbox_retry_not_dead_letter":
      return "Retry updated";
    default:
      return "Action complete";
  }
}

export function dashboardNoticeTone(
  notice: string,
): "success" | "warning" | "danger" | "accent" {
  switch (notice) {
    case "setup_pr_ready":
    case "setup_pr_merged":
    case "provider_setup_confirmed":
    case "app_installed":
    case "workflow_already_current":
    case "review_config_saved":
    case "repository_review_config_saved":
    case "repository_review_config_cleared":
    case "memory_saved":
    case "memory_suggestion_confirmed":
    case "memory_suggestion_rejected":
    case "memory_disabled":
    case "memory_deleted":
    case "repository_access_refreshed":
      return "success";
    case "sync_already_requested":
    case "memory_duplicate":
    case "memory_already_confirmed":
    case "memory_already_rejected":
    case "memory_already_disabled":
    case "memory_already_deleted":
    case "memory_noop":
      return "accent";
    case "outbox_retry_not_found":
    case "outbox_retry_not_dead_letter":
      return "warning";
    default:
      return "accent";
  }
}

export type CodexRotatingProviderState =
  | "setup_pending"
  | "active"
  | "permission_required"
  | "workflow_update_required"
  | "quota_limited"
  | "needs_reconnect"
  | "stale_queued_secret"
  | "skipped_retryable"
  | "policy_blocked"
  | "unknown_auth_state";

export function codexRotatingProviderStateCopy(
  state: CodexRotatingProviderState,
): {
  readonly title: string;
  readonly body: string;
  readonly tone: "success" | "warning" | "danger" | "accent";
} {
  switch (state) {
    case "setup_pending":
      return {
        title: "Codex setup pending",
        body: "Run the repository-scoped rotating Codex setup command from a trusted machine, then rerun the advisory PR workflow.",
        tone: "warning",
      };
    case "active":
      return {
        title: "Codex OAuth active",
        body: "Rotating Codex OAuth is configured for this repository. The beta workflow remains advisory-only.",
        tone: "success",
      };
    case "permission_required":
      return {
        title: "GitHub App permission required",
        body: "Approve the ReviewRouter GitHub App permission update for repository Secrets, Contents, Pull requests, and Issues access, then rerun the workflow.",
        tone: "danger",
      };
    case "workflow_update_required":
      return {
        title: "Workflow update required",
        body: "Update the ReviewRouter workflow to the pinned rotating Codex OAuth beta workflow, then rerun the PR workflow.",
        tone: "warning",
      };
    case "quota_limited":
      return {
        title: "Codex quota limited",
        body: "Codex authenticated successfully, but the account hit quota, billing, or rate limits after writeback. Retry after the account is usable again.",
        tone: "warning",
      };
    case "needs_reconnect":
      return {
        title: "Codex reconnect required",
        body: "The refreshed Codex session is no longer valid. Rerun the rotating setup command from the dedicated ReviewRouter Codex session.",
        tone: "danger",
      };
    case "stale_queued_secret":
      return {
        title: "Stale Codex secret skipped",
        body: "A newer Codex auth generation is already stored. Rerun the latest workflow instead of refreshing from this queued run.",
        tone: "warning",
      };
    case "skipped_retryable":
      return {
        title: "Codex review skipped",
        body: "The run stopped before refreshing Codex auth. Retry the advisory workflow after GitHub or ReviewRouter recovers.",
        tone: "accent",
      };
    case "policy_blocked":
      return {
        title: "Codex beta policy blocked",
        body: "Rotating Codex OAuth beta only runs on private same-repository PRs from GitHub-hosted runners with the generated advisory workflow.",
        tone: "danger",
      };
    case "unknown_auth_state":
      return {
        title: "Codex auth state unknown",
        body: "Codex may have refreshed before GitHub secret writeback was confirmed. Rerun the rotating setup command before relying on this repository's Codex OAuth secret.",
        tone: "danger",
      };
  }
}

export function isProviderSecretCheckError(error: string): boolean {
  return (
    error === "repository_not_visible_to_github_app" ||
    error === "provider_secret_not_found" ||
    error === "provider_secret_not_available_to_repository" ||
    error === "provider_secret_check_permission_required"
  );
}

export function isMemoryError(error: string): boolean {
  return [
    "contains_code_block",
    "contains_diff_hunk",
    "contains_large_stacktrace",
    "contains_prompt_injection",
    "contains_secret_like_text",
    "memory_active_item_quota_exceeded",
    "memory_disabled",
    "memory_not_found",
    "memory_pending_suggestion_quota_exceeded",
    "memory_safety_blocked",
    "not_repository_maintainer",
    "not_user_owner",
    "not_workspace_admin",
    "permission_service_unavailable",
    "repository_unavailable",
    "too_long",
    "unsafe_for_user_prefs",
  ].includes(error);
}

export function isSetupRecoveryIssue(
  value: string | null | undefined,
): boolean {
  return (
    value === "setup_pr_closed" ||
    value === "setup_pr_branch_deleted" ||
    value === "setup_pr_wrong_base_branch"
  );
}

export function workspaceInstallSummary(workspace: {
  readonly installations: readonly DashboardWorkspaceInstallation[];
}): string {
  const installation = workspace.installations[0];
  if (!installation) {
    return "Signed-in GitHub user workspace - install the App to connect repositories.";
  }

  const accountType = formatAccountTypeLabel(installation.accountType);
  const repositoryScope =
    installation.repositorySelection === "all"
      ? "all repositories available"
      : "selected repositories only";

  return `${accountType} GitHub App install - ${repositoryScope}`;
}

export function formatAccountTypeLabel(accountType: string): string {
  return accountType === "Organization" ? "Organization" : "Personal";
}

export function orgRulesetStatusTone(
  status: string | undefined,
): "success" | "warning" | "danger" | "neutral" {
  switch (status) {
    case "configured":
      return "success";
    case "requested":
    case "processing":
      return "warning";
    case "failed":
      return "danger";
    default:
      return "neutral";
  }
}

export function orgRulesetErrorText(error: string): string {
  switch (error) {
    case "org_admin_permission_required":
      return "Organization Administration: write is required for org-wide rulesets.";
    case "org_rulesets_not_supported":
      return "GitHub organization rulesets are unavailable on this organization plan. Private organization repositories require GitHub Team or Enterprise; use per-repository setup PR fallback until the organization plan is upgraded.";
    case "org_ruleset_permission_update_pending":
      return "GitHub rejected the ruleset probe. The App permission update may still need approval.";
    case "org_ruleset_all_repositories_requires_all_access":
      return "All-repositories ruleset requires the GitHub App installation to be configured for all repositories.";
    case "github_org_ruleset_validation_failed":
      return "GitHub rejected the ruleset payload. If you chose Evaluate, switch to Active unless the organization is on GitHub Enterprise.";
    default:
      return error.replaceAll("_", " ");
  }
}

export function dashboardErrorText(error: string): string {
  if (isCodexRotatingProviderState(error)) {
    return codexRotatingProviderStateCopy(error).body;
  }

  switch (error) {
    case "dashboard_mutations_disabled":
      return "Dashboard mutations are disabled on this environment.";
    case "dashboard_auth_misconfigured":
      return "GitHub OAuth is not configured. Set AUTH_SECRET, GITHUB_APP_CLIENT_ID, and GITHUB_APP_CLIENT_SECRET.";
    case "dashboard_mutation_requires_sign_in":
      return "Sign in with GitHub before changing repository setup.";
    case "repository_access_token_missing":
      return "Reconnect GitHub to discover repositories you can manage.";
    case "repository_access_token_revoked":
    case "repository_access_token_expired":
    case "repository_access_token_refresh_failed":
    case "repository_access_token_decryption_failed":
      return "GitHub authorization expired. Reconnect GitHub, then refresh repository access.";
    case "repository_access_token_encryption_misconfigured":
      return "Server setup is incomplete. Set REVIEW_ROUTER_TOKEN_ENCRYPTION_KEY before maintainer repository discovery can run.";
    case "repository_access_github_error":
      return "GitHub repository access could not be refreshed. Try again shortly.";
    case "workspace_mutation_forbidden":
      return "Your GitHub user is not an owner/admin for this workspace.";
    case "repository_mutation_forbidden":
      return "Your GitHub user needs write, maintain, or admin access on this repository to change repository-level ReviewRouter settings.";
    case "repository_config_mutation_forbidden":
      return "Your GitHub user needs maintain or admin access on this repository to change ReviewRouter runtime settings directly.";
    case "operation_already_running":
      return "Another setup or sync operation is already running. Try again shortly.";
    case "rate_limited":
      return "Too many dashboard requests for this resource. Wait a bit before retrying.";
    case "invalid_form":
      return "The submitted form is invalid. Refresh the dashboard and try again.";
    case "dashboard_action_failed":
      return "The dashboard could not complete this action. Refresh and try again.";
    case "dashboard_action_stale":
      return "The dashboard was updated while this page was open. Refresh the page, then try again.";
    case "server_misconfigured":
      return "Server setup is incomplete. Check GitHub App credentials and the public ReviewRouter API URL.";
    case "github_operation_forbidden":
      return "GitHub refused this dashboard action. Check GitHub App permissions and branch protection, then retry.";
    case "github_operation_not_found":
      return "GitHub could not find the repository, branch, or pull request needed for this action. Sync repositories and confirm App access, then retry.";
    case "github_operation_conflict":
      return "GitHub reported a write conflict. Retry once after the current repository operation settles.";
    case "github_validation_failed":
      return "GitHub rejected the request. Check whether the pull request can be reopened or whether branch protection blocks the update.";
    case "github_service_unavailable":
      return "GitHub is temporarily unavailable for this action. Retry after GitHub recovers.";
    case "github_operation_failed":
      return "GitHub operation failed. Check audit events or server logs for the safe error code.";
    case "repository_not_selected":
      return "This repository is no longer selected for the GitHub App installation.";
    case "repository_archived":
      return "Archived repositories cannot be provisioned.";
    case "installation_not_active":
      return "The GitHub App installation is not active.";
    case "setup_pr_not_merged":
      return "GitHub does not show the workflow on the setup PR target branch yet. If you just merged the setup PR, wait a few seconds; the dashboard will advance automatically when GitHub metadata catches up.";
    case "setup_pr_closed":
      return "The saved setup PR was closed before it was merged. Recreate the setup PR, then merge the new one.";
    case "setup_pr_branch_deleted":
      return "The saved setup PR branch was deleted, so GitHub cannot merge that PR anymore. Recreate the setup PR to continue.";
    case "setup_pr_wrong_base_branch":
      return "The saved setup PR was merged outside the allowed setup branches. Recreate the setup PR, then merge it into dev, develop, or the repository default branch.";
    case "repository_not_visible_to_github_app":
      return "The GitHub App installation cannot read this repository. Update App repository access or sync repositories, then try again.";
    case "provider_secret_not_found":
      return "GitHub does not show the required Actions secret yet. Run the command, then try again.";
    case "provider_secret_not_available_to_repository":
      return "The organization Actions secret exists, but it is not available to this repository. Add this repository to the selected-repository secret access, then try again.";
    case "provider_secret_check_permission_required":
      return "ReviewRouter needs GitHub App Secrets: write for repository secrets, or Organization secrets: read for organization secrets, to verify Actions secret metadata and support encrypted Codex OAuth writeback. Approve the App permission update, then try again.";
    case "organization_secret_scope_forbidden":
      return "Organization secret setup requires workspace owner/admin access. Use a repository secret for repo-scoped setup.";
    case "entitlement_denied":
      return "This workspace plan does not allow that action. Check the plan status or feature flags.";
    case "workflow_provisioning_disabled":
      return "Workflow provisioning is disabled. Set REVIEW_ROUTER_ENABLE_WORKFLOW_PROVISIONING=1 in a trusted local or beta environment.";
    case "codex_rotating_not_enabled":
      return "Rotating Codex OAuth is not enabled for this ReviewRouter deployment.";
    case "codex_rotating_repository_scope_required":
      return "Codex rotating OAuth must be configured per repository, not as a workspace default.";
    case "codex_rotating_single_provider_required":
      return "Codex rotating OAuth supports exactly one Codex provider in this repository.";
    case "duplicate_review_provider":
      return "Duplicate provider/model rows are not supported yet. Pick a different model for duplicate providers.";
    case "codex_rotating_provider_instance_required":
      return "Codex rotating setup is incomplete. Reconnect Codex with the rotating setup command, then create the setup PR again.";
    case "codex_legacy_auth_requires_reconnect":
      return "Legacy Codex OAuth is disabled. Reconnect Codex with the rotating setup command, then create the setup PR again.";
    case "codex_api_key_setup_disabled":
      return "Codex API-key setup is disabled. Use Codex OAuth rotating instead.";
    case "codex_provider_requires_rotating_workflow":
      return "Codex requires the rotating workflow. Reconnect Codex with the rotating setup command, then recreate the setup PR.";
    case "org_ruleset_requires_organization_installation":
      return "Organization-wide required workflow is available only for GitHub organization installations. Use per-repository setup PR for personal repositories.";
    case "org_ruleset_no_selected_repositories":
      return "This organization installation has no selected, active repositories to target.";
    case "org_ruleset_all_repositories_requires_all_access":
      return "All-repositories org ruleset requires installing the GitHub App for all repositories first. Use selected repositories or per-repository setup PR fallback.";
    case "org_ruleset_source_repository_invalid":
      return "The configured source repository must be a full GitHub name like org/reviewrouter-workflows.";
    case "org_ruleset_source_repository_wrong_owner":
      return "The source repository must belong to the same GitHub organization as the App installation.";
    case "org_ruleset_source_repository_not_installed":
      return "The source repository reviewrouter-workflows is not visible to the GitHub App. Create it, add it to the App installation, then sync repositories and retry.";
    case "org_ruleset_source_repository_archived":
      return "The source repository reviewrouter-workflows is archived. Unarchive it or create a fresh source repository before enabling org-wide mode.";
    case "org_ruleset_source_repository_not_writable":
      return "ReviewRouter could not write the central workflow to reviewrouter-workflows. Check App repository access, Contents: write, Workflows: write, and branch protection.";
    case "org_ruleset_source_repository_branch_blocked":
      return "GitHub blocked the direct workflow commit to reviewrouter-workflows. Check branch protection or exclude the source repository from active rulesets.";
    case "org_ruleset_source_repository_actions_access_required":
      return "GitHub could not use the source workflow from other private repositories. In reviewrouter-workflows, set Settings - Actions - General - Access to organization repositories.";
    case "org_admin_permission_required":
      return "GitHub did not allow organization ruleset access. Approve the optional Organization Administration: write permission if it is still pending; if it is already approved, the organization plan may not support rulesets. Use per-repository setup PR fallback.";
    case "org_rulesets_not_supported":
      return "GitHub accepted the App permissions, but organization rulesets are unavailable on this organization plan. Private organization repositories require GitHub Team or Enterprise; use per-repository setup PR fallback until the organization plan is upgraded.";
    case "org_ruleset_permission_update_pending":
      return "GitHub rejected the ruleset permission probe. An organization owner may still need to approve the App permission update.";
    case "github_org_ruleset_validation_failed":
      return "GitHub rejected the ruleset payload. Evaluate mode requires GitHub Enterprise; switch to Active or use per-repository setup PR fallback.";
    case "not_repository_maintainer":
      return "Only repository maintainers or workspace admins can confirm repository memory.";
    case "not_workspace_admin":
      return "Only workspace admins can change workspace memory.";
    case "not_user_owner":
      return "User preference memory can only be changed by that user.";
    case "repository_unavailable":
      return "This repository is not available for memory changes. It may be archived, unselected, or outside the workspace.";
    case "memory_active_item_quota_exceeded":
      return "Workspace memory quota is full. Disable or delete older memory before saving or confirming new memory.";
    case "memory_disabled":
      return "Balanced Memory is disabled for this workspace or environment. Existing memory can still be reviewed and removed by authorized admins.";
    case "memory_pending_suggestion_quota_exceeded":
      return "Workspace pending memory suggestion quota is full. Confirm, reject, or let expired suggestions clear before saving more suggestions.";
    case "memory_not_found":
      return "Memory was not found in this workspace.";
    case "contains_secret_like_text":
      return "Memory was blocked because it looks like it contains a secret.";
    case "contains_code_block":
    case "contains_diff_hunk":
      return "Memory was blocked because code or diffs must not be stored.";
    case "contains_large_stacktrace":
      return "Memory was blocked because stack traces must not be stored as memory.";
    case "contains_prompt_injection":
      return "Memory was blocked because it looks like prompt-injection text.";
    case "too_long":
      return "Memory is too long. Save a short distilled preference or rule instead.";
    case "unsafe_for_user_prefs":
      return "User preference memory can only store safe response preferences, not repository-specific facts.";
    case "permission_service_unavailable":
    case "memory_safety_blocked":
      return "Memory policy blocked this change. Refresh and try again with a safer distilled memory.";
    default:
      return "GitHub operation failed. Check audit events or server logs for the safe error code.";
  }
}

function isCodexRotatingProviderState(
  value: string,
): value is CodexRotatingProviderState {
  return [
    "setup_pending",
    "active",
    "permission_required",
    "workflow_update_required",
    "quota_limited",
    "needs_reconnect",
    "stale_queued_secret",
    "skipped_retryable",
    "policy_blocked",
    "unknown_auth_state",
  ].includes(value);
}

export function readCsvEnv(name: string): readonly string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function buildInstallationSettingsUrl(
  installation: Pick<
    DashboardWorkspaceInstallation,
    "accountLogin" | "accountType" | "githubInstallationId"
  >,
): string | null {
  if (!/^\d+$/.test(installation.githubInstallationId)) return null;
  if (installation.accountType === "Organization") {
    if (!/^[A-Za-z0-9-]+$/.test(installation.accountLogin)) return null;
    return `https://github.com/organizations/${installation.accountLogin}/settings/installations/${installation.githubInstallationId}`;
  }
  return `https://github.com/settings/installations/${installation.githubInstallationId}`;
}
