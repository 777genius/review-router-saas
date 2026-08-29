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
    !markers.contradictoryFailure &&
    (markers.lockTimeout || markers.abortedTransaction);
  const genericAbortedTransactionEnvelope =
    markers.migrationNamed &&
    !markers.contradictoryFailure &&
    markers.abortedTransaction;
  const emptyDatabaseRecordedEnvelope =
    markers.exactAbortedTransactionEnvelope &&
    !markers.contradictoryFailure &&
    !markers.prismaFailureCodePresent &&
    !markers.migrationNameFieldPresent &&
    markers.emptyLogRows === 1 &&
    markers.exactFailureLogRows === 0;
  return (
    markers.exactCurrentFailure &&
    markers.directLockTimeoutProof &&
    (strongPrismaEnvelope ||
      genericAbortedTransactionEnvelope ||
      emptyDatabaseRecordedEnvelope)
  );
}

export function prismaLockTimeoutFailureMarkers({
  output,
  migrationName,
  historyEvidence,
  directLockTimeoutProof,
}) {
  const normalizedOutput = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
  const normalized = normalizedOutput.toLowerCase();
  const migrationNames = [
    ...normalizedOutput.matchAll(
      /^[\t ]*Migration name:[\t ]*([^\r\n]+?)[\t ]*\r?$/gimu,
    ),
  ].map((match) => match[1]);
  return Object.freeze({
    lockTimeout: normalized.includes("lock timeout"),
    abortedTransaction: normalized.includes("current transaction is aborted"),
    exactAbortedTransactionEnvelope:
      /(?:^|\r?\n)(?:ERROR:[\t ]*){1,2}current transaction is aborted(?:,[\t ]*commands ignored until end of transaction block)?(?=\r?\n|$)/iu.test(
        normalizedOutput,
      ),
    prismaMigrationFailure: normalized.includes("p3018"),
    prismaFailureCodePresent: /\bP\d{4}\b/iu.test(normalizedOutput),
    migrationNameFieldPresent: migrationNames.length > 0,
    migrationNamed:
      migrationNames.length === 1 && migrationNames[0] === migrationName,
    currentFailedRows: historyEvidence?.currentFailed ?? null,
    totalRows: historyEvidence?.total ?? null,
    zeroStepRows: historyEvidence?.zeroStep ?? null,
    lockTimeoutLogRows: historyEvidence?.lockTimeoutLog ?? null,
    abortedTransactionLogRows: historyEvidence?.abortedTransactionLog ?? null,
    emptyLogRows: historyEvidence?.emptyLog ?? null,
    exactFailureLogRows: historyEvidence?.exactFailureLog ?? null,
    contradictoryFailure:
      [...normalizedOutput.matchAll(/\b(P\d{4})\b/giu)].some(
        (match) => match[1]?.toUpperCase() !== "P3018",
      ) ||
      /(?:ERROR:\s*)?(?:28P01|3D000|3F000|42501|42703|42704|42883|42P01)\b/iu.test(
        normalizedOutput,
      ) ||
      /\b(?:password authentication failed|authentication failed|permission denied|insufficient privilege)\b/iu.test(
        normalizedOutput,
      ) ||
      /\bdoes not exist\b/iu.test(normalizedOutput),
    directLockTimeoutProof:
      directLockTimeoutProof?.migrationName === migrationName &&
      directLockTimeoutProof?.observed === true,
    exactCurrentFailure:
      historyEvidence?.total === 1 &&
      historyEvidence?.currentFailed === 1 &&
      historyEvidence?.zeroStep === 1,
  });
}
