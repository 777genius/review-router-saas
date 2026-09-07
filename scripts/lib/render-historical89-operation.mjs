import {
  qualifyHistorical89Admission,
  renderHistorical89AdmissionPhase,
} from "./render-historical89-admission.mjs";
import {
  assertHistorical89InPlaceInputs,
  classifyHistorical89InPlaceOutcome,
  renderHistorical89InPlaceCatalogCheck,
  renderHistorical89InPlaceTransaction,
} from "./render-historical89-inplace-transaction.mjs";
import {
  assertManagedOperationCustodyBinding,
  assertManagedOperationEffectReceipt,
  renderManagedOperationCustodyBootstrap,
  renderManagedOperationCustodyVerifySql,
  renderManagedOperationEffectReadSql,
  renderManagedOperationOpenPermitSql,
  renderManagedOperationPermitAssertionSql,
  renderManagedOperationRecordEffectSql,
} from "./render-managed-operation-custody.mjs";
import {
  assertHistorical89ExecutionPreconditions,
  renderHistorical89AdmissionRestoreSql,
  renderHistorical89AdmissionRestrictionSql,
  renderHistorical89FleetQuiescenceGuardSql,
} from "./render-historical89-execution-boundary.mjs";

// ---------------------------------------------------------------------------
// The execution boundary: custody, admission and one atomic effect.
// ---------------------------------------------------------------------------
//
// Stage 1B produced an open transaction that reaches 96 and explicitly refuses
// to authorize anything. This module is what a qualified caller would actually
// run. It puts the four missing pieces in their only correct places:
//
//   1. custody is bootstrapped in the same qualified database, BEFORE the
//      baseline is captured, so the captured catalog already contains it;
//   2. admission is withdrawn and the fleet drained BEFORE the transaction;
//   3. custody attestation, the fleet guard and the CURRENT permit are
//      re-proved INSIDE the transaction, before any body runs;
//   4. the protected, operation-bound effect receipt is written INSIDE the
//      same transaction, after the reviewed terminal catalog check and before
//      COMMIT, by a routine that re-derives the postconditions itself.
//
// The plan this module returns is still not production authorization, and says
// so in a field rather than in a comment. `authorizesProductionMutation` is
// computed by actually attempting qualification, and today that attempt fails
// closed because no independently reviewed expectation registry exists. That is
// the same boundary stage 1A drew, reached from the execution side.

const phase = renderHistorical89AdmissionPhase;
const fail = (reason) => {
  throw new Error(`render_historical89_operation_rejected:${reason}`);
};
const shapeOf = (keys) => [...keys].sort().join();
const keysOf = (value) =>
  value &&
  typeof value === "object" &&
  Object.getPrototypeOf(value) === Object.prototype
    ? Object.keys(value).sort().join()
    : null;
const positive = (value) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
const nonceValue = (value) =>
  typeof value === "string" && /^[a-f0-9]{32}$/u.test(value);
const digest = (value) =>
  typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);

const coordinatesShape = shapeOf(["epoch", "nonce", "generation"]);

/**
 * The custody binding for one operation, derived only from its own qualified
 * admission identity. Exported because a disposable rehearsal has to bootstrap
 * this custody BEFORE it can observe the terminal catalog of a database that
 * already carries it.
 */
export function historical89InPlaceCustodyBinding(admission) {
  return assertManagedOperationCustodyBinding({
    operationId: admission.operationId,
    systemIdentifier: admission.systemIdentifier,
    databaseOid: admission.databaseOid,
    databaseName: admission.databaseName,
    recoveryIdentitySha256: admission.recoveryIdentitySha256,
    externalFenceSha256: admission.externalFenceSha256,
  });
}

/**
 * Everything that must be re-proved inside the transaction before any body
 * runs. With `coordinates` omitted it is the rehearsal form: the fleet guard
 * and the custody attestation, without the permit that does not exist yet.
 * Neither form changes any catalog, so a rehearsal observes the same terminal
 * catalog the real run produces.
 */
export function renderHistorical89InPlacePreflightSql(binding, coordinates) {
  const fragments = [
    renderHistorical89FleetQuiescenceGuardSql,
    renderManagedOperationCustodyVerifySql(binding),
  ];
  if (coordinates !== undefined)
    fragments.push(
      renderManagedOperationPermitAssertionSql(binding, coordinates),
    );
  return fragments.join("\n");
}

/**
 * Decide whether this plan may mutate production, by attempting the real
 * qualification instead of asserting a verdict.
 *
 * Today this always returns false and names why. Bootstrapped custody is a
 * boundary, not an approval: `reviewrouter` created it and can still administer
 * it, and owner access has never been independent approval evidence here. The
 * approval root stays the reviewed expectation registry in source, which is
 * empty in this checkout.
 */
