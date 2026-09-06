import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";

// Source and ledger evidence only. These invariants do not authorize a managed
// production baseline, database identity, workflow execution, or runtime entry.
export const renderSchemaHandoffMigrationContract = Object.freeze({
  sourceCommit: "42134d9b8c263915340f910786b6826824bf30b5",
  sourceTree: "23bfcc8d4ce60bbdccf132a0fdd2498d18f62829",
  baselineCount: 89,
  targetCount: 92,
  baselineManifest:
    "sha256:13acb121fbc5bbdebef197d58d5e8dcfca99815e005acc0aae7988bc86d33ef2",
  targetManifest:
    "sha256:7e53c8fe3c84c3979b6e8c6b1b8f5ded6734f2f053f0a17ae03a468a5939c063",
  pending: Object.freeze([
    Object.freeze({
      migrationName: "000087_codex_oauth_v4_v5_workflow_reattestation",
      checksum:
        "af5fccfd987312b85d48cd38b7f528780f52e82daab47c34829581e50193b090",
    }),
    Object.freeze({
      migrationName: "000088_codex_oauth_reattestation_mutation_owner_fence",
      checksum:
        "18a1e48953d1360d3661ea6753b7aa350fc7e28caeaeb65d42c9ac42569f1cf0",
    }),
    Object.freeze({
      migrationName: "000089_codex_oauth_v4_v5_staged_compatibility",
      checksum:
        "bd35157bc11c84dd181ba7f2edf589503d75cb359c12e9a93bf4a884f94c9db7",
    }),
  ]),
});

