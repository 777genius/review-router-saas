import { createHash } from "node:crypto";

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
    "000072_runtime_canary_challenge",
    "48ac05b9da6031456de6b7bab2bc9ee46dc3b7bc5cb7ef45c7a5db1ee3956b68",
  ],
] as const).map(([name, checksum]) =>
  Object.freeze({ migrationName: name, migrationSqlSha256: checksum }),
);

export const canonicalReleaseMigrationArtifact = Object.freeze({
  migrationArtifactDigest:
    "sha256:7f14f768f030bc5d08f6f1452a8f5e60ab75b82e443a908e9b0889d630486c87",
  preManifestIdentity:
    "sha256:dac2d257a6b60be214b96b0a809df0ee18cc7615ffae21520802fe568debf554",
  orderedPendingEntriesSha256:
    "sha256:b8bf82755df9f75fbb2d5cf4c310b84284b5df23ad7fc24cb2136554dd1f0ee9",
  migrationBundleSha256:
    "sha256:1633e85d2e13fe4e0758189d82c2f723c0ea6f67cb669971009f679015a8039a",
  postManifestIdentity:
    "sha256:553576dcf644278cdc464d3465e34e0814862cd44c76784d89bb61c65f04b303",
  // Captured digest of the canonical live V70-V72 catalog projection.
  postCatalogDigest:
    "sha256:05820ed393b7364c468b62cb19e5cd4c8aaa729021155a18162f1a4b2012a44d",
});

export const canonicalReleaseMigrationResumeManifestIdentities = Object.freeze([
  canonicalReleaseMigrationArtifact.preManifestIdentity,
  "sha256:6bae1e93f51b024faaf56d606ede32633dd7de33a9f198369492515d0cef9bc8",
  "sha256:7f94f8695f7e18f9e2327a01e243dc1568207b4b1d10636b9b6ed4aae95ff923",
  "sha256:0410f762db05d37fdc12aa5b6f55b206cf87e308b1be750bd28b8f9fed4b690a",
  "sha256:8f7594478433a77dc3a1a3e662613cabf4cc8827a4b301637bca466cc344ab70",
  "sha256:a1ab0431a32b2b469802f9f0f98d246e9d2d8a80e92e001d3d326251ca2caa5c",
  "sha256:685f48a03a8120673bcf129b8e698d425d7df92e0d5422a4fcc2868fde3a2533",
  "sha256:47ba129fb453a5d97603cbc78af6cce94bd6b4a4ae9c6f7ba362db7e0dca3f2b",
  "sha256:4b09dd9c7edc993c299054c6b63e02facbcea61c581f9e4a26a2a400725c266f",
  "sha256:741f4dffd0a5e66c3507d524fe00586fd070543e19c4b547db17eb3902e16c66",
  "sha256:122b0c7d62cdef78750d8e4cbeeed0e86e06af5b4558965257cefb711b051440",
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
  const { transitionSha256: _transitionSha256, ...unsigned } = value;
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
      permit.targetRecoveryWitnessSha256
  )
    throw new Error("release_migration_observation_binding_invalid");
}
