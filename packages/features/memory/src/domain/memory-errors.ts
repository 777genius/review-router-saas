export type MemoryErrorCode =
  | "memory_disabled"
  | "memory_input_invalid"
  | "memory_input_too_large"
  | "memory_forbidden_raw_payload"
  | "memory_permission_denied"
  | "memory_permission_unavailable"
  | "memory_scope_forbidden"
  | "memory_safety_blocked"
  | "memory_quality_rejected"
  | "memory_duplicate"
  | "memory_conflict"
  | "memory_version_conflict"
  | "memory_not_found"
  | "memory_source_unavailable"
  | "memory_policy_limit_hit"
  | "memory_index_degraded"
  | "memory_provider_unavailable"
  | "memory_transaction_conflict"
  | "memory_unexpected";

export class MemoryError extends Error {
  constructor(
    readonly code: MemoryErrorCode,
    message = code,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "MemoryError";
  }
}

export function memoryError(
  code: MemoryErrorCode,
  retryable = false,
): MemoryError {
  return new MemoryError(code, code, retryable);
}
