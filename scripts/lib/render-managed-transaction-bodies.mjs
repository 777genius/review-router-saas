import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripAtomicMigrationEnvelope } from "../run-codex-rotating-release-migration.mjs";

// Shared transaction-body construction for every managed in-place migration.
// Extracting it keeps ONE implementation of the ledger start row, the immutable
// body, its search_path envelope and the terminal ledger predicate, instead of
// three drifting copies.
//
// Everything here renders FRAGMENTS ONLY. No BEGIN, no COMMIT, no guard, no
// precondition, no custody and no authorization is produced or removed. Each
// caller keeps its own wrapper: the retained 89->92 wrapper still requires its
// authenticated retained-guard binding, and no caller may assemble an operation
// by concatenating another caller's complete transaction text.

const fail = (reason) => {
  throw new Error(`render_managed_body_rejected:${reason}`);
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// E literals preserve bytes independently of standard_conforming_strings and
// cannot terminate a surrounding DO dollar quote, even in hostile names.
export const literal = (value) =>
  `E'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "''").replaceAll("$", "\\044")}'`;
export const jsonLiteral = (value) =>
  `${literal(JSON.stringify(value))}::jsonb`;

/**
 * Turn a reviewed read-only projection into an inlineable scalar subquery.
 * The prefix and terminator are contract, not cosmetics: a projection that
 * stopped being a single self-contained statement must not silently become an
 * expression inside a DO block.
 */
export function projectionOf(sql, allowedStarts = ["SELECT ", "WITH "]) {
  const prefix = "SET search_path = pg_catalog, public;\n";
  if (
    typeof sql !== "string" ||
    !sql.startsWith(prefix) ||
    !sql.endsWith(";") ||
    !allowedStarts.some((start) => sql.slice(prefix.length).startsWith(start))
  )
    fail("projection_contract");
  return sql.slice(prefix.length, -1);
}

const identity = (row) => {
  if (
    !row ||
    !/^\d{6}_[a-z0-9_]+$/u.test(row.migrationName) ||
    !/^[a-f0-9]{64}$/u.test(row.checksum)
  )
    fail("migration_identity");
  return row;
};

/**
 * Read one immutable published migration body and verify its bytes against the
 * reviewed checksum before the envelope stripper touches it. The seven
 * published migration.sql files are never rewritten, patched or regenerated.
 */
export function readManagedMigrationBody(row) {
  identity(row);
  const source = readFileSync(
    new URL(
      `../../packages/platform/db/prisma/migrations/${row.migrationName}/migration.sql`,
      import.meta.url,
    ),
    "utf8",
  );
  if (sha256(source) !== row.checksum) fail("source_changed");
  return stripAtomicMigrationEnvelope(source, row.migrationName);
}

/**
 * One migration body inside the caller's already-open transaction: the Prisma
 * start row, the immutable body under its own search_path, and the completion
 * update. Nothing else is appended except an optional caller-owned marker used
 * by fault-injection tests to truncate the operation at a known point.
 */
export function renderManagedMigrationBodySql(row, marker) {
  identity(row);
  if (marker !== undefined && !/^[a-z0-9-]+$/u.test(marker))
    fail("body_marker");
  return `INSERT INTO public._prisma_migrations(id,checksum,migration_name,started_at,applied_steps_count)
VALUES (pg_catalog.gen_random_uuid()::text,'${row.checksum}','${row.migrationName}',pg_catalog.clock_timestamp(),0);
-- Unqualified CREATE in the immutable bodies must target public. With
-- pg_catalog omitted it is still searched implicitly FIRST for builtins;
-- pg_temp is explicit and last. Restore the observation path after each body.
SET LOCAL search_path = public, pg_temp;
${readManagedMigrationBody(row)}
SET LOCAL search_path = pg_catalog, public;
UPDATE public._prisma_migrations SET finished_at=pg_catalog.clock_timestamp(),applied_steps_count=1
WHERE migration_name='${row.migrationName}' AND checksum='${row.checksum}' AND finished_at IS NULL;${
    marker === undefined ? "" : `\n-- ${marker}`
  }`;
}

/**
 * The terminal ledger predicate shared by every managed composition. It is a
 * boolean SQL expression that is TRUE when the ledger is unacceptable.
 *
 * It proves four things at once: the exact final row count; that the retained
 * prefix rows are byte-identical to the reviewed original history; that every
 * row present is a reviewed identity with a well-formed id, ordered timestamps,
 * no rollback, exactly one applied step and no logs; and that no migration name
 * appears more than once. Nothing filters, deduplicates or repairs history.
 *
 * @param ledgerQuery inlined renderManagedLedgerSql projection
 * @param catalog reviewed migration identities admitted in the final ledger
 * @param count exact final row count
 * @param prefix reviewed original ledger rows that must survive unchanged
 */
export function renderManagedTerminalLedgerSql({
  ledgerQuery,
  catalog,
  count,
  prefix,
}) {
  if (
    typeof ledgerQuery !== "string" ||
    !ledgerQuery ||
    !Array.isArray(catalog) ||
    !Array.isArray(prefix) ||
    prefix.length === 0 ||
    !Number.isSafeInteger(count) ||
    count !== catalog.length ||
    prefix.length > count
  )
    fail("terminal_ledger_input");
  const identities = catalog.map((row) => ({
    migrationName: identity(row).migrationName,
    checksum: row.checksum,
  }));
  return `(SELECT count(*) FROM public._prisma_migrations)<>${count}
 OR jsonb_path_query_array((${ledgerQuery}),'$[0 to ${prefix.length - 1}]') IS DISTINCT FROM ${jsonLiteral(prefix)}
 OR EXISTS (SELECT 1 FROM public._prisma_migrations m
   LEFT JOIN jsonb_to_recordset(${jsonLiteral(identities)}) e("migrationName" text,checksum text)
   ON e."migrationName"=m.migration_name AND e.checksum=m.checksum
   WHERE e.checksum IS NULL
   OR m.id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
   OR m.started_at IS NULL OR m.finished_at IS NULL OR m.finished_at<m.started_at
   OR m.rolled_back_at IS NOT NULL OR m.applied_steps_count<>1 OR COALESCE(m.logs,'')<>'')
 OR EXISTS (SELECT 1 FROM public._prisma_migrations GROUP BY migration_name HAVING count(*)<>1)`;
}
