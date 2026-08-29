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
    (markers.exactLockTimeoutEnvelope ||
      markers.exactAbortedTransactionEnvelope);
  const genericAbortedTransactionEnvelope =
    markers.migrationNamed &&
    !markers.contradictoryFailure &&
    markers.exactAbortedTransactionEnvelope;
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

function ansiNormalized(output) {
  let normalized = "";
  for (let index = 0; index < output.length; index += 1) {
    if (output.charCodeAt(index) !== 27 || output[index + 1] !== "[") {
      normalized += output[index];
      continue;
    }
    let end = index + 2;
    while (end < output.length) {
      const code = output.charCodeAt(end);
      if (code >= 0x40 && code <= 0x7e) break;
      end += 1;
    }
    if (end >= output.length) {
      normalized += output[index];
      continue;
    }
    index = end;
  }
  return normalized;
}

export function hasExactPostgresAbortedTransactionEnvelope(output) {
  return /(?:^|\r?\n)(?:ERROR:[\t ]*){1,2}current transaction is aborted(?:,[\t ]*commands ignored until end of transaction block)?(?=\r?\n|$)/iu.test(
    ansiNormalized(output),
  );
}

export function hasExactPostgresLockTimeoutEnvelope(output) {
  return /(?:^|\r?\n)(?:psql:[^\r\n]+?:\d+:[\t ]*)?(?:ERROR:[\t ]*){1,2}(?:canceling statement due to lock timeout|lock timeout)(?=\r?\n|$)/iu.test(
    ansiNormalized(output),
  );
}

export function prismaLockTimeoutFailureMarkers({
  output,
  migrationName,
  historyEvidence,
  directLockTimeoutProof,
}) {
  const normalizedOutput = ansiNormalized(output);
  const normalized = normalizedOutput.toLowerCase();
  const migrationNames = [
    ...normalizedOutput.matchAll(
      /^[\t ]*Migration name:[\t ]*([^\r\n]+?)[\t ]*\r?$/gimu,
    ),
  ].map((match) => match[1]);
  return Object.freeze({
    exactLockTimeoutEnvelope:
      hasExactPostgresLockTimeoutEnvelope(normalizedOutput),
    exactAbortedTransactionEnvelope:
      hasExactPostgresAbortedTransactionEnvelope(normalizedOutput),
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