const fail = (reason) => {
  throw new Error(`render_schema_handoff_rejected:${reason}`);
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const manifest = (rows) =>
  `sha256:${sha256(rows.map((r) => `${r.migrationName}:${r.checksum}`).join(","))}`;

// The two 76-row catalogs are different histories. Only the source prefix
// through 000074 is admitted here; the private-PG17 baseline remains separate.
export const renderManagedMigrationPhases = Object.freeze({
  "managed-retained-upgrade": Object.freeze({
    baselineCount: 76,
    targetCount: 89,
    baselineManifest:
      "sha256:fb3e60a451ece179a3f0c44748f8500ac51ea5dcf186b0732463db4098de94b8",
    targetManifest: renderSchemaHandoffMigrationContract.baselineManifest,
    atomic: false,
  }),
  "managed-schema-handoff": Object.freeze({
    baselineCount: 89,
    targetCount: 92,
    baselineManifest: renderSchemaHandoffMigrationContract.baselineManifest,
    targetManifest: renderSchemaHandoffMigrationContract.targetManifest,
    atomic: true,
  }),
});

export function renderManagedMigrationPhase(phase) {
  if (!Object.hasOwn(renderManagedMigrationPhases, phase))
    fail("managed_phase");
  return renderManagedMigrationPhases[phase];
}

export function assertRenderSchemaHandoffCatalog(catalog) {
  const contract = renderSchemaHandoffMigrationContract;
  if (
    !Array.isArray(catalog) ||
    catalog.length !== contract.targetCount ||
    catalog.some(
      (row, i) =>
        !row ||
        !/^\d{6}_[a-z0-9_]+$/u.test(row.migrationName) ||
        !/^[a-f0-9]{64}$/u.test(row.checksum) ||
        (i > 0 && row.migrationName <= catalog[i - 1].migrationName),
    ) ||
    manifest(catalog) !== contract.targetManifest ||
    manifest(catalog.slice(0, 76)) !==
      renderManagedMigrationPhases["managed-retained-upgrade"]
        .baselineManifest ||
    manifest(catalog.slice(0, contract.baselineCount)) !==
      contract.baselineManifest ||
    catalog
      .slice(contract.baselineCount)
      .some(
        (row, i) =>
          row.migrationName !== contract.pending[i].migrationName ||
          row.checksum !== contract.pending[i].checksum,
      )
  )
    fail("migration_catalog");
}

// Checkout admission only: these PR244 files never enter managed SQL or ledger
// bounds. Full names matter, including the two distinct 000089 directories.
export const renderSchemaHandoffCheckoutExtension = Object.freeze([
  Object.freeze({
    migrationName: "000089_workflow_provisioning_writer_quiescence",
    checksum:
      "92496088bff5e074c19a74a5a9dacdc38cb8794fac0abec605121eb3b61b29f8",
  }),
  Object.freeze({
    migrationName: "000090_workflow_provisioning_attempt_authority",
    checksum:
      "ca3fbbdc19b72ac75c0b31a5ddae887028191ec8c333b769853fc88f2cf37a49",
  }),
  Object.freeze({
    migrationName: "000091_workflow_provisioning_artifact_and_inventory",
    checksum:
      "086a7e2a38e1c3fa67ba44edcdac198af46327fd380eaeb2d13849ac6d22a562",
  }),
]);

export function partitionRenderSchemaHandoffCheckout(catalog) {
  if (
    !Array.isArray(catalog) ||
    catalog.some(
      (row, i) =>
        !row ||
        !/^\d{6}_[a-z0-9_]+$/u.test(row.migrationName) ||
        !/^[a-f0-9]{64}$/u.test(row.checksum) ||
        (i > 0 && row.migrationName <= catalog[i - 1].migrationName),
    )
  )
    fail("checkout_catalog");
  const managed = [];
  let extensions = 0;
  for (const row of catalog) {
    const extension = renderSchemaHandoffCheckoutExtension.find(
      (entry) => entry.migrationName === row.migrationName,
    );
    if (!extension) managed.push(row);
    else {
      if (row.checksum !== extension.checksum) fail("checkout_extension");
      extensions++;
    }
  }
  if (extensions !== 0 && extensions !== 3) fail("checkout_extension");
  if (
    extensions === 3 &&
    manifest(catalog) !==
      "sha256:6c62ac869a47211043f8fffdd7af105cb6bd677b65462033195d41e7d7aafa2e"
  )
    fail("checkout_manifest");
  assertRenderSchemaHandoffCatalog(managed);
  return Object.freeze(managed);
}

// Inspect every directory entry on every read. The shared canonical scanner
// deliberately filters names and caches its inventory; managed admission must
// reject hidden additions without changing that separate canonical contract.
export function readRenderSchemaHandoffCatalog() {
  const directory = new URL(
    "../../packages/platform/db/prisma/migrations/",
    import.meta.url,
  );
  let catalog;
  try {
    const entries = readdirSync(directory, { withFileTypes: true });
    if (
      entries.some(
        (entry) =>
          !entry.isDirectory() || !/^\d{6}_[a-z0-9_]+$/u.test(entry.name),
      )
    )
      fail("checkout_inventory");
    catalog = entries.map(({ name: migrationName }) => {
      const sql = new URL(`${migrationName}/migration.sql`, directory);
      if (!lstatSync(sql).isFile()) fail("checkout_inventory");
      return Object.freeze({
        migrationName,
        checksum: sha256(readFileSync(sql)),
      });
    });
  } catch {
    fail("checkout_inventory");
  }
  catalog.sort((a, b) =>
    a.migrationName < b.migrationName
      ? -1
      : a.migrationName > b.migrationName
        ? 1
        : 0,
  );
  return partitionRenderSchemaHandoffCheckout(catalog);
}

export function assertRenderSchemaHandoffLedger(catalog, ledger, phase) {
  assertRenderSchemaHandoffCatalog(catalog);
  if (!["baseline", "target"].includes(phase)) fail("ledger_phase");
  const count =
    phase === "baseline"
      ? renderSchemaHandoffMigrationContract.baselineCount
      : renderSchemaHandoffMigrationContract.targetCount;
  if (!Array.isArray(ledger) || ledger.length !== count) fail("ledger_count");
  // SQL must return every row, including failed and rolled-back attempts.
  // No filtering or deduplication may convert ambiguous history into a prefix.
  const ordered = [...ledger].sort((a, b) =>
    String(a?.migrationName).localeCompare(String(b?.migrationName), "en"),
  );
  if (
    ordered.some(
      (row, i) =>
        !row ||
        row.migrationName !== catalog[i].migrationName ||
        row.checksum !== catalog[i].checksum ||
        row.finished !== true ||
        row.rolledBack !== false ||
        row.appliedStepsCount !== 1 ||
        row.hasLogs !== false,
    )
  )
    fail("ledger_prefix");
}

// No WHERE, DISTINCT or success-only aggregation: a failed attempt is evidence,
// even if Prisma later recorded a successful row with the same migration name.
// Logs may contain secrets; retain presence and exact-byte digest, not contents.
export const renderManagedLedgerSql = `SET search_path = pg_catalog, public;
SELECT COALESCE(jsonb_agg(jsonb_build_object(
  'id',id,'migrationName',migration_name,'checksum',checksum,
  'startedAt',to_char(started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'finishedAt',to_char(finished_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'rolledBackAt',to_char(rolled_back_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'appliedStepsCount',applied_steps_count,
  'logsPresent',logs IS NOT NULL,'hasLogs',logs IS NOT NULL AND logs <> '',
  'logsDigest',CASE WHEN logs IS NULL THEN NULL ELSE
    'sha256:'||encode(sha256(convert_to(logs,'UTF8')),'hex') END
) ORDER BY migration_name COLLATE "C",id COLLATE "C"),'[]'::jsonb)
FROM public._prisma_migrations;`;

// Run on a fresh custody-role connection. The lock and read are separate
// READ COMMITTED statements: a SELECT sharing the lock statement's earlier
// snapshot could misreport a gate update that committed while the lock waited.
// All reads use existing custody grants; no owner SELECT or ACL widening.
export const renderManagedTerminalCustodySql = `BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '5000ms';
SET LOCAL statement_timeout = '120000ms';
DO $custody_lock$ BEGIN
  PERFORM public.hosted_codex_lock_comment_token_runtime_gate();
END $custody_lock$;
SELECT jsonb_build_object('gateStatus',g.status,'authzEpoch',g."authzEpoch"::text,
  'revision',g.revision::text,'authorityProbeCount',
  (SELECT count(*) FROM public.hosted_codex_comment_token_authority_snapshot(NULL)))
FROM public."HostedCodexRuntimeGate" g WHERE g.id='global';
ROLLBACK;`;

// Canonicalize JSON object keys only. Array ordering is part of each reviewed
// projection's contract; a reordered or duplicated fact is never normalized away.
export function renderManagedEvidenceDigest(value) {
  const canonical = (item, depth = 0) => {
    if (depth > 32) fail("managed_evidence_json");
    if (item === null || ["string", "boolean"].includes(typeof item))
      return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length)
        fail("managed_evidence_json");
      return item.map((child) => canonical(child, depth + 1));
    }
    if (
      typeof item !== "object" ||
      Object.getPrototypeOf(item) !== Object.prototype
    )
      fail("managed_evidence_json");
    return Object.fromEntries(
      Object.keys(item)
        .sort()
        .map((key) => [key, canonical(item[key], depth + 1)]),
    );
  };
  return `sha256:${sha256(JSON.stringify(canonical(value)))}`;
}