export function authorizeHistorical89InPlaceOperation({
  admission,
  defaultAcl,
  creatorEvidence,
  terminalCatalogProvenance,
}) {
  const blockedBy = [];
  try {
    qualifyHistorical89Admission({ admission, defaultAcl, creatorEvidence });
  } catch (error) {
    const reason = String(error?.message ?? "unknown")
      .split(":")
      .pop();
    blockedBy.push(`admission_qualification:${reason}`);
  }
  if (terminalCatalogProvenance !== "reviewed-registry")
    blockedBy.push(
      `terminal_catalog_provenance:${String(terminalCatalogProvenance)}`,
    );
  // Custody bootstrapped by the database owner binds and fences one operation.
  // It does not turn owner access into an independent approval.
  blockedBy.push("operation_custody:owner_bootstrapped_not_independent");
  return Object.freeze({
    kind: phase.kind,
    authorizesProductionMutation: false,
    blockedBy: Object.freeze([...new Set(blockedBy)].sort()),
  });
}

const planShape = shapeOf([
  "admission",
  "ledger",
  "originalMembership",
  "baselineCatalog",
  "defaultAcl",
  "creatorEvidence",
  "gate",
  "connectAcl",
  "preconditions",
  "coordinates",
  "reviewedTerminalCatalog",
  "reviewedTerminalCatalogDigest",
  "terminalCatalogProvenance",
]);

/**
 * Build the complete execution plan for one in-place operation.
 *
 * The returned record contains, in the order an operator runs them: the custody
 * bootstrap, the admission withdrawal and drain, the single closed transaction
 * (which now ends in COMMIT), the restricted receipt read, and the admission
 * restore. It renders SQL; it opens no connection and executes nothing.
 */
export function planHistorical89InPlaceOperation(input) {
  if (keysOf(input) !== planShape) fail("plan_shape");
  const {
    admission,
    ledger,
    originalMembership,
    baselineCatalog,
    defaultAcl,
    creatorEvidence,
    gate,
    connectAcl,
    preconditions,
    coordinates,
    reviewedTerminalCatalog,
    reviewedTerminalCatalogDigest,
    terminalCatalogProvenance,
  } = input;
  if (keysOf(coordinates) !== coordinatesShape) fail("coordinates_shape");
  if (
    !positive(coordinates.epoch) ||
    !positive(coordinates.generation) ||
    !nonceValue(coordinates.nonce)
  )
    fail("coordinates_invalid");
  if (!digest(reviewedTerminalCatalogDigest)) fail("terminal_catalog_digest");
  if (
    terminalCatalogProvenance !== "reviewed-registry" &&
    terminalCatalogProvenance !== "disposable-rehearsal"
  )
    fail("terminal_catalog_provenance");
  // Validate every 1B input first, so a bad baseline never reaches custody.
  const inputs = assertHistorical89InPlaceInputs({
    admission,
    ledger,
    originalMembership,
    baselineCatalog,
    defaultAcl,
    creatorEvidence,
    gate,
  });
  const boundary = assertHistorical89ExecutionPreconditions(preconditions);
  if (boundary.externalFenceSha256 !== admission.externalFenceSha256)
    fail("fence_binding");
  if (boundary.recoveryIdentitySha256 !== admission.recoveryIdentitySha256)
    fail("recovery_binding");
  const binding = historical89InPlaceCustodyBinding(admission);
  const custody = renderManagedOperationCustodyBootstrap(binding);
  const permitCoordinates = Object.freeze({
    ...coordinates,
    terminalCatalogDigest: reviewedTerminalCatalogDigest,
    admissionIdentityDigest: inputs.identityDigest,
  });
  const preflightSql = renderHistorical89InPlacePreflightSql(
    binding,
    permitCoordinates,
  );
  const built = renderHistorical89InPlaceTransaction({
    admission,
    ledger,
    originalMembership,
    baselineCatalog,
    defaultAcl,
    creatorEvidence,
    gate,
    preflightSql,
  });
  const transactionSql = [
    built.sql,
    renderHistorical89InPlaceCatalogCheck(
      reviewedTerminalCatalog,
      reviewedTerminalCatalogDigest,
    ),
    renderManagedOperationRecordEffectSql(binding, permitCoordinates),
    "COMMIT;",
  ].join("\n");
  return Object.freeze({
    kind: phase.kind,
    operationId: admission.operationId,
    identityDigest: inputs.identityDigest,
    // The exact admission this plan was built from. Reconciliation must compare
    // against the same qualified identity, never a freshly assembled one.
    admission: Object.freeze({ ...admission }),
    binding,
    coordinates: permitCoordinates,
    reviewedTerminalCatalogDigest,
    boundary,
    custody,
    openPermitSql: renderManagedOperationOpenPermitSql(binding, {
      generation: coordinates.generation,
      nonce: coordinates.nonce,
      terminalCatalogDigest: reviewedTerminalCatalogDigest,
      admissionIdentityDigest: inputs.identityDigest,
    }),
    admissionRestrictionSql:
      renderHistorical89AdmissionRestrictionSql(connectAcl),
    admissionRestoreSql: renderHistorical89AdmissionRestoreSql(connectAcl),
    transactionSql,
    effectReadSql: renderManagedOperationEffectReadSql(binding),
    markers: built.markers,
    creators: built.creators,
    durableEndpoints: built.durableEndpoints,
    authorization: authorizeHistorical89InPlaceOperation({
      admission,
      defaultAcl,
      creatorEvidence,
      terminalCatalogProvenance,
    }),
  });
}

