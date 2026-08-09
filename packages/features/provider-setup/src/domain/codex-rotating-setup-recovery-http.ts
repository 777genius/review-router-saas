import { z } from "zod";
import { codexRotatingSetupRecoveryAcknowledgement } from "./codex-rotating-setup-recovery";

export const codexRotatingSetupRecoveryRequestIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.:-]{8,160}$/);

export function assertCodexRotatingSetupRecoveryHttpFields(input: {
  readonly acknowledgement: unknown;
  readonly recoveryRequestId: unknown;
}): void {
  if (input.acknowledgement !== codexRotatingSetupRecoveryAcknowledgement) {
    throw new Error("codex_rotating_setup_recovery_acknowledgement_required");
  }
  if (
    !codexRotatingSetupRecoveryRequestIdSchema.safeParse(
      input.recoveryRequestId,
    ).success
  ) {
    throw new Error("codex_rotating_setup_recovery_request_invalid");
  }
}

const safeRecoveryErrors = new Set([
  "github_cli_token_required",
  "github_cli_token_invalid",
  "github_cli_repository_forbidden",
  "github_cli_repository_not_found",
  "repository_not_found",
  "repository_mismatch",
  "repository_not_selected",
  "repository_archived",
  "installation_not_active",
  "repository_mutation_forbidden",
  "workspace_mutation_forbidden",
  "dashboard_mutation_requires_sign_in",
  "dashboard_auth_misconfigured",
  "dashboard_mutations_disabled",
  "codex_rotating_provider_not_found",
  "codex_rotating_provider_identity_mismatch",
  "codex_rotating_identity_quarantined",
  "codex_rotating_setup_recovery_acknowledgement_required",
  "codex_rotating_setup_recovery_request_invalid",
  "codex_rotating_setup_recovery_not_required",
  "codex_rotating_setup_recovery_already_used",
  "codex_rotating_setup_recovery_required",
  "codex_rotating_setup_recovery_request_conflict",
  "codex_rotating_mutation_still_active",
  "codex_rotating_mutation_ownership_ambiguous",
  "codex_rotating_remote_outcome_unknown",
  "codex_rotating_setup_issuance_quiesced",
  "codex_rotating_setup_lock_failed",
  "invalid_request",
  "rate_limited",
]);

export function safeCodexRotatingSetupRecoveryErrorCode(
  error: unknown,
): string {
  const message = error instanceof Error ? error.message : "unknown_error";
  if (message.startsWith("rate_limit_exceeded:")) return "rate_limited";
  return safeRecoveryErrors.has(message) ? message : "invalid_request";
}

export function codexRotatingSetupRecoveryHttpStatus(code: string): number {
  if (
    code === "github_cli_token_required" ||
    code === "github_cli_token_invalid" ||
    code === "dashboard_mutation_requires_sign_in"
  ) {
    return 401;
  }
  if (
    code === "github_cli_repository_forbidden" ||
    code === "repository_mutation_forbidden" ||
    code === "workspace_mutation_forbidden"
  ) {
    return 403;
  }
  if (code.includes("not_found")) return 404;
  if (code === "rate_limited") return 429;
  if (
    code === "codex_rotating_setup_issuance_quiesced" ||
    code === "dashboard_auth_misconfigured" ||
    code === "dashboard_mutations_disabled"
  ) {
    return 503;
  }
  if (code === "codex_rotating_setup_recovery_request_invalid") return 400;
  if (code.startsWith("codex_rotating_")) {
    return 409;
  }
  return 400;
}