const timestamp = (value) => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(value)
  )
    return false;
  const date = new Date(value);
  return (
    Number.isFinite(date.getTime()) &&
    date.toISOString() === `${value.slice(0, 23)}Z`
  );
};
const ledgerKeys = [
  "id",
  "migrationName",
  "checksum",
  "startedAt",
  "finishedAt",
  "rolledBackAt",
  "appliedStepsCount",
  "logsPresent",
  "hasLogs",
  "logsDigest",
]
  .sort()
  .join();

export function inspectRenderManagedLedger(catalog, ledger, phase) {
  assertRenderSchemaHandoffCatalog(catalog);
  const contract = renderManagedMigrationPhase(phase);
  if (
    !Array.isArray(ledger) ||
    ledger.length < contract.baselineCount ||
    ledger.length > contract.targetCount ||
    (contract.atomic &&
      ![contract.baselineCount, contract.targetCount].includes(ledger.length))
  )
    fail("managed_ledger_count");
  const ordered = [...ledger].sort((a, b) =>
    String(a?.migrationName) < String(b?.migrationName) ? -1 : 1,
  );
  const ids = new Set();
  const emptyLogDigest = `sha256:${sha256("")}`;
  for (const [index, row] of ordered.entries()) {
    if (
      !row ||
      Object.keys(row).sort().join() !== ledgerKeys ||
      typeof row.id !== "string" ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(row.id) ||
      ids.has(row.id) ||
      row.migrationName !== catalog[index].migrationName ||
      row.checksum !== catalog[index].checksum ||
      !timestamp(row.startedAt) ||
      !timestamp(row.finishedAt) ||
      row.finishedAt < row.startedAt ||
      row.rolledBackAt !== null ||
      row.appliedStepsCount !== 1 ||
      row.hasLogs !== false ||
      !(
        (row.logsPresent === false && row.logsDigest === null) ||
        (row.logsPresent === true && row.logsDigest === emptyLogDigest)
      )
    )
      fail("managed_ledger_history");
    ids.add(row.id);
  }
  return Object.freeze({
    count: ordered.length,
    position:
      ordered.length === contract.targetCount
        ? "target"
        : ordered.length === contract.baselineCount
          ? "baseline"
          : "partial",
    manifest: manifest(ordered),
    ledgerDigest: renderManagedEvidenceDigest(ordered),
    pending: Object.freeze(catalog.slice(ordered.length, contract.targetCount)),
  });
}

