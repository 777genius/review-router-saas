export function isExpectedPrismaLockTimeoutFailure({
  output,
  migrationName,
  historyEvidence,
}) {
  const markers = prismaLockTimeoutFailureMarkers({
    output,
    migrationName,
    historyEvidence,
  });
  return (
    markers.prismaMigrationFailure &&
    markers.migrationNamed &&
    markers.exactCurrentFailure &&
    (markers.lockTimeout || markers.abortedTransaction)
  );
}

export function prismaLockTimeoutFailureMarkers({
  output,
  migrationName,
  historyEvidence,
}) {
  const normalized = output.toLowerCase();
  return Object.freeze({
    lockTimeout: normalized.includes("lock timeout"),
    abortedTransaction: normalized.includes("current transaction is aborted"),
    prismaMigrationFailure: normalized.includes("p3018"),
    migrationNamed: normalized.includes(migrationName.toLowerCase()),
    currentFailedRows: historyEvidence?.currentFailed ?? null,
    totalRows: historyEvidence?.total ?? null,
    zeroStepRows: historyEvidence?.zeroStep ?? null,
    lockTimeoutLogRows: historyEvidence?.lockTimeoutLog ?? null,
    abortedTransactionLogRows: historyEvidence?.abortedTransactionLog ?? null,
    emptyLogRows: historyEvidence?.emptyLog ?? null,
    exactFailureLogRows: historyEvidence?.exactFailureLog ?? null,
    exactCurrentFailure:
      historyEvidence?.total === 1 &&
      historyEvidence?.currentFailed === 1 &&
      historyEvidence?.zeroStep === 1 &&
      (historyEvidence?.exactFailureLog === 1 ||
        historyEvidence?.emptyLog === 1),
  });
}
