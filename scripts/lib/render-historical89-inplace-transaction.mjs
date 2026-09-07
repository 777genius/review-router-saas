import {
  assertHistorical89AdmissionIdentity,
  assertHistorical89CreatedObjectAcl,
  assertHistorical89Creators,
  assertHistorical89ProviderDefaultAcl,
  renderHistorical89AdmissionPhase,
  renderHistorical89DefaultAclSql,
  renderHistorical89ObjectAclSql,
} from "./render-historical89-admission.mjs";
import {
  classifyRenderManagedMembership,
  inspectRenderManagedLedgerRows,
  readRenderManagedCheckoutInventory,
  renderManagedEvidenceDigest,
  renderManagedLedgerSql,
  renderManagedMembershipCleanupSql,
  renderManagedMembershipSql,
} from "./render-schema-handoff-policy.mjs";
import {
  assertRenderManagedCatalogMatches,
  renderManagedCatalogSql,
} from "./render-managed-catalog.mjs";
import {
  renderManagedCoordinatorExclusionSql,
  renderManagedCoordinatorGuardSql,
} from "./render-retained-exclusion.mjs";
import {
  renderSchemaHandoffBodiesSql,
  renderSchemaHandoffOwnerPreconditionSql,
  renderSchemaHandoffOwnershipTransferSql,
  renderSchemaHandoffTerminalSql,
} from "./render-schema-handoff-transaction.mjs";
import {
  assertRenderManagedClosedGate,
  renderManagedRuntimeGateSql,
  renderManagedWorkflowCutoverBodiesSql,
  renderManagedWorkflowCutoverCatalogCheck,
  renderManagedWorkflowCutoverPreambleSql,
  renderManagedWorkflowCutoverTerminalSql,
} from "./render-managed-workflow-cutover.mjs";
import {
  jsonLiteral,
  projectionOf,
} from "./render-managed-transaction-bodies.mjs";

// ---------------------------------------------------------------------------
// Composition of the reviewed 89->92 and 92->96 bodies into ONE transaction.
// ---------------------------------------------------------------------------
//
// This module composes the two accepted libraries by calling their exported
// transaction-body functions. It never concatenates their complete BEGIN
// wrappers and never removes a guard by editing their text: the 89->92 wrapper
// still requires an authenticated retained-guard binding and is unchanged and
// unused here, because the observed historical database provably never had that
// guard. That difference is stated as an explicit, checked precondition
// ("authentic guardless 89"), not as a silent omission.
//
// 89 and 96 are the only durable endpoints. 92 is verified inside the SAME
// backend and transaction by running the 89->92 library's own terminal
// verification; no durable 92 checkpoint, ledger commit or receipt is
// synthesized. The returned transaction has NO COMMIT.
//
// Nothing here is authorization. The record this function returns states
// `authorizesMutation: false` and `custodyEstablished: false`. A production
// caller must additionally qualify the admission through
// qualifyHistorical89Admission (which fails closed today: no independently
// reviewed expectation registry exists), hold current operation custody, keep a
// durable external fence, and write its operation-bound effect receipt inside
// this same transaction before committing. None of that exists in this module.

const phase = renderHistorical89AdmissionPhase;
const fail = (reason) => {
  throw new Error(`render_historical89_inplace_rejected:${reason}`);
};
const schemaOwner = "reviewrouter_release_schema_owner";
const managedOwner = "reviewrouter";
const retainedGuardName = "reviewrouter_managed_retained_ledger_guard";

// The reviewed roles a created object may be owned by when the operation ends.
// The creating role stays `reviewrouter` for every body; the immutable 087/089
// bodies then re-own what they create to the CURRENT owner of
// CodexOAuthSecretNamespace, which the reviewed 89->92 ownership handover has
// already moved to the release schema owner.
const reviewedTerminalOwners = Object.freeze([managedOwner, schemaOwner]);

// The ONLY objects that already exist at 89 and legitimately change owner. Both
// transfers come from reviewed immutable source: the table from the 89->92
// ownership handover, the routine from 000087's canonical-owner loop. Every
// other surviving object must keep its original owner.
const reviewedOwnerTransfers = Object.freeze([
  Object.freeze({
    identity: 'public."CodexOAuthSecretNamespace"',
    from: managedOwner,
    to: schemaOwner,
  }),
  Object.freeze({
    identity: "public.codex_oauth_secret_namespace_tombstone_guard()",
    from: managedOwner,
    to: schemaOwner,
  }),
]);

const ledgerQuery = projectionOf(renderManagedLedgerSql, ["SELECT "]);
const membershipQuery = projectionOf(renderManagedMembershipSql, ["SELECT "]);
const catalogQuery = projectionOf(renderManagedCatalogSql);
const defaultAclQuery = projectionOf(renderHistorical89DefaultAclSql, [
  "SELECT ",
]);

