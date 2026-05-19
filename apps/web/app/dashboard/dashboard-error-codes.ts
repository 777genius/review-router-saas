export function safeDashboardErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown_error";
  const summarizedGitHubApiError = githubDashboardErrorCodeFromMessage(message);
  if (summarizedGitHubApiError) {
    return summarizedGitHubApiError;
  }
  if (message.startsWith("workspace_mutation_forbidden:")) {
    return "workspace_mutation_forbidden";
  }
  if (message.startsWith("entitlement_denied:")) {
    return "entitlement_denied";
  }
  if (message.startsWith("rate_limit_exceeded:")) {
    return "rate_limited";
  }
  if (message.startsWith("github_user_token_request_failed:401")) {
    return "repository_access_token_revoked";
  }
  if (
    message.startsWith("github_user_token_request_failed:403") ||
    message.startsWith("github_user_token_request_failed:404")
  ) {
    return "repository_mutation_forbidden";
  }
  if (
    message.startsWith("missing_form_value:") ||
    message.startsWith("invalid_form_number:") ||
    message.startsWith("invalid_form_boolean:") ||
    message.startsWith("invalid_form_value:")
  ) {
    return "invalid_form";
  }
  if (
    [
      "repository_access_token_missing",
      "repository_access_token_revoked",
      "repository_access_token_expired",
      "repository_access_token_refresh_failed",
      "repository_access_token_decryption_failed",
      "repository_access_token_encryption_misconfigured",
      "repository_access_github_error",
      "dashboard_mutations_disabled",
      "dashboard_auth_misconfigured",
      "dashboard_mutation_requires_sign_in",
      "installation_not_found",
      "repository_not_found",
      "repository_mutation_forbidden",
      "repository_config_mutation_forbidden",
      "repository_not_selected",
      "repository_archived",
      "installation_not_active",
      "github_operation_failed",
      "github_operation_forbidden",
      "github_operation_not_found",
      "github_operation_conflict",
      "github_validation_failed",
      "github_service_unavailable",
      "setup_pr_not_merged",
      "setup_pr_closed",
      "setup_pr_branch_deleted",
      "repository_not_visible_to_github_app",
      "provider_secret_not_found",
      "provider_secret_not_available_to_repository",
      "provider_secret_check_permission_required",
      "organization_secret_scope_forbidden",
      "workflow_provisioning_disabled",
      "org_ruleset_requires_organization_installation",
      "org_ruleset_no_selected_repositories",
      "org_ruleset_all_repositories_requires_all_access",
      "org_ruleset_source_repository_invalid",
      "org_ruleset_source_repository_wrong_owner",
      "org_ruleset_source_repository_not_installed",
      "org_ruleset_source_repository_archived",
      "org_ruleset_source_repository_not_writable",
      "org_ruleset_source_repository_branch_blocked",
      "org_ruleset_source_repository_actions_access_required",
      "org_admin_permission_required",
      "org_rulesets_not_supported",
      "org_ruleset_permission_update_pending",
      "github_org_ruleset_validation_failed",
      "contains_code_block",
      "contains_diff_hunk",
      "contains_large_stacktrace",
      "contains_prompt_injection",
      "contains_secret_like_text",
      "memory_active_item_quota_exceeded",
      "memory_not_found",
      "memory_pending_suggestion_quota_exceeded",
      "memory_safety_blocked",
      "memory_version_conflict",
      "not_repository_maintainer",
      "not_user_owner",
      "not_workspace_admin",
      "permission_service_unavailable",
      "repository_unavailable",
      "too_long",
      "unsafe_for_user_prefs",
    ].includes(message)
  ) {
    return message;
  }
  if (
    message.startsWith("missing_env:") ||
    [
      "invalid_workflow_api_url",
      "invalid_workflow_action_ref",
      "invalid_reusable_workflow_action_ref",
      "invalid_reusable_workflow_runtime_ref",
      "invalid_workflow_env_key",
    ].includes(message)
  ) {
    return "server_misconfigured";
  }
  if (message.startsWith("distributed_lock_not_acquired:")) {
    return "operation_already_running";
  }
  const githubStatus = dashboardErrorHttpStatus(error);
  if (githubStatus > 0) {
    return githubDashboardErrorCodeForStatus(githubStatus);
  }
  return "github_operation_failed";
}

function githubDashboardErrorCodeFromMessage(message: string): string | null {
  if (!message.startsWith("github_api_error:")) {
    return null;
  }

  const status = Number(message.slice("github_api_error:".length));
  return githubDashboardErrorCodeForStatus(status);
}

function dashboardErrorHttpStatus(error: unknown): number {
  return typeof error === "object" && error !== null && "status" in error
    ? Number((error as { readonly status?: unknown }).status)
    : 0;
}

function githubDashboardErrorCodeForStatus(status: number): string {
  if (status === 403) {
    return "github_operation_forbidden";
  }
  if (status === 404) {
    return "github_operation_not_found";
  }
  if (status === 409) {
    return "github_operation_conflict";
  }
  if (status === 422) {
    return "github_validation_failed";
  }
  if (status >= 500 && status <= 599) {
    return "github_service_unavailable";
  }
  return "github_operation_failed";
}
