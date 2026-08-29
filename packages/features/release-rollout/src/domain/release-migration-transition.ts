import { createHash } from "node:crypto";
import type { LegacyAmbiguityEvidence } from "./trusted-rollout-evidence";

export const TargetManifestPhase = Object.freeze({
  PreMigration: "pre_migration",
  Migrating: "migrating",
  PostMigration: "post_migration",
  Quarantined: "quarantined",
} as const);

export type TargetManifestPhase =
  (typeof TargetManifestPhase)[keyof typeof TargetManifestPhase];

export type ReleaseMigrationEntry = Readonly<{
  migrationName: string;
  migrationSqlSha256: string;
}>;

export type ReleaseMigrationTransitionV1 = Readonly<{
  schemaVersion: 1;
  commitSha: string;
  releaseImageDigest: string;
  migrationArtifactDigest: string;
  orderedMigrationEntries: readonly ReleaseMigrationEntry[];
  preManifestIdentity: string;
  orderedPendingEntriesSha256: string;
  migrationBundleSha256: string;
  allowedResumeManifestIdentities: readonly string[];
  postManifestIdentity: string;
  postCatalogDigest: string;
  transitionSha256: string;
}>;

export type ReleaseMigrationPermit = Readonly<{
  schemaVersion: 1;
  rolloutId: string;
  runId: string;
  runAttempt: number;
  targetSystemIdentifier: string;
  targetRecoveryWitnessSha256: string;
  transitionSha256: string;
  expectedPreviousReceiptSha256: string;
  sourceLegacyAmbiguity: LegacyAmbiguityEvidence;
  eligibilityCutoff: string;
  epoch: number;
  nonce: string;
}>;

export type ReleaseMigrationObservation = Readonly<{
  transitionSha256: string;
  migrationArtifactDigest: string;
  migrationBundleSha256: string;
  preManifestIdentity: string;
  postManifestIdentity: string;
  postCatalogDigest: string;
  permitEpoch: number;
  permitNonce: string;
  targetSystemIdentifier: string;
  targetRecoveryWitnessSha256: string;
  sourceLegacyAmbiguitySha256: string;
  eligibilityCutoff: string;
}>;

const digest = /^sha256:[a-f0-9]{64}$/u;
const rawDigest = /^[a-f0-9]{64}$/u;
const migrationName = /^\d{6}_[a-z0-9_]+$/u;

const canonicalJson = (value: unknown): string => {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
};

const canonicalDigest = (value: unknown): string =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;

export const canonicalReleaseMigrationEntries = Object.freeze([
  [
    "000060_codex_oauth_setup_serialization",
    "f24ab69f681349332e47e121adc72bd3edb14e24bcbffcd26fce4f03ba0d7395",
  ],
  [
    "000061_codex_oauth_provider_mutation_fence",
    "bba689c8b80580ec649cc3262fb2ee9c97be758f3c4ab7094c48c84d002aeb30",
  ],
  [
    "000062_codex_oauth_remote_outcome_unknown",
    "0e8bb62933a270d745530f2c4984520e1753f42d8531c24ffdfa4acfe46a73f4",
  ],
  [
    "000063_codex_oauth_setup_payload_claim",
    "33100d6f5f3f59cd9a4c22f041d19caba6a0e0be88de4a0ee4d543af50619481",
  ],
  [
    "000064_codex_oauth_versioned_secret_namespaces",
    "4da4352108efd684a8bc6ddefa19353181a8a74758c32ed890527c2aec2ae666",
  ],
  [
    "000065_codex_oauth_authority_acl_hardening",
    "ca8d554dd71cbdeaf0a66e007aa7ef391627c0a9d97b10a27e1113308087342c",
  ],
  [
    "000066_codex_oauth_rotating_cascade_authority",
    "3b9b6385fde3120793aff052ba00c1afbd09011585d73a8184d0e73de8934af8",
  ],
  [
    "000069_release_rollout_ledger",
    "82356ad61a366e22a15f4e53dabf8c97e14bad97c5970ef28710fe9367c06a05",
  ],
  [
    "000070_runtime_generation_witness_proof",
    "cb9c42171f9bd924d21093852a1053cb947100acef1321ec8cf62e8fd5928c6f",
  ],
  [
    "000071_transactional_service_transition",
    "36ecd5c6b880bd9cd4ad76a20fdd9e4ceafcc3e524e924eb3c7b0c78116da093",
  ],
  [
    "000072_retire_superseded_codex_setup_claims",
    "a0105a5498bacf23ec59687f6b43c70cecc075665231c37d970edcf8c0855fb3",
  ],
  [
    "000072_runtime_canary_challenge",
    "48ac05b9da6031456de6b7bab2bc9ee46dc3b7bc5cb7ef45c7a5db1ee3956b68",
  ],
  [
    "000073_codex_oauth_active_namespace_refresh",
    "3e5b6606f22c8bec6f75f52f48b693806d597fa283155f6e033844c4f6be4de6",
  ],
  [
    "000079_codex_oauth_v4_v5_workflow_reattestation",
    "88816a26cf0d6f10aaf3457c251e7546f1b09f85cd3681ad337f696dd4999346",
  ],
] as const).map(([name, checksum]) =>
  Object.freeze({ migrationName: name, migrationSqlSha256: checksum }),
);