const reconcileShape = shapeOf([
  "plan",
  "backendState",
  "rollbackConfirmed",
  "ledger",
  "terminalCatalog",
  "gate",
  "memberships",
  "originalMembership",
  "aclDelta",
  "receipt",
  "fenceHeld",
]);

/**
 * Reconcile an operation whose COMMIT response was lost, whose backend died, or
 * which is otherwise unresolved.
 *
 * The order is fixed and not negotiable: the ORIGINAL backend's terminal state
 * is established first (an alive or unknown backend can still be executing, so
 * nothing else is even read), then the schema and ledger postconditions, then
 * the protected operation-bound receipt read through the restricted role.
 *
 * Only three outcomes exist:
 *
 *   reconciled-without-replay - exact 96, an authentic receipt bound to THIS
 *     operation, epoch, nonce and generation, a terminal permit and complete
 *     postconditions. Nothing is re-applied; the gate stays closed.
 *   resume-same-operation - a confirmed rollback to the exact original 89, no
 *     receipt and a still-open permit. The SAME operation may continue after a
 *     compare-and-set to a new epoch. This is not a replay permit.
 *   fenced - anything else, including a missing fence, a partial state, a
 *     committed schema without a receipt, a receipt without the schema, and any
 *     receipt that fails its own fingerprint or binding.
 */
export function reconcileHistorical89InPlaceOperation(input) {
  if (keysOf(input) !== reconcileShape)
    return fenced(["reconciliation_input_shape"]);
  const {
    plan,
    backendState,
    rollbackConfirmed,
    ledger,
    terminalCatalog,
    gate,
    memberships,
    originalMembership,
    aclDelta,
    receipt,
    fenceHeld,
  } = input;
  const reasons = [];
  // Validated before any branch is chosen: `resume-same-operation` never
  // touches coordinates/reviewedTerminalCatalogDigest/identityDigest below,
  // but they still describe the operation this reconciliation is bound to,
  // so a malformed plan must fail here regardless of which outcome the
  // schema/ledger observations would otherwise classify it as.
  if (
    !plan ||
    plan.kind !== phase.kind ||
    keysOf(plan.binding) === null ||
    // `plan.coordinates` carries two extra fields beyond the bare
    // epoch/generation/nonce triple (see `permitCoordinates` above), so this
    // checks the fields reconciliation actually reads rather than an exact
    // key set that would drift out of sync with that shape.
    keysOf(plan.coordinates) === null ||
    !positive(plan.coordinates.epoch) ||
    !positive(plan.coordinates.generation) ||
    !nonceValue(plan.coordinates.nonce) ||
    !digest(plan.reviewedTerminalCatalogDigest) ||
    !digest(plan.identityDigest)
  )
    return fenced(["plan_untrusted"]);
  // A fence that is not still held makes every other observation unusable: the
  // database could have been reopened to writers between the two reads.
  if (fenceHeld !== true) reasons.push("external_fence_not_held");
  if (backendState !== "terminated")
    reasons.push("original_backend_unresolved");
  if (reasons.length) return fenced(reasons);
  const outcome = classifyHistorical89InPlaceOutcome({
    admission: plan.admission,
    ledger,
    backendState,
    rollbackConfirmed,
    terminalCatalog,
    reviewedCatalogDigest: plan.reviewedTerminalCatalogDigest,
    gate,
    memberships,
    originalMembership,
    aclDelta,
  });
  if (outcome.status === "hold-closed") return fenced(["schema_outcome_held"]);
  if (outcome.status === "committed-candidate") {
    let verified;
    try {
      verified = assertManagedOperationEffectReceipt(receipt, {
        binding: plan.binding,
        epoch: plan.coordinates.epoch,
        nonce: plan.coordinates.nonce,
        generation: plan.coordinates.generation,
        terminalCatalogDigest: plan.reviewedTerminalCatalogDigest,
        admissionIdentityDigest: plan.identityDigest,
      });
    } catch (error) {
      return fenced([
        `effect_receipt:${String(error?.message ?? "unknown")
          .split(":")
          .pop()}`,
      ]);
    }
    return Object.freeze({
      decision: "reconciled-without-replay",
      replay: false,
      continueOperation: false,
      requiresSameAuthorityOperation: true,
      gate: "closed",
      effectFingerprint: verified.effectFingerprint,
      reasons: Object.freeze([]),
    });
  }
  // uncommitted-candidate: a confirmed rollback to the exact original 89.
  if (receipt !== null) return fenced(["receipt_without_committed_schema"]);
  return Object.freeze({
    decision: "resume-same-operation",
    replay: false,
    continueOperation: true,
    requiresSameAuthorityOperation: true,
    requiresPermitEpochAdvance: true,
    gate: "closed",
    reasons: Object.freeze([]),
  });
}

function fenced(reasons) {
  return Object.freeze({
    decision: "fenced",
    replay: false,
    continueOperation: false,
    requiresSameAuthorityOperation: true,
    gate: "closed",
    reasons: Object.freeze([...reasons]),
  });
}
