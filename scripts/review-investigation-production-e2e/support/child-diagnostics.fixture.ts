// Closed vocabularies only: never transport exception text, stacks or requests.
const operations = [
  "configure",
  "snapshot",
  "shutdown",
  "open",
  "plan",
  "commit",
  "conclude",
  "acquire",
  "release",
  "executionAcquire",
  "executionRelease",
] as const;
const phases = [
  "dispatch",
  "client",
  "ownership",
  "composition",
  "handlers",
  "snapshot",
  "execute",
  "terminal_diagnostic",
  "reply",
] as const;
export type ChildPhase = (typeof phases)[number];
const domainCodes = [
  "investigation_idempotency_conflict",
  "item11_invalid_run_id",
  "item11_database_not_assigned",
  "item11_database_owner_mismatch",
  "item11_external_fetch_denied",
  "handler_missing",
  "not_ready",
  "already_configured",
  "unavailable",
  "operation_denied",
  "terminal_diagnostic",
  "investigation_private_material_configuration_required",
  "investigation_retention_maintenance_required",
] as const;
const errorClasses = [
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReviewInvestigationDomainError",
  "PrismaClientKnownRequestError",
  "PrismaClientUnknownRequestError",
  "PrismaClientValidationError",
  "PrismaClientInitializationError",
  "ReviewActionV2RouteFailure",
] as const;
function allowed(
  value: unknown,
  values: readonly string[],
  fallback: string,
): string {
  return typeof value === "string" && values.includes(value) ? value : fallback;
}
export function childDiagnostic(
  error: unknown,
  operation: unknown,
  phase: ChildPhase,
) {
  return {
    code: allowed(
      error instanceof Error ? error.message : undefined,
      domainCodes,
      "child_operation_failed",
    ),
    operation: allowed(operation, operations, "unknown"),
    phase: allowed(phase, phases, "unknown"),
    errorClass: allowed(
      error instanceof Error ? error.name : undefined,
      errorClasses,
      "UnknownError",
    ),
  };
}
// Validate again at the parent IPC boundary, even if a child sends malformed data.
export function formatChildDiagnostic(value: unknown): string {
  const record =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return `${allowed(record.code, domainCodes, "child_operation_failed")} operation=${allowed(record.operation, operations, "unknown")} phase=${allowed(record.phase, phases, "unknown")} class=${allowed(record.errorClass, errorClasses, "UnknownError")}`;
}
