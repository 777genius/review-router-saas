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

// Checkout admission only; post-historical additions remain outside managed repair.
const checkoutExtensions = Object.freeze([
  ...renderSchemaHandoffCheckoutExtension,
  Object.freeze({
    migrationName: "000096_hosted_pool_public_repository_eligibility",
    checksum:
      "d1b49b764f406004227f3af9e23e3a4b36268b73d76f8e7b19828d508d8c8826",
  }),
  Object.freeze({
    migrationName: "000098_certified_fork_effect_archive",
    checksum:
      "b90a4178f923d523ee0580ca3fc12279e6a1830ad54404b06c10e991fc12139f",
  }),
  Object.freeze({
    migrationName: "000099_certified_fork_proof_facts",
    checksum:
      "c40a8c3ccdf14c5f84a79b5310dbf67c9306ac8c0a0cfb4f1090ced4c7c01fbd",
  }),
  Object.freeze({
    migrationName: "000100_hosted_codex_device_login",
    checksum:
      "495fd9321ffb92fc75aa60807ef644bd720778cd2529fb08d2a0a183fc7404b6",
  }),
  Object.freeze({
    migrationName: "000101_sdk_growth_authority",
    checksum:
      "b6c7c4005bf3a521a1cbcf3579197b58c0c56c91056a02d01a17c60eb7bbf1b9",
  }),
  Object.freeze({
    migrationName: "000102_sdk_growth_current_authority",
    checksum:
      "49757aeaab4ad1cf6b54f41b3768f7e4c8cdbd8beba9436ef4a3f4aa4c4e87cc",
  }),
  Object.freeze({
    migrationName: "000103_sdk_growth_authority_custody",
    checksum:
      "d6ae002a076c616d33ce854477096408b37e4285bb1c036dd2be13072786c8f9",
  }),
  Object.freeze({
    migrationName: "000104_hosted_pool_request_scoped_failover",
    checksum:
      "7e63286c8bfab3c1cf7aa559c1515fa39a47ec3f8861eefcbf569a5d462039a7",
  }),
  Object.freeze({
    migrationName: "000105_sdk_growth_publication_effect",
    checksum:
      "d92d4368cc20c5217cdeaf18f1abbeec7c98efd873fc91110c6178eb1739848f",
  }),
  Object.freeze({
    migrationName: "000106_sdk_growth_finalized_report_logical_identity",
    checksum:
      "a47efeb47fcac73f502818fdf959ff86e44c228951b2839a1b694072e98c3f6d",
  }),
  Object.freeze({
    migrationName: "000107_hosted_v4_relay_turn_contract",
    checksum:
      "476184a558e47d23ee4127b7ff2221979b37e81faabf8ad66cba42dfd35aba9b",
  }),
  Object.freeze({
    migrationName: "000108_sdk_growth_verifier_assignment",
    checksum:
      "ad11dc22b7c528e68fa371d5a435d1ae494fc07b517d14822bfe9472df35ff1a",
  }),
  Object.freeze({
    migrationName: "000109_sdk_growth_verifier_assignment_lock",
    checksum:
      "750038a865bced544ae9cca42060112a6479c05163c3dc05c41f504c993147ef",
  }),
  Object.freeze({
    migrationName: "000110_historical_unknown_scope_barrier",
    checksum:
      "aa9cd8a8e34e9909dcc22c5a7dd94cc4121821db93330c0a54bb48b0aaf61a79",
  }),
  Object.freeze({
    migrationName: "000111_sdk_growth_source_binding",
    checksum:
      "2d9b80ff0d894ba22602c4d84f7487a5343352e6bd2602f64c0b3cafdce048cd",
  }),
  Object.freeze({
    migrationName: "000112_sdk_growth_operator_credential",
    checksum:
      "0178f5198025c8e0f03bc995139940f9a2c9739f3c3ad000c857e8e0c8b425d0",
  }),
  Object.freeze({
    migrationName: "000113_sdk_growth_approval_ledger",
    checksum:
      "1684eced3efccf7af153c4fd8e24a31a96aec20ddb2674b2764ba56796d8f6c2",
  }),
  Object.freeze({
    migrationName: "000114_sdk_growth_v3_tool_artifact",
    checksum:
      "14d0dd69bdf596cbdfe39306965b08bd969a9d9b89b0a49ddcfe34fe43118d58",
  }),
  Object.freeze({
    migrationName: "000115_sdk_growth_v3_approved_manifest",
    checksum:
      "07fdc348fe27d0ee1ddc15d97e6932cca3dc02cc920d856c4380f71cabb36db0",
  }),
  Object.freeze({
    migrationName: "000116_hosted_codex_relay_admission_utc",
    checksum:
      "af399b3aea5cd73e0b65a46085bba2df216cd44888caf066baa02a6516f7d585",
  }),
  Object.freeze({
    migrationName: "000117_provider_accounts",
    checksum:
      "786e21fc4a8880c25f41304393a576d8e3337b6654720931aa076fdbf793c4e7",
  }),
  Object.freeze({
    migrationName: "000118_workspace_binding_fences",
    checksum:
      "fe73ffe809b3c49b0739060e853e1a824ea6bf019a9922fccc8b729581db48db",
  }),
  Object.freeze({
    migrationName: "000119_review_configuration_gateway_binding",
    checksum:
      "2c0dde1720111063059d5226c6011c15389b6877a6a1f924177a24a36aa81a70",
  }),
  Object.freeze({
    migrationName: "000120_review_run_runtime_snapshot",
    checksum:
      "6ced2dc41f736a2c6e42d6edafc4e9f753622fa157baff09ea962da9d81bd369",
  }),
  Object.freeze({
    migrationName: "000121_review_run_gateway_execution_binding",
    checksum:
      "c00f5df0b3971477cdf666b3259e173aec2df0d150e3335507617242742967e6",
  }),
  Object.freeze({
    migrationName: "000122_review_configuration_operation_receipt",
    checksum:
      "89f9f4eadeb88733adddb051bca5e50bdc86bbb06e45905d3bdf18eedbd1386e",
  }),
  Object.freeze({
    migrationName: "000123_personal_workspace_identity",
    checksum:
      "b459bbb36015e16656fa20d5712b14fa19a87a415b801e0e8ea641e9020f19f6",
  }),
  Object.freeze({
    migrationName: "000124_personal_account_operations",
    checksum:
      "2ffa20a0d21182bad0dfdce6653bc09b436cd72ab6335ac8065a17462bd3c6a1",
  }),
  Object.freeze({
    migrationName: "000125_hosted_codex_device_reconnect",
    checksum:
      "bf6d4c8df95d50a75f85d70c0e80f3c26963cdc86ea05125723af9568f14c54e",
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
  // This independently published checkout addition is not part of the old
  // managed or historical manifests. Validate its exact bytes and predecessor,
  // then validate the complete original history without changing those pins.
  const providerKeyMigration = catalog.find(
    (row) =>
      row.migrationName === "000110_provider_api_key_workspace_management",
  );
  if (providerKeyMigration) {
    if (
      providerKeyMigration.checksum !==
        "d69beaa182fd49ad231bb86b2af4b9d53af3c54cab3a12fa3ca910e7a4379208" ||
      !catalog.some(
        (row) =>
          row.migrationName === "000109_sdk_growth_verifier_assignment_lock",
      )
    )
      fail("checkout_extension");
    return partitionRenderSchemaHandoffCheckout(
      catalog.filter((row) => row !== providerKeyMigration),
    );
  }
  const managed = [];
  let extensions = 0;
  for (const row of catalog) {
    const extension = checkoutExtensions.find(
      (entry) => entry.migrationName === row.migrationName,
    );
    if (!extension) managed.push(row);
    else {
      if (row.checksum !== extension.checksum) fail("checkout_extension");
      extensions++;
    }
  }
  if (
    ![
      0, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
      22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
    ].includes(extensions)
  )
    fail("checkout_extension");
  if (
    extensions === 3 &&
    manifest(catalog) !==
      "sha256:6c62ac869a47211043f8fffdd7af105cb6bd677b65462033195d41e7d7aafa2e"
  )
    fail("checkout_manifest");
  if (
    extensions === 4 &&
    manifest(catalog) !==
      "sha256:5faad7059a2f57055086dd1571e87706c261a486e8952334401f1d91cc41c97b"
  )
    fail("checkout_manifest");
  if (
    extensions === 5 &&
    manifest(catalog) !==
      "sha256:d55f22c9317678a501fbef170b8f0f7b238ad4f1c1fa4232a02e7b291053c273"
  )
    fail("checkout_manifest");
  if (
    extensions === 6 &&
    manifest(catalog) !==
      "sha256:c6b3c39ffd4631d53402f7402700a352d75208bb125b9e48d52d42d5e6a1398c"
  )
    fail("checkout_manifest");
  if (
    extensions === 7 &&
    manifest(catalog) !==
      "sha256:5b967b29970341cad78f4388cd046606464928c5f20392dc7353fa929b1278dc"
  )
    fail("checkout_manifest");
  if (
    extensions === 8 &&
    manifest(catalog) !==
      "sha256:8fdb700169875a4db08732aa0332b619538527fa37e06b71d5f296fa19a30d26"
  )
    fail("checkout_manifest");
  if (
    extensions === 9 &&
    manifest(catalog) !==
      "sha256:dfcbd39f6b18377d7da5b4c1cd1351ae058ade6dc08ba2ebf33ffec5506c9804"
  )
    fail("checkout_manifest");
  if (
    extensions === 10 &&
    manifest(catalog) !==
      "sha256:a2e683899abcc3f9adf377cbc8ecb2e051d84a0e7c6e9fffc0fe32fa150c3983"
  )
    fail("checkout_manifest");
  if (
    extensions === 11 &&
    manifest(catalog) !==
      "sha256:d8c18d54579a469dc03635213cfc3e61e2d9564ed775ee67653482f9776c7287"
  )
    fail("checkout_manifest");
  if (
    extensions === 12 &&
    manifest(catalog) !==
      "sha256:8c76fd167e6483aeced3efba870d8f21fcb9b4f9f5b142ee9a767ee011096f9c"
  )
    fail("checkout_manifest");
  if (
    extensions === 13 &&
    manifest(catalog) !==
      "sha256:51fb004c51bbd2612b04316903695d2d445cb98b64e04f1c054492206683677c"
  )
    fail("checkout_manifest");
  if (
    extensions === 14 &&
    manifest(catalog) !==
      "sha256:c4849371f75ab6239dc91a1ec2ba7ae5bde6d7a5368bc1c7d5509d3d7959fc43"
  )
    fail("checkout_manifest");
  if (
    extensions === 15 &&
    manifest(catalog) !==
      "sha256:118042ec41e57c6a7f35e35d48ab9365ee80f3a1acb864181a7cf9ebf01c72bc"
  )
    fail("checkout_manifest");
  if (
    extensions === 16 &&
    manifest(catalog) !==
      "sha256:1d97937b91028e91b3987eee05057fbe915b7f2354cf2464c8fb507f1086590f"
  )
    fail("checkout_manifest");
  if (
    extensions === 17 &&
    manifest(catalog) !==
      "sha256:1a5470960ccf766827bb58fc0a270553f002802e0019225adb4a0dfcf2b591af"
  )
    fail("checkout_manifest");
  if (
    extensions === 18 &&
    manifest(catalog) !==
      "sha256:48019e5f9ad81af25742e30903b83d7053affa263c2e0674a4f9e4c909b4ec26"
  )
    fail("checkout_manifest");
  if (
    extensions === 19 &&
    manifest(catalog) !==
      "sha256:7e1d7018a5f959cfd5d237fd2ac18dd1436580b05ab0da7a9416bc7dfb842988"
  )
    fail("checkout_manifest");
  if (
    extensions === 20 &&
    manifest(catalog) !==
      "sha256:24a99e65c00ef46f0a63d0823ec12f38575b793e794c82990bd5c3ecfd0a2271"
  )
    fail("checkout_manifest");
  if (
    extensions === 21 &&
    manifest(catalog) !==
      "sha256:06b7ead8634045dd96f1e79626cb1fdcee3bd147ca5068e9fe001705271f5446"
  )
    fail("checkout_manifest");
  if (
    extensions === 22 &&
    manifest(catalog) !==
      "sha256:15a397089c81b84540534361777b74a69a48955df7db81bf6353130d51aa6ed0"
  )
    fail("checkout_manifest");
  if (
    extensions === 23 &&
    manifest(catalog) !==
      "sha256:30f68ffc62e0b46815bc007339d83aa7894b61b23f301c012b8990713cc0ad14"
  )
    fail("checkout_manifest");
  if (
    extensions === 24 &&
    ![
      "sha256:c5c0618f105799d06d21424433cec4a59fc052e63f594c2aace0657ebb52d1dd",
      "sha256:afa28624860779e511a551d38910b94b336b0e638c696cadeffad3f62101c1dc",
    ].includes(manifest(catalog))
  )
    fail("checkout_manifest");
  if (
    extensions === 25 &&
    manifest(catalog) !==
      "sha256:6bd2cd3c077f6cf56735c7192dd6e0f84a21bbec5a2657271cb5afaf1d2f20cf"
  )
    fail("checkout_manifest");
  if (
    extensions === 26 &&
    manifest(catalog) !==
      "sha256:2ee71e958dc9b4a564fd113a4983917ad6e3f7ea22cd19fa29bdb7dc72320e1c"
  )
    fail("checkout_manifest");
  if (
    extensions === 27 &&
    manifest(catalog) !==
      "sha256:f998e11bee1748adecf31dc07ec61d59b55ead60b2734a71f90065d3f9f4aa6b"
  )
    fail("checkout_manifest");
  if (
    extensions === 28 &&
    manifest(catalog) !==
      "sha256:5f01c4416620cf984ffa5fee8dbb26bcf171ae3a89ec4e4b8615e4c7c8461c64"
  )
    fail("checkout_manifest");
  if (
    extensions === 29 &&
    manifest(catalog) !==
      "sha256:858537d185e32ef6258ddf674b5a201e6cc0c4e44fa948a18af23d6dd55905ec"
  )
    fail("checkout_manifest");
  if (
    extensions === 30 &&
    manifest(catalog) !==
      "sha256:5629630be035cbf1677692e840bc07c7292729bfb5bfc0c242f38179f3230df4"
  )
    fail("checkout_manifest");
  if (
    extensions === 31 &&
    manifest(catalog) !==
      "sha256:f26da08b44ad6830f4486f93ed33979acda7b5669a8550601c34dbf9c0322443"
  )
    fail("checkout_manifest");
  if (
    extensions === 32 &&
    manifest(catalog) !==
      "sha256:cf270d22a10557c8ebe66cc7cb5e47eb18a5c43274981b46d340123e7d6ba41a"
  )
    fail("checkout_manifest");
  assertRenderSchemaHandoffCatalog(managed);
  return Object.freeze(managed);
}

// Inspect every directory entry on every read. The shared canonical scanner
// deliberately filters names and caches its inventory; managed admission must
// reject hidden additions without changing that separate canonical contract.
export function readRenderSchemaHandoffCatalog() {
  return partitionRenderSchemaHandoffCheckout(
    readRenderManagedCheckoutInventory(),
  );
}

/** @returns {ReadonlyArray<Readonly<{migrationName: string, checksum: string}>>} */
export function readRenderManagedCheckoutInventory() {
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
  partitionRenderSchemaHandoffCheckout(catalog);
  return Object.freeze(catalog);
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
  return inspectRenderManagedLedgerRows(
    catalog,
    ledger,
    renderManagedMigrationPhase(phase),
  );
}

// Internal strict row validator. Public phase wrappers must first pin the catalog
// and bounds; this helper is evidence validation, never phase admission.
export function inspectRenderManagedLedgerRows(catalog, ledger, contract) {
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