/** Fault-injection markers, in the order the transaction reaches them. */
export const renderHistorical89InPlaceMarkers = Object.freeze([
  "historical89-body-1-complete",
  "historical89-body-2-complete",
  "historical89-body-3-complete",
  "historical89-interim92-verified",
  "historical89-body-4-complete",
  "historical89-body-5-complete",
  "historical89-body-6-complete",
  "historical89-body-7-complete",
  "historical89-membership-cleanup-complete",
]);

/**
 * Strict validation of an observed ledger against the 89->96 bounds. Only the
 * two durable endpoints are admissible; a partial count is never a position.
 */
export function inspectHistorical89InPlaceLedger(ledger) {
  const catalog = readRenderManagedCheckoutInventory();
  if (catalog.length !== phase.targetCount) fail("checkout96_required");
  return inspectRenderManagedLedgerRows(catalog, ledger, phase);
}

/**
 * Validate every piece of evidence the composed transaction binds, without
 * building SQL. Returns the reviewed creating roles and the admission identity
 * digest. It authenticates nothing and authorizes nothing.
 */
export function assertHistorical89InPlaceInputs({
  admission,
  ledger,
  originalMembership,
  baselineCatalog,
  defaultAcl,
  creatorEvidence,
  gate,
}) {
  const identityDigest = assertHistorical89AdmissionIdentity(admission);
  const observed = inspectHistorical89InPlaceLedger(ledger);
  if (observed.count !== phase.baselineCount)
    fail("committed_requires_reconciliation");
  if (observed.ledgerDigest !== admission.originalLedgerDigest)
    fail("original_ledger_binding");
  if (observed.manifest !== phase.baselineManifest)
    fail("baseline_manifest_binding");
  classifyRenderManagedMembership([originalMembership], originalMembership);
  if (
    renderManagedEvidenceDigest([originalMembership]) !==
    admission.membershipDigest
  )
    fail("membership_binding");
  assertRenderManagedCatalogMatches(baselineCatalog, admission.catalogDigest);
  const creators = assertHistorical89Creators(creatorEvidence);
  // The creator-aware branch, NOT the old empty-applicable-defaults assertion.
  // That assertion is untouched and still rejects these four provider rows for
  // the retained phase; this is an addition for a separately qualified history.
  assertHistorical89ProviderDefaultAcl(defaultAcl, creators);
  if (renderManagedEvidenceDigest(defaultAcl) !== admission.aclDigest)
    fail("default_acl_binding");
  assertRenderManagedClosedGate(gate);
  if (renderManagedEvidenceDigest(gate) !== admission.custodyDigest)
    fail("gate_binding");
  return Object.freeze({
    identityDigest,
    creators,
    ordered: Object.freeze(
      [...ledger].sort((a, b) => (a.migrationName < b.migrationName ? -1 : 1)),
    ),
  });
}

/**
 * Build ONE open transaction that takes an authentically guardless historical
 * 89 baseline to 96.
 *
 * @returns a frozen record. `sql` is an OPEN transaction with no COMMIT; the
 *   caller must still append its reviewed terminal catalog check, its
 *   operation-bound effect receipt and its own COMMIT.
 */
