// A green Vitest exit can contain only skipped tests. Require the actual
// credential-writeback regression and every assertion in its selected file.
export function assertCanaryPhasePostgresResult(report) {
  const suites = report.testResults;
  const assertions = suites?.[0]?.assertionResults;
  if (
    report.success !== true ||
    suites?.length !== 1 ||
    !suites[0].name?.endsWith(
      "/scripts/hosted-pool-canary-phase-recovery.postgres.test.ts",
    ) ||
    suites[0].status !== "passed" ||
    !Array.isArray(assertions) ||
    assertions.length === 0 ||
    !assertions.some(
      (test) =>
        test.title ===
        "runs authenticated 401 -> backup credential writeback -> 429 -> dropped persistence, recovers a lost commit, and preserves a newer real failure",
    ) ||
    assertions.some((test) => test.status !== "passed") ||
    report.numTotalTests !== assertions.length ||
    report.numPassedTests !== assertions.length ||
    report.numFailedTests !== 0 ||
    report.numPendingTests !== 0 ||
    report.numTodoTests !== 0
  )
    throw new Error("canary_phase_pg17_required_regression_not_passed");
}
