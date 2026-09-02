import {
  hasCanonicalPrismaGenericAbortedTransactionError,
  hasCanonicalPrismaMigrationPostgresErrorEvidence,
  hasExactPostgresErrorEnvelope,
} from "./lib/postgres-error-evidence.mjs";

export function isExpectedPrismaLockTimeoutFailure({
  result,
  output,
  migrationName,
  historyEvidence,
  directLockTimeoutProof,
}) {
  if (result === undefined) return false;
  const markers = prismaLockTimeoutFailureMarkers({
    result,
    output,
    migrationName,
    historyEvidence,
    directLockTimeoutProof,
  });
  const structuredPrismaEnvelope =
    markers.prismaMigrationFailure &&
    markers.migrationNamed &&
    !markers.contradictoryFailure &&
    (markers.exactLockTimeoutEnvelope ||
      markers.exactAbortedTransactionEnvelope);
  const genericPrismaEnvelope =
    markers.genericAbortedTransactionEnvelope &&
    !markers.contradictoryFailure &&
    markers.emptyLogRows === 1;
  return (
    markers.exactCurrentFailure &&
    markers.directLockTimeoutProof &&
    (structuredPrismaEnvelope || genericPrismaEnvelope)
  );
}

function ansiNormalized(output) {
  return output.replace(
    new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "gu"),
    "",
  );
}

export function hasExactPostgresAbortedTransactionEnvelope(
  output,
  postgresInputSource,
) {
  return [
    "exec_bind_message",
    "exec_execute_message",
    "exec_simple_query",
  ].some((routine) =>
    hasExactPostgresErrorEnvelope(
      output,
      {
        sqlState: "25P02",
        message:
          "current transaction is aborted, commands ignored until end of transaction block",
        routine,
      },
      postgresInputSource,
    ),
  );
}

export function hasExactPostgresLockTimeoutEnvelope(
  output,
  postgresInputSource,
) {
  return hasExactPostgresErrorEnvelope(
    output,
    {
      sqlState: "55P03",
      message: "canceling statement due to lock timeout",
      routine: "ProcessInterrupts",
    },
    postgresInputSource,
  );
}

function hasPrismaMigrationEnvelope(result, expected, routines) {
  return routines.some((routine) =>
    hasCanonicalPrismaMigrationPostgresErrorEvidence(result, {
      ...expected,
      routine,
    }),
  );
}

export function prismaLockTimeoutFailureMarkers({
  result,
  output,
  migrationName,
  historyEvidence,
  directLockTimeoutProof,
}) {
  const normalizedOutput = ansiNormalized(
    result ? String(result.stderr ?? "") : output,
  );
  const migrationNames = [
    ...normalizedOutput.matchAll(
      /^[\t ]*Migration name:[\t ]*([^\r\n]+?)[\t ]*\r?$/gimu,
    ),
  ].map((match) => match[1]);
  const prismaFailureCodes = [
    ...normalizedOutput.matchAll(
      /^[\t ]*(?:Error:[\t ]*)?(P\d{4})[\t ]*\r?$/gimu,
    ),
  ].map((match) => match[1]?.toUpperCase());
  return Object.freeze({
    exactLockTimeoutEnvelope:
      result === undefined
        ? hasExactPostgresLockTimeoutEnvelope(normalizedOutput)
        : hasPrismaMigrationEnvelope(
            result,
            {
              sqlState: "55P03",
              message: "canceling statement due to lock timeout",
              migrationName,
            },
            ["ProcessInterrupts"],
          ),
    exactAbortedTransactionEnvelope:
      result === undefined
        ? hasExactPostgresAbortedTransactionEnvelope(normalizedOutput)
        : hasPrismaMigrationEnvelope(
            result,
            {
              sqlState: "25P02",
              message:
                "current transaction is aborted, commands ignored until end of transaction block",
              migrationName,
            },
            ["exec_bind_message", "exec_execute_message", "exec_simple_query"],
          ),
    genericAbortedTransactionEnvelope:
      result !== undefined &&
      hasCanonicalPrismaGenericAbortedTransactionError(result, migrationName),
    prismaMigrationFailure:
      prismaFailureCodes.length === 1 && prismaFailureCodes[0] === "P3018",
    prismaFailureCodePresent: prismaFailureCodes.length > 0,
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
      prismaFailureCodes.length > 1 ||
      prismaFailureCodes.some((code) => code !== "P3018") ||
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