export function renderHistorical89InPlaceTransaction({
  admission,
  ledger,
  originalMembership,
  baselineCatalog,
  defaultAcl,
  creatorEvidence,
  gate,
}) {
  const { identityDigest, creators, ordered } = assertHistorical89InPlaceInputs(
    {
      admission,
      ledger,
      originalMembership,
      baselineCatalog,
      defaultAcl,
      creatorEvidence,
      gate,
    },
  );
  const sql = `BEGIN ISOLATION LEVEL READ COMMITTED;
-- ${phase.kind} admission ${identityDigest}
-- operation ${admission.operationId}; durable endpoints 89 and 96 only.
${renderManagedCoordinatorExclusionSql}
SET LOCAL search_path = pg_catalog, public;
${renderManagedCoordinatorGuardSql}
DO $historical_identity$ BEGIN
  -- Immutable cluster and database identity, not the mutable database name
  -- alone. The name is additionally pinned in the admission contract.
  IF current_database() <> '${admission.databaseName}'
     OR (SELECT system_identifier::text FROM pg_control_system()) <> '${admission.systemIdentifier}'
     OR (SELECT oid::text FROM pg_database WHERE datname=current_database()) <> '${admission.databaseOid}'
     OR (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) THEN
    RAISE EXCEPTION 'historical89_database_identity';
  END IF;
  -- Authentic guardless 89. This history never had the retained phase custody,
  -- so the retained guard must be absent - not dropped, not adopted, and not
  -- installed today to satisfy the predecessor wrapper.
  IF to_regprocedure('public.${retainedGuardName}()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='${retainedGuardName}')
     OR pg_has_role('${managedOwner}','${schemaOwner}','USAGE')
     OR pg_has_role('${managedOwner}','${schemaOwner}','SET') THEN
    RAISE EXCEPTION 'historical89_unexpected_retained_custody';
  END IF;
END $historical_identity$;
-- Direct owner row lock on the closed gate. The custody-only lock routine is
-- deliberately not called as reviewrouter.
SELECT 1 FROM public."HostedCodexRuntimeGate" WHERE id='global' FOR SHARE;
DO $historical_baseline$ BEGIN
  IF (${ledgerQuery}) IS DISTINCT FROM ${jsonLiteral(ordered)}
     OR (${membershipQuery}) IS DISTINCT FROM ${jsonLiteral([originalMembership])}
     OR (${catalogQuery}) IS DISTINCT FROM ${jsonLiteral(baselineCatalog)}
     OR (${defaultAclQuery}) IS DISTINCT FROM ${jsonLiteral(defaultAcl)}
     OR (${renderManagedRuntimeGateSql}) IS DISTINCT FROM ${jsonLiteral(gate)} THEN
    RAISE EXCEPTION 'historical89_baseline_changed';
  END IF;
END $historical_baseline$;
${renderSchemaHandoffOwnerPreconditionSql}
${renderSchemaHandoffOwnershipTransferSql}
${renderSchemaHandoffBodiesSql("historical89-body").join("\n")}
${renderManagedMembershipCleanupSql}
${renderSchemaHandoffTerminalSql({ originalMembership, prefix: ordered })}
DO $interim$ BEGIN
  -- Transaction-local 92 boundary only. Nothing durable is written here and no
  -- 92 receipt exists; the next four bodies run in this same backend.
  IF to_regprocedure('public.${retainedGuardName}()') IS NOT NULL
     OR (${defaultAclQuery}) IS DISTINCT FROM ${jsonLiteral(defaultAcl)}
     OR (${renderManagedRuntimeGateSql}) IS DISTINCT FROM ${jsonLiteral(gate)} THEN
    RAISE EXCEPTION 'historical89_interim_boundary';
  END IF;
END $interim$;
-- historical89-interim92-verified (${phase.interimManifest})
${renderManagedWorkflowCutoverPreambleSql}
${renderManagedWorkflowCutoverBodiesSql("historical89-body", 3).join("\n")}
${renderManagedMembershipCleanupSql}
-- historical89-membership-cleanup-complete
${renderManagedWorkflowCutoverTerminalSql({ originalMembership, gate, prefix: ordered })}
DO $historical_terminal$ BEGIN
  -- The provider default ACLs are qualified as non-initializing; they are never
  -- removed or rewritten, so they must be byte-identical at the end.
  IF (${defaultAclQuery}) IS DISTINCT FROM ${jsonLiteral(defaultAcl)} THEN
    RAISE EXCEPTION 'historical89_provider_defaults_changed';
  END IF;
END $historical_terminal$;
-- The reviewed terminal catalog check, the operation-bound effect receipt and
-- COMMIT are the caller's, inside this same transaction. Schema success never
-- opens the runtime gate.
`;
  return Object.freeze({
    kind: phase.kind,
    operationId: admission.operationId,
    identityDigest,
    creators,
    durableEndpoints: Object.freeze([phase.baselineCount, phase.targetCount]),
    interimVerification: "transaction-local",
    reviewedTerminalOwners,
    markers: renderHistorical89InPlaceMarkers,
    sql,
    custodyEstablished: false,
    authorizesMutation: false,
    requiresQualifiedAdmission: true,
  });
}

// The reviewed terminal catalog comparison is identical to the 92->96 one and
// is reused rather than restated. It compares a complete catalog to a reviewed
// digest; equality is not approval by capture.
export const renderHistorical89InPlaceCatalogCheck =
  renderManagedWorkflowCutoverCatalogCheck;

/** The bounded object-ACL projection this operation's delta is computed from. */
export const renderHistorical89InPlaceObjectAclSql =
  renderHistorical89ObjectAclSql;

const aclRows = (observation, reason) => {
  if (observation?.version !== 1 || !Array.isArray(observation.rows))
    fail(reason);
  const rows = new Map();
  for (const row of observation.rows) {
    if (
      !row ||
      typeof row.oid !== "string" ||
      !/^[1-9][0-9]*$/u.test(row.oid) ||
      rows.has(row.oid) ||
      typeof row.identity !== "string" ||
      !row.identity ||
      typeof row.owner !== "string" ||
      !row.owner
    )
      fail(reason);
    rows.set(row.oid, row);
  }
  return rows;
};

