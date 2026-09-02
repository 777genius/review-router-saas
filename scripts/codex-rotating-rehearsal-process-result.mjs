import { createSanitizedDiagnostic } from "../packages/features/release-rollout/src/domain/sanitized-diagnostic.js";
import {
  hasExactPostgresErrorEnvelope,
  isPostgresFailureWithOneOfExactMessages,
  postgresProcessTimedOut,
} from "./lib/postgres-error-evidence.mjs";

export { hasExactPostgresErrorEnvelope };

export function rehearsalProcessTimedOut(result) {
  return postgresProcessTimedOut(result);
}

export function rehearsalProcessDiagnostic(result) {
  return createSanitizedDiagnostic({
    code: "private_pg17_rehearsal_command_failed",
    phase: "rehearsal",
    exitCode: result.status,
    signal: result.signal,
    timedOut: rehearsalProcessTimedOut(result),
  });
}

export function psqlResultDiagnostic(result) {
  return JSON.stringify(rehearsalProcessDiagnostic(result));
}

export function assertPsqlFailedWithExactMessage(
  result,
  expectedFailure,
  message,
) {
  assertFailedResult(result, [expectedFailure], message, "expected");
}

export function assertPsqlFailedWithOneOfExactMessages(
  result,
  expectedFailures,
  message,
) {
  assertFailedResult(result, expectedFailures, message, "expectedOneOf");
}

function assertFailedResult(result, expectedFailures, message, expectation) {
  const structuredEvidence =
    Array.isArray(expectedFailures) &&
    expectedFailures.length > 0 &&
    expectedFailures.every((failure) => failure && typeof failure === "object");
  const legacyMessages =
    Array.isArray(expectedFailures) &&
    expectedFailures.length > 0 &&
    expectedFailures.every(
      (failure) => typeof failure === "string" && failure.length > 0,
    );
  const legacyFailure = Boolean(
    legacyMessages &&
    !rehearsalProcessTimedOut(result) &&
    Number.isSafeInteger(result?.status) &&
    result.status > 0 &&
    result.status <= 255 &&
    result.signal == null &&
    result.error == null &&
    expectedFailures.some((failure) =>
      `${String(result.stdout ?? "")}${String(result.stderr ?? "")}`.includes(
        failure,
      ),
    ),
  );
  if (
    !(structuredEvidence
      ? isPostgresFailureWithOneOfExactMessages(result, expectedFailures)
      : legacyFailure)
  ) {
    throw new Error(
      `${message}: ${expectation}; ${psqlResultDiagnostic(result)}`,
    );
  }
}
