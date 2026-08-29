export function isExpectedPrismaLockTimeoutFailure({
  output,
  migrationName,
  historyEvidence,
  directLockTimeoutProof,
}) {
  const markers = prismaLockTimeoutFailureMarkers({
    output,
    migrationName,
    historyEvidence,
    directLockTimeoutProof,
  });
  const strongPrismaEnvelope =
    markers.prismaMigrationFailure &&
    markers.migrationNamed &&
    (markers.lockTimeout || markers.abortedTransaction);
  const genericAbortedTransactionEnvelope =
    markers.migrationNamed && markers.abortedTransaction;
  return (
    markers.exactCurrentFailure &&
    markers.directLockTimeoutProof &&
    (strongPrismaEnvelope || genericAbortedTransactionEnvelope)
  );
}

export function prismaLockTimeoutFailureMarkers({
  output,
  migrationName,
  historyEvidence,
  directLockTimeoutProof,
}) {
  const normalized = output.toLowerCase();
  const migrationNames = [
    ...output.matchAll(/^[\t ]*Migration name:[\t ]*([^\r\n]+?)[\t ]*\r?$/gmu),
  ].map((match) => match[1]);
  return Object.freeze({
    lockTimeout: normalized.includes("lock timeout"),
    abortedTransaction: normalized.includes("current transaction is aborted"),
    prismaMigrationFailure: normalized.includes("p3018"),
    migrationNamed:
      migrationNames.length === 1 && migrationNames[0] === migrationName,
    currentFailedRows: historyEvidence?.currentFailed ?? null,
    totalRows: historyEvidence?.total ?? null,
    zeroStepRows: historyEvidence?.zeroStep ?? null,
    lockTimeoutLogRows: historyEvidence?.lockTimeoutLog ?? null,
    abortedTransactionLogRows: historyEvidence?.abortedTransactionLog ?? null,
    emptyLogRows: historyEvidence?.emptyLog ?? null,
    exactFailureLogRows: historyEvidence?.exactFailureLog ?? null,
    directLockTimeoutProof:
      directLockTimeoutProof?.migrationName === migrationName &&
      directLockTimeoutProof?.observed === true,
    exactCurrentFailure:
      historyEvidence?.total === 1 &&
      historyEvidence?.currentFailed === 1 &&
      historyEvidence?.zeroStep === 1,
  });
}