/**
 * The exact owner and created-object ACL effects of the composed operation.
 *
 * Created objects are the OID delta and are checked by the 1A contract, using
 * the source-pinned reviewed terminal owner set. Surviving objects must keep
 * their owner except for the two reviewed transfers, and nothing that exists at
 * 89 may disappear.
 *
 * This is a comparison of two observations. It approves no particular grant set
 * and creates no custody.
 */
export function assertHistorical89InPlaceAclDelta({
  baseline,
  terminal,
  creators,
}) {
  const before = aclRows(baseline, "object_acl_baseline");
  const after = aclRows(terminal, "object_acl_terminal");
  const created = assertHistorical89CreatedObjectAcl({
    baseline,
    terminal,
    creators,
    owners: reviewedTerminalOwners,
  });
  const transfers = [];
  for (const [oid, row] of before) {
    const survivor = after.get(oid);
    // 000089 drops the intermediate 20-argument routine that 000087 creates,
    // but that routine does not exist at the 89 baseline: nothing observed here
    // may disappear.
    if (!survivor) fail("object_acl_removed");
    if (survivor.identity !== row.identity) fail("object_acl_renamed");
    if (survivor.owner !== row.owner)
      transfers.push({
        identity: row.identity,
        from: row.owner,
        to: survivor.owner,
      });
  }
  const key = (entry) => `${entry.identity} ${entry.from} ${entry.to}`;
  const expected = reviewedOwnerTransfers.map(key).sort();
  const observed = transfers.map(key).sort();
  if (
    observed.length !== expected.length ||
    observed.some((entry, index) => entry !== expected[index])
  )
    fail("object_acl_owner_transfer");
  return Object.freeze({ created, ownerTransfers: reviewedOwnerTransfers });
}

/**
 * Classify the SCHEMA/LEDGER outcome of an executed operation whose COMMIT
 * response was lost, whose backend died, or which is otherwise unresolved.
 *
 * This is deliberately narrow. It compares postconditions only. It is NOT
 * authority reconciliation: the operation-bound protected effect receipt, the
 * permit epoch/nonce and the durable external fence belong to the custody and
 * execution boundary that is not built here, so every outcome that would allow
 * continuation still carries `requiresOperationBoundReceipt: true`.
 *
 * Anything unproven, partial or conflicting returns `hold-closed`.
 */
export function classifyHistorical89InPlaceOutcome({
  admission,
  ledger,
  backendState,
  rollbackConfirmed,
  terminalCatalog,
  reviewedCatalogDigest,
  gate,
  memberships,
  originalMembership,
  aclDelta,
}) {
  try {
    assertHistorical89AdmissionIdentity(admission);
    if (backendState !== "terminated") fail("unresolved_backend");
    const observed = inspectHistorical89InPlaceLedger(ledger);
    assertRenderManagedClosedGate(gate);
    if (renderManagedEvidenceDigest(gate) !== admission.custodyDigest)
      fail("gate_changed");
    if (
      classifyRenderManagedMembership(memberships, originalMembership) !==
      "original"
    )
      fail("membership_changed");
    const retained = renderManagedEvidenceDigest(
      [...ledger]
        .sort((a, b) => (a.migrationName < b.migrationName ? -1 : 1))
        .slice(0, phase.baselineCount),
    );
    if (retained !== admission.originalLedgerDigest)
      fail("original_ledger_changed");
    if (observed.count === phase.baselineCount) {
      // A confirmed rollback to the exact original 89 permits continuation of
      // the SAME operation. It is not a success and not a replay permit.
      if (rollbackConfirmed !== true) fail("rollback_unconfirmed");
      assertRenderManagedCatalogMatches(
        terminalCatalog,
        admission.catalogDigest,
      );
      return Object.freeze({
        status: "uncommitted-candidate",
        replay: false,
        requiresSameAuthorityOperation: true,
        requiresOperationBoundReceipt: true,
      });
    }
    if (observed.count !== phase.targetCount) fail("partial_state");
    if (observed.manifest !== phase.targetManifest) fail("target_manifest");
    if (observed.pending.length !== 0) fail("pending_remains");
    assertRenderManagedCatalogMatches(terminalCatalog, reviewedCatalogDigest);
    if (
      !aclDelta ||
      !Array.isArray(aclDelta.created) ||
      aclDelta.created.length === 0 ||
      aclDelta.ownerTransfers !== reviewedOwnerTransfers
    )
      fail("acl_delta_missing");
    return Object.freeze({
      status: "committed-candidate",
      replay: false,
      requiresOperationBoundReceipt: true,
    });
  } catch {
    return Object.freeze({ status: "hold-closed", replay: false });
  }
}