export const canonicalReleaseMigrationArtifact = Object.freeze({
  migrationArtifactDigest:
    "sha256:bf0d6a2a039882f09830a30e7c03fca67446519d8194476fb252a41691062aa7",
  preManifestIdentity:
    "sha256:bb102d7d6013f7373f177ea5f266a5427a877fc54b95af8876d30ec2b17ab478",
  orderedPendingEntriesSha256:
    "sha256:ebf1761377d856f81920a4eaf213bec71440e8cf7a39ca0d3782fd5c5ed2a6d2",
  migrationBundleSha256:
    "sha256:1acc12d031362e7965ce24d4ddbfbefc2fd461f22064e1abfaf648ec3e29d59e",
  postManifestIdentity:
    "sha256:3d3fca74e22efefda962cc05f6cb7b6197b3b8bede351fb0a564c5d55efe495e",
  // Disposable PG17 candidate for the canonical V70-V79 catalog projection.
  // Production promotion remains gated on independent capture review.
  postCatalogDigest:
    "sha256:e71e1fc196604551532c2a5f7fb6903ad0ea0838d8fa2f41e99f8a4791610c68",
});

export const canonicalReleaseMigrationResumeManifestIdentities = Object.freeze([
  canonicalReleaseMigrationArtifact.preManifestIdentity,
  canonicalReleaseMigrationArtifact.postManifestIdentity,
]);

export function createReleaseMigrationTransition(input: {
  commitSha: string;
  releaseImageDigest: string;
}): ReleaseMigrationTransitionV1 {
  if (
    !/^[a-f0-9]{40}$/u.test(input.commitSha) ||
    !digest.test(input.releaseImageDigest)
  )
    throw new Error("release_migration_transition_release_identity_invalid");
  const unsigned = {
    schemaVersion: 1 as const,
    ...input,
    ...canonicalReleaseMigrationArtifact,
    orderedMigrationEntries: canonicalReleaseMigrationEntries,
    allowedResumeManifestIdentities:
      canonicalReleaseMigrationResumeManifestIdentities,
  };
  return Object.freeze({
    ...unsigned,
    transitionSha256: canonicalDigest(unsigned),
  });
}

export function assertReleaseMigrationTransition(
  value: ReleaseMigrationTransitionV1,
  trusted: ReleaseMigrationTransitionV1,
): void {
  assertReleaseMigrationTransitionIntegrity(value);
  if (canonicalJson(value) !== canonicalJson(trusted))
    throw new Error("release_migration_transition_untrusted");
}

/** Provider-neutral transport integrity; trust in a concrete bundle is injected by application policy. */
export function assertReleaseMigrationTransitionIntegrity(
  value: ReleaseMigrationTransitionV1,
): void {
  const unsigned = { ...value };
  Reflect.deleteProperty(unsigned, "transitionSha256");
  if (
    value.schemaVersion !== 1 ||
    !/^[a-f0-9]{40}$/u.test(value.commitSha) ||
    !digest.test(value.releaseImageDigest) ||
    value.transitionSha256 !== canonicalDigest(unsigned)
  )
    throw new Error("release_migration_transition_untrusted");
  for (const entry of value.orderedMigrationEntries)
    if (
      !migrationName.test(entry.migrationName) ||
      !rawDigest.test(entry.migrationSqlSha256)
    )
      throw new Error("release_migration_transition_entry_invalid");
}

export function assertReleaseMigrationObservation(
  observation: ReleaseMigrationObservation,
  transition: ReleaseMigrationTransitionV1,
  permit: ReleaseMigrationPermit,
): void {
  if (
    observation.transitionSha256 !== transition.transitionSha256 ||
    observation.migrationArtifactDigest !==
      transition.migrationArtifactDigest ||
    observation.migrationBundleSha256 !== transition.migrationBundleSha256 ||
    observation.preManifestIdentity !== transition.preManifestIdentity ||
    observation.postManifestIdentity !== transition.postManifestIdentity ||
    observation.postCatalogDigest !== transition.postCatalogDigest ||
    observation.permitEpoch !== permit.epoch ||
    observation.permitNonce !== permit.nonce ||
    observation.targetSystemIdentifier !== permit.targetSystemIdentifier ||
    observation.targetRecoveryWitnessSha256 !==
      permit.targetRecoveryWitnessSha256 ||
    observation.sourceLegacyAmbiguitySha256 !==
      permit.sourceLegacyAmbiguity.inventorySha256 ||
    observation.eligibilityCutoff !== permit.eligibilityCutoff
  )
    throw new Error("release_migration_observation_binding_invalid");
}
