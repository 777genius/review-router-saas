import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  assertReleaseMigrationObservation,
  assertReleaseMigrationTransitionIntegrity,
  deriveOrderedPendingEntriesSha256,
} from "../../packages/features/release-rollout/src/domain/release-migration-transition.ts";
import { stripAtomicMigrationEnvelope } from "../run-codex-rotating-release-migration.mjs";
import {
  assertEmptyApplicableRenderDefaultAcl,
  classifyRenderManagedMembership,
  inspectRenderManagedLedgerRows,
  readRenderManagedCheckoutInventory,
  renderManagedEvidenceDigest,
  renderManagedLedgerSql,
  renderManagedMembershipSql,
  renderManagedMembershipCleanupSql,
  renderManagedTemporaryMembershipSql,
  renderSchemaHandoffDefaultAclSql,
} from "./render-schema-handoff-policy.mjs";
import {
  assertRenderManagedCatalogMatches,
  renderManagedCatalogSql,
} from "./render-managed-catalog.mjs";
import { renderManagedCoordinatorExclusionSql } from "./render-retained-exclusion.mjs";

// Mechanical evidence/SQL only. No registered production review, receipt issuer,
// activation, connection factory or authorization override exists in this phase.
export const renderManagedWorkflowCutoverPhase = Object.freeze({
  sourceCommit: "7870300e71932d8b8cf185004641470d0283cf11",
  baselineCount: 92,
  targetCount: 96,
  atomic: true,
  baselineManifest:
    "sha256:7e53c8fe3c84c3979b6e8c6b1b8f5ded6734f2f053f0a17ae03a468a5939c063",
  targetManifest:
    "sha256:5faad7059a2f57055086dd1571e87706c261a486e8952334401f1d91cc41c97b",
  orderedPendingEntriesSha256:
    "sha256:fb6b96644f88ba940468e0ce26a4ac072ef423f8ba846cb4df28b6a5bcf4a723",
  migrationArtifactDigest:
    "sha256:4a3d4c723b20ecc0ef2f15e80e49d6837f91fee941107a5e712ddfeb657102e9",
  migrationBundleSha256:
    "sha256:bacc616f40d2c7ed2828b7aaca8a369fd697d15f4fc7c7370b2b94c9dabf1814",
});
const phase = renderManagedWorkflowCutoverPhase;
const fail = (reason) => {
  throw new Error(`render_managed_cutover_rejected:${reason}`);
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const equal = (a, b) =>
  renderManagedEvidenceDigest(a) === renderManagedEvidenceDigest(b);
// E literals preserve bytes independently of standard_conforming_strings and
// cannot terminate the surrounding DO dollar quote, even in hostile names.
const literal = (value) =>
  `E'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "''").replaceAll("$", "\\044")}'`;
const json = (value) => `${literal(JSON.stringify(value))}::jsonb`;
const ordered = (ledger) =>
  [...ledger].sort((a, b) => (a.migrationName < b.migrationName ? -1 : 1));
const query = (sql) =>
  sql
    .replace(/^SET search_path = pg_catalog, public;\n/u, "")
    .replace(/;$/u, "");
const ledgerQuery = query(renderManagedLedgerSql);
const membershipQuery = query(renderManagedMembershipSql);
const catalogQuery = query(renderManagedCatalogSql);
const gateQuery = `SELECT jsonb_build_object('gateStatus',status,'authzEpoch',"authzEpoch"::text,'revision',revision::text)
  FROM public."HostedCodexRuntimeGate" WHERE id='global'`;

export function inspectRenderManagedWorkflowCutoverLedger(ledger, original92) {
  const catalog = readRenderManagedCheckoutInventory();
  if (catalog.length !== 96) fail("checkout96_required");
  const result = inspectRenderManagedLedgerRows(catalog, ledger, phase);
  if (original92 !== undefined) {
    if (
      inspectRenderManagedLedgerRows(catalog, original92, phase).count !== 92 ||
      !equal(ordered(ledger).slice(0, 92), ordered(original92))
    )
      fail("original92_changed");
  }
  return result;
}

function assertGate(gate) {
  if (
    !gate ||
    Object.keys(gate).sort().join() !== "authzEpoch,gateStatus,revision" ||
    gate.gateStatus !== "closed" ||
    !/^[1-9][0-9]*$/u.test(gate.authzEpoch) ||
    !/^[1-9][0-9]*$/u.test(gate.revision)
  )
    fail("closed_gate_required");
}

// These are bindings to externally authenticated evidence, NOT receipts. Callers
// must qualify the predecessor and keep durable reconnect exclusion in force.
// Parsing a digest never authenticates it or registers it as a production root.
function assertBinding(binding) {
  const keys = [
    "operationId",
    "predecessorReceiptSha256",
    "original92LedgerDigest",
    "transitionSha256",
    "targetSystemIdentifier",
    "targetRecoveryWitnessSha256",
    "custodyDigest",
    "externalExclusionSha256",
    "reviewedCatalogDigest",
  ];
  if (
    !binding ||
    Object.keys(binding).sort().join() !== keys.sort().join() ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(
      binding.operationId,
    ) ||
    !/^[1-9][0-9]*$/u.test(binding.targetSystemIdentifier) ||
    keys
      .filter((k) => !["operationId", "targetSystemIdentifier"].includes(k))
      .some((k) => !/^sha256:[a-f0-9]{64}$/u.test(binding[k]))
  )
    fail("predecessor_binding");
}

// Snapshot security facts by physical identity, including all routine attributes
// except the two explicitly replaced source bodies. Temp objects are excluded.
const securityQuery = `SELECT jsonb_build_object(
 'relations',(SELECT jsonb_agg(jsonb_build_array(c.oid,c.relowner,c.relacl) ORDER BY c.oid)
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
   AND c.relname NOT IN ('RepositoryInventoryGeneration','WorkflowProvisioning_repositoryId_branch_key','WorkflowProvisioning_repositoryId_key')),
 'columns',(SELECT jsonb_agg(jsonb_build_array(a.attrelid,a.attnum,a.attacl) ORDER BY a.attrelid,a.attnum)
   FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped
   AND NOT (c.relname='WorkflowProvisioning' AND a.attname IN ('attemptId','revision','installationId','pullRequestHeadSha'))
   AND NOT (c.relname='RepositoryConnection' AND a.attname='inventoryGeneration')
   AND c.relname NOT IN ('RepositoryInventoryGeneration','WorkflowProvisioning_repositoryId_branch_key','WorkflowProvisioning_repositoryId_key')),
 'routines',(SELECT jsonb_agg(CASE WHEN p.proname IN ('hosted_codex_comment_token_mint_guard','hosted_codex_comment_token_prepare_authority_complete')
   THEN to_jsonb(p)-'prosrc' ELSE to_jsonb(p) END ORDER BY p.oid)
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'),
 'triggers',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_trigger t
   JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'),
 'memberships',(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.oid) FROM pg_auth_members m),
 'defaults',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.oid) FROM pg_default_acl d),
 'schemas',(SELECT jsonb_agg(jsonb_build_array(n.oid,n.nspowner,n.nspacl) ORDER BY n.oid) FROM pg_namespace n WHERE n.nspname='public'),
 'database',(SELECT jsonb_build_array(datdba,datacl) FROM pg_database WHERE datname=current_database()))`;

// Return an OPEN transaction. The caller must compare complete terminal catalog
// to its independently reviewed expectation in this same transaction, then use
// fresh restricted custody and scope-status connections after it finishes.
export function renderManagedWorkflowCutoverTransaction({
  ledger,
  originalMembership,
  baselineCatalog,
  defaultAcl,
  gate,
  binding,
}) {
  if (inspectRenderManagedWorkflowCutoverLedger(ledger).count !== 92)
    fail("committed_requires_reconciliation");
  assertBinding(binding);
  if (
    binding.original92LedgerDigest !==
    inspectRenderManagedWorkflowCutoverLedger(ledger).ledgerDigest
  )
    fail("predecessor_ledger");
  assertGate(gate);
  if (binding.custodyDigest !== renderManagedEvidenceDigest(gate))
    fail("predecessor_custody");
  classifyRenderManagedMembership([originalMembership], originalMembership);
  assertRenderManagedCatalogMatches(
    baselineCatalog,
    binding.reviewedCatalogDigest,
  );
  assertEmptyApplicableRenderDefaultAcl(defaultAcl, [
    "reviewrouter",
    "reviewrouter_release_schema_owner",
  ]);
  const catalog = readRenderManagedCheckoutInventory();
  const entries = catalog.slice(92);
  if (
    deriveOrderedPendingEntriesSha256(
      entries.map((r) => ({
        migrationName: r.migrationName,
        migrationSqlSha256: r.checksum,
      })),
    ) !== phase.orderedPendingEntriesSha256
  )
    fail("pending_identity");
  const sources = entries.map((row) => {
    const source = readFileSync(
      new URL(
        `../../packages/platform/db/prisma/migrations/${row.migrationName}/migration.sql`,
        import.meta.url,
      ),
      "utf8",
    );
    if (sha256(source) !== row.checksum) fail("source_changed");
    return stripAtomicMigrationEnvelope(source, row.migrationName);
  });
  const bodies = entries.map(
    (
      row,
      i,
    ) => `INSERT INTO public._prisma_migrations(id,checksum,migration_name,started_at,applied_steps_count)
VALUES (gen_random_uuid()::text,'${row.checksum}','${row.migrationName}',clock_timestamp(),0);
SET LOCAL search_path = public, pg_temp;
${sources[i]}
SET LOCAL search_path = pg_catalog, public;
UPDATE public._prisma_migrations SET finished_at=clock_timestamp(),applied_steps_count=1
WHERE migration_name='${row.migrationName}' AND checksum='${row.checksum}' AND finished_at IS NULL;
-- cutover-body-${i + 1}-complete`,
  );
  const sourceChecks = ["guard", "prepare_authority"]
    .map((tag, i) => {
      const body = sources[3].split(`$${tag}$`)[1];
      if (!body) fail("routine_source");
      const name = [
        "hosted_codex_comment_token_mint_guard",
        "hosted_codex_comment_token_prepare_authority_complete",
      ][i];
      return `(SELECT count(*) FROM pg_proc p WHERE p.oid='public.${name}()'::regprocedure AND p.prosrc=${literal(body)})<>1`;
    })
    .join(" OR ");
  return `BEGIN ISOLATION LEVEL READ COMMITTED;
${renderManagedCoordinatorExclusionSql}
SET LOCAL search_path = pg_catalog, public;
DO $identity$ BEGIN
 IF session_user<>'reviewrouter' OR current_user<>'reviewrouter' OR
   (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) THEN RAISE EXCEPTION 'cutover_owner_required'; END IF;
END $identity$;
-- Direct owner row lock, without custody grants or a second live observer.
SELECT 1 FROM public."HostedCodexRuntimeGate" WHERE id='global' FOR SHARE;
DO $baseline$ BEGIN
 IF (${ledgerQuery}) IS DISTINCT FROM ${json(ordered(ledger))}
 OR (${membershipQuery}) IS DISTINCT FROM ${json([originalMembership])}
 OR (${catalogQuery}) IS DISTINCT FROM ${json(baselineCatalog)}
 OR (${query(renderSchemaHandoffDefaultAclSql)}) IS DISTINCT FROM ${json(defaultAcl)}
 OR (${gateQuery}) IS DISTINCT FROM ${json(gate)} THEN RAISE EXCEPTION 'cutover_baseline_changed'; END IF;
 IF to_regprocedure('public.reviewrouter_managed_retained_ledger_guard()') IS NOT NULL
 OR pg_has_role('reviewrouter','reviewrouter_release_schema_owner','USAGE')
 OR pg_has_role('reviewrouter','reviewrouter_release_schema_owner','SET') THEN RAISE EXCEPTION 'cutover_owner_access'; END IF;
END $baseline$;
CREATE TEMP TABLE cutover_security ON COMMIT DROP AS ${securityQuery};
${renderManagedTemporaryMembershipSql}
LOCK TABLE public."ReviewProviderScopeConcurrencyControl" IN SHARE MODE;
DO $scope$ BEGIN
 IF (SELECT count(*) FROM public."ReviewProviderScopeConcurrencyControl")<>1
 OR EXISTS (SELECT 1 FROM public."ReviewProviderScopeConcurrencyControl" WHERE activated IS DISTINCT FROM false)
 THEN RAISE EXCEPTION 'cutover_scope_activated'; END IF;
END $scope$;
-- Retain the entire deterministic winner, including workspace-transfer effects,
-- in transaction-local storage. No runtime values enter logs or returned SQL.
CREATE TEMP TABLE cutover_workflow_expected ON COMMIT DROP AS
SELECT DISTINCT ON (p."repositoryId") to_jsonb(p)||jsonb_build_object(
 'attemptId',p.id,'revision',0,'installationId',r."installationId",'workspaceId',r."workspaceId",
 'status',CASE WHEN p."workspaceId"<>r."workspaceId" THEN 'not_started' ELSE p.status::text END,
 'pullRequestUrl',CASE WHEN p."workspaceId"<>r."workspaceId" THEN NULL ELSE p."pullRequestUrl" END,
 'errorMessage',CASE WHEN p."workspaceId"<>r."workspaceId" THEN NULL ELSE p."errorMessage" END,
 'pullRequestHeadSha',NULL) AS evidence
FROM public."WorkflowProvisioning" p JOIN public."RepositoryConnection" r ON r.id=p."repositoryId"
ORDER BY p."repositoryId",p."updatedAt" DESC,p.id DESC;
${bodies.join("\n")}
${renderManagedMembershipCleanupSql}
-- cutover-membership-cleanup-complete
DO $terminal$ BEGIN
 IF (${securityQuery}) IS DISTINCT FROM (SELECT jsonb_build_object FROM pg_temp.cutover_security)
 OR (${membershipQuery}) IS DISTINCT FROM ${json([originalMembership])}
 OR pg_has_role('reviewrouter','reviewrouter_release_schema_owner','USAGE')
 OR pg_has_role('reviewrouter','reviewrouter_release_schema_owner','SET')
 OR (${gateQuery}) IS DISTINCT FROM ${json(gate)} THEN RAISE EXCEPTION 'cutover_security_changed'; END IF;
 IF (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id COLLATE "C") FROM public."WorkflowProvisioning" p)
 IS DISTINCT FROM (SELECT jsonb_agg(evidence ORDER BY (evidence->>'id') COLLATE "C") FROM pg_temp.cutover_workflow_expected)
 OR EXISTS (SELECT 1 FROM public."RepositoryConnection" WHERE "inventoryGeneration" IS DISTINCT FROM 0)
 THEN RAISE EXCEPTION 'cutover_terminal_data'; END IF;
 IF ${sourceChecks} THEN RAISE EXCEPTION 'cutover_routine_source'; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_sequence s ON s.seqrelid=c.oid
   WHERE c.oid='public."RepositoryInventoryGeneration"'::regclass AND c.relowner='reviewrouter'::regrole
   AND c.relacl IS NULL AND s.seqtypid='bigint'::regtype AND s.seqstart=1 AND s.seqincrement=1
   AND s.seqmin=1 AND s.seqmax=9223372036854775807 AND s.seqcache=1 AND NOT s.seqcycle)
 OR (SELECT count(*) FROM public._prisma_migrations)<>96
 OR jsonb_path_query_array((${ledgerQuery}),'$[0 to 91]') IS DISTINCT FROM ${json(ordered(ledger))}
 OR EXISTS (SELECT 1 FROM public._prisma_migrations m LEFT JOIN jsonb_to_recordset(${json(catalog)}) e("migrationName" text,checksum text)
   ON e."migrationName"=m.migration_name AND e.checksum=m.checksum WHERE e.checksum IS NULL
   OR m.id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
   OR m.started_at IS NULL OR m.finished_at IS NULL OR m.finished_at<m.started_at OR m.rolled_back_at IS NOT NULL
   OR m.applied_steps_count<>1 OR COALESCE(m.logs,'')<>'')
 OR EXISTS (SELECT 1 FROM public._prisma_migrations GROUP BY migration_name HAVING count(*)<>1)
 THEN RAISE EXCEPTION 'cutover_terminal_effects'; END IF;
END $terminal$;
-- Complete reviewed catalog and restricted status verification remain mandatory.
`;
}

// Append inside the open transaction, using the separately qualified terminal
// catalog. The equality is complete; it is not approval by capture.
export function renderManagedWorkflowCutoverCatalogCheck(
  catalog,
  reviewedDigest,
) {
  assertRenderManagedCatalogMatches(catalog, reviewedDigest);
  return `DO $reviewed_terminal$ BEGIN
    IF (${catalogQuery}) IS DISTINCT FROM ${json(catalog)} THEN
      RAISE EXCEPTION 'cutover_reviewed_terminal_drift';
    END IF;
  END $reviewed_terminal$;`;
}

/** Complete observations are comparisons, never qualification of a review root. */
export function assertRenderManagedWorkflowCutoverTerminal({
  ledger,
  original92,
  catalog,
  reviewedCatalogDigest,
  custody,
  originalGate,
  scopeStatus,
  memberships,
  originalMembership,
}) {
  if (
    !Array.isArray(original92) ||
    original92.length !== 92 ||
    inspectRenderManagedWorkflowCutoverLedger(ledger, original92).count !== 96
  )
    fail("terminal96_required");
  assertRenderManagedCatalogMatches(catalog, reviewedCatalogDigest);
  assertGate(originalGate);
  if (
    !custody ||
    custody.authorityProbeCount !== 0 ||
    !equal(
      {
        gateStatus: custody.gateStatus,
        authzEpoch: custody.authzEpoch,
        revision: custody.revision,
      },
      originalGate,
    ) ||
    scopeStatus?.activated !== false ||
    scopeStatus.duplicateActiveVoteLanes !== 0 ||
    scopeStatus.legacyProviderVoteIndex?.exact !== true ||
    classifyRenderManagedMembership(memberships, originalMembership) !==
      "original"
  )
    fail("terminal_custody");
}

// Evidence for the existing durable begin/complete/fail protocol, not another
// release state machine. Never returns SQL or permission to replay/activate.
/** @param {Record<string, unknown>} evidence Untrusted observations; missing facts hold closed. */
export function reconcileRenderManagedWorkflowCutover({
  original92,
  ledger,
  binding,
  durableBinding,
  backendState,
  rollbackConfirmed,
  transition,
  permit,
  observation,
  terminal,
  baselineCatalog,
}) {
  try {
    assertBinding(binding);
    assertBinding(durableBinding);
    if (
      !Array.isArray(original92) ||
      original92.length !== 92 ||
      inspectRenderManagedWorkflowCutoverLedger(original92).ledgerDigest !==
        binding.original92LedgerDigest ||
      renderManagedEvidenceDigest(terminal.originalGate) !==
        binding.custodyDigest
    )
      fail("predecessor_evidence");
    if (!equal(binding, durableBinding) || backendState !== "terminated")
      fail("unresolved_operation");
    const result = inspectRenderManagedWorkflowCutoverLedger(
      ledger,
      original92,
    );
    if (result.count === 92) {
      if (rollbackConfirmed !== true) fail("rollback_unconfirmed");
      assertRenderManagedCatalogMatches(
        baselineCatalog,
        binding.reviewedCatalogDigest,
      );
      assertGate(terminal.originalGate);
      if (
        !equal(terminal.custody, {
          ...terminal.originalGate,
          authorityProbeCount: 0,
        }) ||
        terminal.scopeStatus?.activated !== false ||
        terminal.scopeStatus.duplicateActiveVoteLanes !== 0 ||
        terminal.scopeStatus.legacyProviderVoteIndex?.exact !== true ||
        classifyRenderManagedMembership(
          terminal.memberships,
          terminal.originalMembership,
        ) !== "original"
      )
        fail("rollback_custody");
      return Object.freeze({
        status: "uncommitted-candidate",
        replay: false,
        requiresSameAuthorityOperation: true,
      });
    }
    assertReleaseMigrationTransitionIntegrity(transition);
    if (
      transition.transitionSha256 !== binding.transitionSha256 ||
      transition.preManifestIdentity !== phase.baselineManifest ||
      transition.postManifestIdentity !== phase.targetManifest ||
      transition.orderedPendingEntriesSha256 !==
        phase.orderedPendingEntriesSha256 ||
      transition.migrationArtifactDigest !== phase.migrationArtifactDigest ||
      transition.migrationBundleSha256 !== phase.migrationBundleSha256 ||
      !equal(transition.allowedResumeManifestIdentities, [
        phase.baselineManifest,
        phase.targetManifest,
      ]) ||
      permit.rolloutId !== binding.operationId ||
      permit.expectedPreviousReceiptSha256 !==
        binding.predecessorReceiptSha256 ||
      permit.targetSystemIdentifier !== binding.targetSystemIdentifier ||
      permit.targetRecoveryWitnessSha256 !==
        binding.targetRecoveryWitnessSha256 ||
      permit.transitionSha256 !== transition.transitionSha256 ||
      terminal.reviewedCatalogDigest !== transition.postCatalogDigest
    )
      fail("foreign_transition");
    assertReleaseMigrationObservation(observation, transition, permit);
    assertRenderManagedWorkflowCutoverTerminal({
      ...terminal,
      ledger,
      original92,
    });
    return Object.freeze({
      status: "committed-candidate",
      replay: false,
      requiresDurableCompletion: true,
    });
  } catch {
    return Object.freeze({ status: "hold-closed", replay: false });
  }
}
