import { createSanitizedDiagnostic } from "../packages/features/release-rollout/src/domain/sanitized-diagnostic.js";

export function rehearsalProcessTimedOut(result) {
  return result.timedOut === true || result.error?.code === "ETIMEDOUT";
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
  const output = `${result.stdout}${result.stderr}`;
  if (
    rehearsalProcessTimedOut(result) ||
    result.status === 0 ||
    !expectedFailures.some((expectedFailure) =>
      output.includes(expectedFailure),
    )
  ) {
    const expected =
      expectation === "expected"
        ? JSON.stringify(expectedFailures[0])
        : JSON.stringify(expectedFailures);
    throw new Error(
      `${message}: ${expectation}=${expected}; ${psqlResultDiagnostic(result)}`,
    );
  }
}
