import { createHash } from "node:crypto";
import {
  canonicalReleaseMigrationEntries,
  type ReleaseMigrationEntry,
} from "./release-migration-transition";

/**
 * The typed in-place mode.
 *
 * The relocation transition moves a database generation: its domain, service,
 * transport and SQL layers all reject `source === target`, and they are right
 * to. This transition is a different operation on the SAME database, so it
 * needs the opposite invariant everywhere. Deleting the relocation equality
 * checks would not implement it - it would only remove a correct guard from a
 * flow that still has relocation semantics (copying, generation switching,
 * "resume source" compensation) that are unsafe after a schema commit.
 *
 * So the mode is an explicitly discriminated type. The discriminator is part of
 * the canonical digest, and every consumer selects on it: a relocation payload
 * cannot be reinterpreted as in-place by dropping a field, and an in-place
 * payload cannot pass a relocation check.
 */
export const ManagedInPlaceTransitionType =
  "managed-historical89-in-place/v1" as const;
export type ManagedInPlaceTransitionType = typeof ManagedInPlaceTransitionType;

/** The exact seven bodies this operation may apply, in application order. */
export const managedInPlacePendingMigrationNames = Object.freeze([
  "000087_codex_oauth_v4_v5_workflow_reattestation",
  "000088_codex_oauth_reattestation_mutation_owner_fence",
  "000089_codex_oauth_v4_v5_staged_compatibility",
  "000089_workflow_provisioning_writer_quiescence",
  "000090_workflow_provisioning_attempt_authority",
  "000091_workflow_provisioning_artifact_and_inventory",
  "000096_hosted_pool_public_repository_eligibility",
] as const);

// Resolved from the one canonical entry list rather than restated, so a
// checksum can only be changed in a single place.
export const managedInPlacePendingEntries: readonly ReleaseMigrationEntry[] =
  Object.freeze(
    managedInPlacePendingMigrationNames.map((migrationName) => {
      const entry = canonicalReleaseMigrationEntries.find(
        (candidate) => candidate.migrationName === migrationName,
      );
      if (!entry) throw new Error("managed_in_place_pending_entry_missing");
      return entry;
    }),
  );

/**
 * Baseline and terminal ledger manifests of this operation.
 *
 * These are the two durable endpoints. 92 is deliberately absent: it is
 * verified inside the same backend and transaction and never becomes a durable
 * checkpoint, so there is no manifest for it to bind.
 */
export const managedInPlaceBaselineManifest =
  "sha256:13acb121fbc5bbdebef197d58d5e8dcfca99815e005acc0aae7988bc86d33ef2";
export const managedInPlaceTargetManifest =
  "sha256:5faad7059a2f57055086dd1571e87706c261a486e8952334401f1d91cc41c97b";
export const managedInPlaceBaselineCount = 89;
export const managedInPlaceTargetCount = 96;

export type ManagedInPlaceTransitionV1 = Readonly<{
  transitionType: ManagedInPlaceTransitionType;
  schemaVersion: 1;
  commitSha: string;
  releaseImageDigest: string;
  providerDatabaseResourceId: string;
  orderedPendingEntries: readonly ReleaseMigrationEntry[];
  orderedPendingEntriesSha256: string;
  baselineManifestIdentity: string;
  targetManifestIdentity: string;
  baselineCount: 89;
  targetCount: 96;
  transitionSha256: string;
}>;

/**
 * Source and target of an in-place operation.
 *
 * Every field must be identical on both sides: this is one database observed
 * twice, not two databases that happen to agree. The relocation invariant is
 * inverted here on purpose, and both halves are checked so that a payload
 * carrying two genuinely different databases can never be admitted as in-place.
 */
export type ManagedInPlaceTopology = Readonly<{
  providerDatabaseResourceId: string;
  systemIdentifier: string;
  databaseOid: string;
  databaseName: string;
  recoveryWitnessSha256: string;
}>;

export type ManagedInPlaceOperationPermit = Readonly<{
  transitionType: ManagedInPlaceTransitionType;
  schemaVersion: 1;
  operationId: string;
  transitionSha256: string;
  admissionIdentityDigest: string;
  topology: ManagedInPlaceTopology;
  externalFenceSha256: string;
  terminalCatalogDigest: string;
  generation: number;
  epoch: number;
  nonce: string;
  state: "open" | "terminal";
}>;

export type ManagedInPlaceEffectReceipt = Readonly<{
  transitionType: ManagedInPlaceTransitionType;
  operationId: string;
  generation: number;
  epoch: number;
  nonce: string;
  ledgerManifest: string;
  terminalCatalogDigest: string;
  effectFingerprint: string;
  permitState: "terminal";
}>;

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const rawDigestPattern = /^[a-f0-9]{64}$/u;
const shaPattern = /^[a-f0-9]{40}$/u;
const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const noncePattern = /^[a-f0-9]{32}$/u;
const identifierPattern = /^[1-9][0-9]{0,19}$/u;
const providerResourcePattern = /^dpg-[a-z0-9]+-a$/u;
const databaseNamePattern = /^[a-z_][a-z0-9_]{0,62}$/u;