const schemaOwner = "reviewrouter_release_schema_owner";
const managedOwner = "reviewrouter";
const temporaryMembership = Object.freeze({
  role: schemaOwner,
  member: managedOwner,
  grantor: managedOwner,
  adminOption: false,
  inheritOption: true,
  setOption: true,
});
export const renderManagedMembershipSql = `SET search_path = pg_catalog, public;
SELECT COALESCE(jsonb_agg(jsonb_build_object(
  'role',parent.rolname,'member',member.rolname,'grantor',grantor.rolname,
  'adminOption',m.admin_option,'inheritOption',m.inherit_option,'setOption',m.set_option
) ORDER BY grantor.rolname COLLATE "C"),'[]'::jsonb)
FROM pg_catalog.pg_auth_members m
LEFT JOIN pg_catalog.pg_roles parent ON parent.oid=m.roleid
LEFT JOIN pg_catalog.pg_roles member ON member.oid=m.member
LEFT JOIN pg_catalog.pg_roles grantor ON grantor.oid=m.grantor
WHERE m.roleid='${schemaOwner}'::regrole AND m.member='${managedOwner}'::regrole;`;

// These statements preserve the provider-granted ADMIN recovery edge. The
// temporary self-grant intentionally has both INHERIT and SET, as in r6 evidence.
export const renderManagedTemporaryMembershipSql = `GRANT ${schemaOwner} TO ${managedOwner}
WITH ADMIN FALSE, INHERIT TRUE, SET TRUE GRANTED BY ${managedOwner};`;
export const renderManagedMembershipCleanupSql = `REVOKE ${schemaOwner} FROM ${managedOwner}
GRANTED BY ${managedOwner} RESTRICT;`;

export function classifyRenderManagedMembership(rows, reviewedOriginal) {
  if (
    !reviewedOriginal ||
    reviewedOriginal.role !== schemaOwner ||
    reviewedOriginal.member !== managedOwner ||
    typeof reviewedOriginal.grantor !== "string" ||
    !/^[a-z_][a-z0-9_]{0,62}$/u.test(reviewedOriginal.grantor) ||
    reviewedOriginal.grantor === managedOwner ||
    reviewedOriginal.adminOption !== true ||
    reviewedOriginal.inheritOption !== false ||
    reviewedOriginal.setOption !== false ||
    Object.keys(reviewedOriginal).sort().join() !==
      Object.keys(temporaryMembership).sort().join()
  )
    fail("managed_original_membership");
  const equal = (a, b) =>
    renderManagedEvidenceDigest(a) === renderManagedEvidenceDigest(b);
  if (!Array.isArray(rows)) fail("managed_membership_unknown");
  if (rows.length === 1 && equal(rows[0], reviewedOriginal)) return "original";
  if (
    rows.length === 2 &&
    rows.filter((r) => equal(r, reviewedOriginal)).length === 1 &&
    rows.filter((r) => equal(r, temporaryMembership)).length === 1
  )
    return "temporary";
  fail("managed_membership_drift");
}

export function assertRenderManagedRoleBranch(roles) {
  if (!Array.isArray(roles)) fail("managed_roles_unknown");
  const owners = roles.filter((role) => role?.name === schemaOwner);
  const operators = roles.filter(
    (role) => role?.name === "reviewrouter_release_migration",
  );
  if (!owners.length && !operators.length)
    fail("managed_roles_self_hosted_branch");
  if (owners.length !== 1 || operators.length !== 1)
    fail("managed_roles_partial");
  for (const [key, value] of Object.entries({
    canLogin: false,
    superuser: false,
    bypassRls: false,
    replication: false,
    createDatabase: false,
    createRole: false,
  }))
    if (owners[0][key] !== value) fail("managed_schema_owner_role");
  for (const [key, value] of Object.entries({
    canLogin: true,
    superuser: false,
    bypassRls: false,
    replication: false,
    createDatabase: false,
    createRole: false,
  }))
    if (operators[0][key] !== value) fail("managed_release_role");
}

