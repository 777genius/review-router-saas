const contextPrefix = "CONTEXT:  PL/pgSQL function ";
const executorSignature =
  "reviewrouter_execute_release_migration(text,text,text,text,text,bigint,text,jsonb,timestamp with time zone,boolean,boolean)";
const reconciliationSignature =
  "reviewrouter_reconcile_legacy_ambiguity(text,text,jsonb,text,timestamp with time zone)";
const catalogDigestMismatchGuard =
  "release migration target live completion mismatch:catalog_digest_observed";
const catalogDigestDetailPattern =
  /^DETAIL: {2}expected=sha256:[a-f0-9]{64} observed=sha256:[a-f0-9]{64}$/u;
const completeMigrationPermitSignature =
  "reviewrouter_activation.complete_migration_permit(text,bigint,text,jsonb)";
const catalogDigestStatementLines = Object.freeze([
  'SQL statement "SELECT reviewrouter_activation.complete_migration_permit(',
  "      requested_rollout_id,requested_permit_epoch,requested_permit_nonce,",
  `      '{}'::jsonb)"`,
]);
const nestedStatementLines = Object.freeze([
  'SQL statement "CALL public.reviewrouter_reconcile_legacy_ambiguity(',
  "    requested_rollout_id,requested_target_recovery_witness_sha256,",
  "    requested_inventory,",
  "    requested_source_legacy_ambiguity->>'inventorySha256',",
  '    requested_eligibility_cutoff)"',
]);

function isExactContextLine(
  line,
  signature,
  terminal,
  prefixLabel = contextPrefix,
) {
  const prefix = `${prefixLabel}${signature} line `;
  const suffix = ` at ${terminal}`;
  if (!line.startsWith(prefix) || !line.endsWith(suffix)) return false;
  const lineNumber = line.slice(prefix.length, -suffix.length);
  return /^[1-9][0-9]{0,5}$/u.test(lineNumber);
}

function isAsciiPsqlRecord(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code !== 0x0a && (code < 0x20 || code > 0x7e)) return false;
  }
  return true;
}

function isExactStdinErrorLine(line, expectedGuard) {
  const prefix = "psql:<stdin>:";
  const suffix = `: ERROR:  ${expectedGuard}`;
  if (!line.startsWith(prefix) || !line.endsWith(suffix)) return false;
  const lineNumber = line.slice(prefix.length, -suffix.length);
  return /^[1-9][0-9]{0,5}$/u.test(lineNumber);
}

function hasExactPsqlFailureEnvelope(result, expectedGuard) {
  return !(
    result === null ||
    typeof result !== "object" ||
    !Object.hasOwn(result, "status") ||
    !Object.hasOwn(result, "signal") ||
    !Object.hasOwn(result, "stderr") ||
    "error" in result ||
    result.status !== 3 ||
    result.signal !== null ||
    typeof result.stderr !== "string" ||
    typeof expectedGuard !== "string" ||
    expectedGuard.length === 0 ||
    expectedGuard.length > 256 ||
    !isAsciiPsqlRecord(expectedGuard) ||
    expectedGuard.includes("\n") ||
    !isAsciiPsqlRecord(result.stderr) ||
    !result.stderr.endsWith("\n")
  );
}

/**
 * Classify the complete stderr record emitted by the rehearsal's direct psql
 * invocation. The SQL is supplied through the explicit --file=- source, so
 * psql identifies it as exactly <stdin> with its positive input line number.
 * ON_ERROR_STOP makes a server error exit 3, and the default psql verbosity
 * includes the PL/pgSQL context for the guarded executor.
 */
export function isExactPostgresGuardFailure(result, expectedGuard) {
  if (!hasExactPsqlFailureEnvelope(result, expectedGuard)) return false;

  const lines = result.stderr.slice(0, -1).split("\n");
  if (!isExactStdinErrorLine(lines[0], expectedGuard)) return false;
  if (lines.length === 2)
    return isExactContextLine(lines[1], executorSignature, "RAISE");
  if (lines.length !== 8) return false;
  return (
    isExactContextLine(lines[1], reconciliationSignature, "RAISE") &&
    nestedStatementLines.every((line, index) => lines[index + 2] === line) &&
    isExactContextLine(
      lines[7],
      executorSignature,
      "CALL",
      "PL/pgSQL function ",
    )
  );
}

/**
 * Classify the catalog mismatch expected while the raw activation catalog
 * trust root remains pending. Hashes are data; the full psql shape is fixed.
 */
export function isExactPostgresCatalogDigestMismatchFailure(
  result,
  expectedGuard,
) {
  if (
    expectedGuard !== catalogDigestMismatchGuard ||
    !hasExactPsqlFailureEnvelope(result, expectedGuard) ||
    result.stderr.length > 2048
  )
    return false;

  const lines = result.stderr.slice(0, -1).split("\n");
  return (
    lines.length === 7 &&
    isExactStdinErrorLine(lines[0], expectedGuard) &&
    catalogDigestDetailPattern.test(lines[1]) &&
    isExactContextLine(lines[2], completeMigrationPermitSignature, "RAISE") &&
    catalogDigestStatementLines.every(
      (line, index) => lines[index + 3] === line,
    ) &&
    isExactContextLine(
      lines[6],
      executorSignature,
      "PERFORM",
      "PL/pgSQL function ",
    )
  );
}
