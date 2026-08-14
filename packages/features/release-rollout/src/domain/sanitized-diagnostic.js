const diagnosticVersion = 1;

const operatorHints = Object.freeze({
  provider_http_request_failed:
    "Check provider reachability and retry only when the operation is safe.",
  provider_http_response_rejected:
    "Check provider status and authorization configuration.",
  provider_http_response_invalid:
    "Check the provider contract and service version.",
  release_rollout_process_boundary_rejected:
    "Remove credentials from argv and use the approved credential file boundary.",
  release_rollout_process_failed:
    "Inspect the named rollout phase and rerun after correcting the local dependency.",
  release_migration_step_failed:
    "Inspect the release migration phase using secret-free provider logs.",
  release_authority_migration_process_failed:
    "Inspect the authority migration phase using secret-free database logs.",
  private_pg17_rehearsal_command_failed:
    "Inspect the disposable rehearsal phase and local container state.",
});

const phases = new Set([
  "provider_request",
  "provider_response",
  "process_boundary",
  "process_execute",
  "process_hash",
  "process_denial_probe",
  "release_migration",
  "authority_migration",
  "rehearsal",
  "rehearsal_cleanup",
]);

const signals = new Set([
  "SIGABRT",
  "SIGALRM",
  "SIGBUS",
  "SIGFPE",
  "SIGHUP",
  "SIGILL",
  "SIGINT",
  "SIGKILL",
  "SIGPIPE",
  "SIGQUIT",
  "SIGSEGV",
  "SIGTERM",
  "SIGTRAP",
]);

function optionalInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : null;
}

/**
 * Constructs the only diagnostic shape allowed to cross a release adapter.
 * The input deliberately has no command, argv, env, URL, body, headers, output,
 * message, or cause fields, so raw provider/process data cannot be serialized.
 */
export function createSanitizedDiagnostic(input) {
  const operatorHint = operatorHints[input.code];
  if (typeof operatorHint !== "string" || !phases.has(input.phase))
    throw new Error("sanitized_diagnostic_contract_invalid");
  const metadata = {};
  const httpStatus = optionalInteger(input.httpStatus, 100, 599);
  const attempt = optionalInteger(input.attempt, 1, 5);
  const maxAttempts = optionalInteger(input.maxAttempts, 1, 5);
  if (httpStatus !== null) metadata.httpStatus = httpStatus;
  if (attempt !== null) metadata.attempt = attempt;
  if (maxAttempts !== null) metadata.maxAttempts = maxAttempts;
  if (input.timedOut === true) metadata.timedOut = true;
  if (input.ambiguousWrite === true) metadata.ambiguousWrite = true;
  const exitCode = optionalInteger(input.exitCode, 0, 255);
  const signal = signals.has(input.signal) ? input.signal : null;
  return Object.freeze({
    version: diagnosticVersion,
    code: input.code,
    phase: input.phase,
    exit: Object.freeze({ code: exitCode, signal }),
    metadata: Object.freeze(metadata),
    operatorHint,
  });
}

export class SanitizedDiagnosticError extends Error {
  constructor(diagnostic) {
    super(JSON.stringify(diagnostic));
    this.name = "SanitizedDiagnosticError";
    this.code = diagnostic.code;
    this.diagnostic = diagnostic;
  }

  toJSON() {
    return this.diagnostic;
  }
}

export function sanitizedDiagnosticError(input) {
  return new SanitizedDiagnosticError(createSanitizedDiagnostic(input));
}

export function isSanitizedDiagnosticError(value) {
  return value instanceof SanitizedDiagnosticError;
}