// No production-shaped managed baseline/postcondition captures have independent
// approval in this checkout. Review must pin complete contracts in source;
// neither a CLI path, an environment digest nor a fixture can populate this map.
const reviewedManagedContracts = Object.freeze({
  "managed-retained-upgrade": null,
  "managed-schema-handoff": null,
});

export function readReviewedRenderManagedContract(phase) {
  renderManagedMigrationPhase(phase);
  const review = reviewedManagedContracts[phase];
  if (!review) fail("managed_independent_review_missing");
  const bytes = readFileSync(new URL(review.path, import.meta.url));
  if (`sha256:${sha256(bytes)}` !== review.digest) fail("managed_review_bytes");
  const contract = JSON.parse(bytes.toString("utf8"));
  if (
    contract.phase !== phase ||
    contract.version !== 1 ||
    contract.sourceCommit !==
      renderSchemaHandoffMigrationContract.sourceCommit ||
    contract.sourceTree !== renderSchemaHandoffMigrationContract.sourceTree
  )
    fail("managed_review_identity");
  return contract;
}

// Return the complete default-ACL catalog. The caller must bind its relevant
// principals to the separately reviewed role and grantor-aware membership
// policy before interpreting applicability. LEFT joins preserve unresolved
// OIDs and empty ACL overrides as rows.
export const renderSchemaHandoffDefaultAclSql = `SET search_path = pg_catalog, public;
SELECT jsonb_build_object(
  'version',1,
  'rows',COALESCE(jsonb_agg(jsonb_build_object(
    'oid',d.oid::text,'owner',owner.rolname,
    'schema',CASE WHEN d.defaclnamespace=0 THEN '*' ELSE n.nspname END,
    'objectType',d.defaclobjtype,
    'entries',CASE WHEN d.defaclacl IS NULL THEN NULL ELSE (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE grantee.rolname END,
        'grantor',grantor.rolname,'privilege',a.privilege_type,
        'grantable',a.is_grantable
      ) ORDER BY a.grantee,a.grantor,a.privilege_type),'[]'::jsonb)
      FROM pg_catalog.aclexplode(d.defaclacl) a
      LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid=a.grantee
      LEFT JOIN pg_catalog.pg_roles grantor ON grantor.oid=a.grantor
    ) END
  ) ORDER BY d.oid),'[]'::jsonb)
)
FROM pg_catalog.pg_default_acl d
LEFT JOIN pg_catalog.pg_roles owner ON owner.oid=d.defaclrole
LEFT JOIN pg_catalog.pg_namespace n ON n.oid=d.defaclnamespace;`;

// An empty set of applicable rows is valid. An override row with an empty
// aclitem[] is a distinct policy change. Missing observations and unresolved
// identities must never be coerced to the valid empty set.
export function assertEmptyApplicableRenderDefaultAcl(observation, principals) {
  if (
    !Array.isArray(principals) ||
    principals.length === 0 ||
    principals.some((name) => typeof name !== "string" || !name) ||
    new Set(principals).size !== principals.length ||
    observation?.version !== 1 ||
    !Array.isArray(observation.rows)
  )
    fail("default_acl_unknown");
  const seen = new Set();
  for (const row of observation.rows) {
    if (
      !row ||
      typeof row.oid !== "string" ||
      !/^[1-9][0-9]*$/u.test(row.oid) ||
      seen.has(row.oid) ||
      typeof row.owner !== "string" ||
      !row.owner ||
      typeof row.schema !== "string" ||
      !row.schema ||
      !["r", "S", "f", "T", "n"].includes(row.objectType) ||
      !Array.isArray(row.entries) ||
      row.entries.some(
        (entry) =>
          !entry ||
          typeof entry.grantee !== "string" ||
          !entry.grantee ||
          typeof entry.grantor !== "string" ||
          !entry.grantor ||
          typeof entry.privilege !== "string" ||
          !entry.privilege ||
          typeof entry.grantable !== "boolean",
      )
    )
      fail("default_acl_unresolved");
    seen.add(row.oid);
    if (
      ["*", "public"].includes(row.schema) &&
      (principals.includes(row.owner) ||
        row.entries.some(
          (entry) =>
            entry.grantee === "PUBLIC" ||
            principals.includes(entry.grantee) ||
            principals.includes(entry.grantor),
        ))
    )
      fail("default_acl_policy");
  }
}