const canonicalJson = (value: unknown): string => {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const item = value as Record<string, unknown>;
  return `{${Object.keys(item)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(item[key])}`)
    .join(",")}}`;
};
const canonicalDigest = (value: unknown): string =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;

export const deriveManagedInPlacePendingEntriesSha256 = (
  entries: readonly ReleaseMigrationEntry[],
): string =>
  `sha256:${createHash("sha256")
    .update(
      entries
        .map((entry) => `${entry.migrationName}:${entry.migrationSqlSha256}`)
        .join(","),
    )
    .digest("hex")}`;

export function createManagedInPlaceTransition(input: {
  commitSha: string;
  releaseImageDigest: string;
  providerDatabaseResourceId: string;
}): ManagedInPlaceTransitionV1 {
  if (
    !shaPattern.test(input.commitSha) ||
    !digestPattern.test(input.releaseImageDigest) ||
    !providerResourcePattern.test(input.providerDatabaseResourceId)
  )
    throw new Error("managed_in_place_transition_release_identity_invalid");
  const unsigned = {
    transitionType: ManagedInPlaceTransitionType,
    schemaVersion: 1 as const,
    ...input,
    orderedPendingEntries: managedInPlacePendingEntries,
    orderedPendingEntriesSha256: deriveManagedInPlacePendingEntriesSha256(
      managedInPlacePendingEntries,
    ),
    baselineManifestIdentity: managedInPlaceBaselineManifest,
    targetManifestIdentity: managedInPlaceTargetManifest,
    baselineCount: managedInPlaceBaselineCount as 89,
    targetCount: managedInPlaceTargetCount as 96,
  };
  return Object.freeze({
    ...unsigned,
    transitionSha256: canonicalDigest(unsigned),
  });
}

/**
 * Transport integrity of an in-place transition. The discriminator is inside
 * the digest, so a relocation transition re-labelled as in-place - or an
 * in-place transition with its type removed - fails here rather than later.
 */
export function assertManagedInPlaceTransitionIntegrity(
  value: ManagedInPlaceTransitionV1,
): void {
  const unsigned = { ...value };
  Reflect.deleteProperty(unsigned, "transitionSha256");
  if (
    value.transitionType !== ManagedInPlaceTransitionType ||
    value.schemaVersion !== 1 ||
    !shaPattern.test(value.commitSha) ||
    !digestPattern.test(value.releaseImageDigest) ||
    !providerResourcePattern.test(value.providerDatabaseResourceId) ||
    value.baselineManifestIdentity !== managedInPlaceBaselineManifest ||
    value.targetManifestIdentity !== managedInPlaceTargetManifest ||
    value.baselineCount !== managedInPlaceBaselineCount ||
    value.targetCount !== managedInPlaceTargetCount ||
    value.orderedPendingEntries.length !==
      managedInPlacePendingMigrationNames.length ||
    value.orderedPendingEntries.some(
      (entry, index) =>
        entry.migrationName !== managedInPlacePendingMigrationNames[index] ||
        !rawDigestPattern.test(entry.migrationSqlSha256) ||
        entry.migrationSqlSha256 !==
          managedInPlacePendingEntries[index]!.migrationSqlSha256,
    ) ||
    value.orderedPendingEntriesSha256 !==
      deriveManagedInPlacePendingEntriesSha256(value.orderedPendingEntries) ||
    value.transitionSha256 !== canonicalDigest(unsigned)
  )
    throw new Error("managed_in_place_transition_untrusted");
}

export function assertManagedInPlaceTransition(
  value: ManagedInPlaceTransitionV1,
  trusted: ManagedInPlaceTransitionV1,
): void {
  assertManagedInPlaceTransitionIntegrity(value);
  if (canonicalJson(value) !== canonicalJson(trusted))
    throw new Error("managed_in_place_transition_untrusted");
}

/**
 * The in-place topology invariant: source and target are the same database in
 * every identity the relocation flow compares. This is the exact inverse of
 * `database_generations_not_distinct`, stated as its own rule so that both
 * remain enforced for their own mode.
 */
export function assertManagedInPlaceTopology(input: {
  source: ManagedInPlaceTopology;
  target: ManagedInPlaceTopology;
}): ManagedInPlaceTopology {
  const { source, target } = input;
  for (const side of [source, target]) {
    if (
      !side ||
      !providerResourcePattern.test(side.providerDatabaseResourceId) ||
      !identifierPattern.test(side.systemIdentifier) ||
      !identifierPattern.test(side.databaseOid) ||
      !databaseNamePattern.test(side.databaseName) ||
      !rawDigestPattern.test(side.recoveryWitnessSha256)
    )
      throw new Error("managed_in_place_topology_invalid");
  }
  if (canonicalJson(source) !== canonicalJson(target))
    throw new Error("managed_in_place_topology_not_identical");
  return Object.freeze({ ...source });
}

export function assertManagedInPlaceOperationPermit(
  permit: ManagedInPlaceOperationPermit,
  transition: ManagedInPlaceTransitionV1,
): void {
  assertManagedInPlaceTransitionIntegrity(transition);
  if (
    permit.transitionType !== ManagedInPlaceTransitionType ||
    permit.schemaVersion !== 1 ||
    !uuidPattern.test(permit.operationId) ||
    permit.transitionSha256 !== transition.transitionSha256 ||
    !digestPattern.test(permit.admissionIdentityDigest) ||
    !digestPattern.test(permit.externalFenceSha256) ||
    !digestPattern.test(permit.terminalCatalogDigest) ||
    !Number.isSafeInteger(permit.generation) ||
    permit.generation < 1 ||
    !Number.isSafeInteger(permit.epoch) ||
    permit.epoch < 1 ||
    !noncePattern.test(permit.nonce) ||
    (permit.state !== "open" && permit.state !== "terminal")
  )
    throw new Error("managed_in_place_permit_invalid");
  assertManagedInPlaceTopology({
    source: permit.topology,
    target: permit.topology,
  });
  if (
    permit.topology.providerDatabaseResourceId !==
    transition.providerDatabaseResourceId
  )
    throw new Error("managed_in_place_permit_database_mismatch");
}

/**
 * The successor of a permit after a compare-and-set. Only the epoch and the
 * nonce move; every identity, the generation and the terminal expectation are
 * carried through unchanged, so a "retry" can never quietly become a different
 * operation.
 */
export function advanceManagedInPlacePermit(
  permit: ManagedInPlaceOperationPermit,
  nextNonce: string,
): ManagedInPlaceOperationPermit {
  if (permit.state !== "open")
    throw new Error("managed_in_place_permit_terminal");
  if (!noncePattern.test(nextNonce) || nextNonce === permit.nonce)
    throw new Error("managed_in_place_permit_nonce_invalid");
  return Object.freeze({
    ...permit,
    epoch: permit.epoch + 1,
    nonce: nextNonce,
  });
}

export function assertManagedInPlaceEffectReceipt(
  receipt: ManagedInPlaceEffectReceipt,
  permit: ManagedInPlaceOperationPermit,
): void {
  if (
    receipt.transitionType !== ManagedInPlaceTransitionType ||
    receipt.operationId !== permit.operationId ||
    receipt.generation !== permit.generation ||
    receipt.epoch !== permit.epoch ||
    receipt.nonce !== permit.nonce ||
    receipt.ledgerManifest !== managedInPlaceTargetManifest ||
    receipt.terminalCatalogDigest !== permit.terminalCatalogDigest ||
    !digestPattern.test(receipt.effectFingerprint) ||
    receipt.permitState !== "terminal"
  )
    throw new Error("managed_in_place_effect_receipt_unbound");
}

export type ManagedInPlaceCommitObservation = Readonly<{
  originalBackendState: "terminated" | "alive" | "unknown";
  rollbackConfirmed: boolean;
  externalFenceHeld: boolean;
  ledgerManifest: string | null;
  gateStatus: string;
  receipt: ManagedInPlaceEffectReceipt | null;
}>;

export type ManagedInPlaceCommitDecision = Readonly<{
  decision: "reconciled-without-replay" | "resume-same-operation" | "fenced";
  replay: false;
  reasons: readonly string[];
}>;

/**
 * The domain form of the same three outcomes the SQL boundary enforces.
 *
 * An unknown commit is resolved in one fixed order: the ORIGINAL backend's
 * terminal state first, then the ledger, then the protected receipt. Anything
 * unresolved, partial or contradictory stays fenced, and no outcome ever
 * authorizes a replay.
 */
export function reconcileManagedInPlaceCommit(
  observation: ManagedInPlaceCommitObservation,
  permit: ManagedInPlaceOperationPermit,
): ManagedInPlaceCommitDecision {
  const reasons: string[] = [];
  if (!observation.externalFenceHeld) reasons.push("external_fence_not_held");
  if (observation.originalBackendState !== "terminated")
    reasons.push("original_backend_unresolved");
  if (observation.gateStatus !== "closed") reasons.push("gate_not_closed");
  if (reasons.length) return fenced(reasons);
  if (observation.ledgerManifest === managedInPlaceTargetManifest) {
    if (!observation.receipt) return fenced(["effect_receipt_absent"]);
    try {
      assertManagedInPlaceEffectReceipt(observation.receipt, permit);
    } catch {
      return fenced(["effect_receipt_unbound"]);
    }
    return Object.freeze({
      decision: "reconciled-without-replay" as const,
      replay: false as const,
      reasons: Object.freeze([]),
    });
  }
  if (observation.ledgerManifest !== managedInPlaceBaselineManifest)
    return fenced(["ledger_partial_or_unknown"]);
  if (!observation.rollbackConfirmed) return fenced(["rollback_unconfirmed"]);
  if (observation.receipt) return fenced(["receipt_without_committed_schema"]);
  if (permit.state !== "open") return fenced(["permit_terminal"]);
  return Object.freeze({
    decision: "resume-same-operation" as const,
    replay: false as const,
    reasons: Object.freeze([]),
  });
}

function fenced(reasons: readonly string[]): ManagedInPlaceCommitDecision {
  return Object.freeze({
    decision: "fenced" as const,
    replay: false as const,
    reasons: Object.freeze([...reasons]),
  });
}
