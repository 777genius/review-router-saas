import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertReleaseMigrationTransition,
  assertReleaseMigrationObservation,
  canonicalReleaseMigrationArtifact,
  canonicalReleaseMigrationEntries,
  canonicalReleaseMigrationResumeManifestIdentities,
  createReleaseMigrationTransition,
  deriveOrderedPendingEntriesSha256,
} from "./release-migration-transition";
import { canonicalReleaseMigrationPostManifestIdentity } from "./release-migration-artifact-identity.js";
import {
  fencedLiveV70V73CatalogDigestSql,
  liveV70V79CatalogProjectionRelations,
  liveV70V79CatalogProjectionRoutines,
} from "../adapters/live-v70-v72-catalog-digest.mjs";

const migrationRoot = "packages/platform/db/prisma/migrations";
const sha256 = (value: string | Buffer) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const item = value as Record<string, unknown>;
  return `{${Object.keys(item)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(item[key])}`)
    .join(",")}}`;
};

describe("canonical release migration transition", () => {
  it("is generated from the exact checked-in migration SQL bytes", () => {
    const entries = canonicalReleaseMigrationEntries.map((entry) => {
      const bytes = readFileSync(
        `${migrationRoot}/${entry.migrationName}/migration.sql`,
      );
      expect(sha256(bytes)).toBe(`sha256:${entry.migrationSqlSha256}`);
      return entry;
    });
    expect(sha256(canonicalJson(entries))).toBe(
      canonicalReleaseMigrationArtifact.migrationArtifactDigest,
    );
    const framed = canonicalReleaseMigrationEntries.map((entry) => {
      const bytes = readFileSync(
        `${migrationRoot}/${entry.migrationName}/migration.sql`,
      );
      return Buffer.concat([
        Buffer.from(`${entry.migrationName}\0${bytes.length}\0`),
        bytes,
      ]);
    });
    expect(sha256(Buffer.concat(framed))).toBe(
      canonicalReleaseMigrationArtifact.migrationBundleSha256,
    );
  });

  it("accepts only the trusted pre-manifest and completed post-manifest replay", () => {
    const pending = new Set<string>(
      canonicalReleaseMigrationEntries.map((entry) => entry.migrationName),
    );
    const installed = readdirSync(migrationRoot)
      .filter((name) => /^\d{6}_[a-z0-9_]+$/u.test(name))
      .filter((name) => !pending.has(name))
      .map(
        (name) =>
          [
            name,
            createHash("sha256")
              .update(readFileSync(`${migrationRoot}/${name}/migration.sql`))
              .digest("hex"),
          ] as const,
      );
    const root = () =>
      sha256(
        [...installed]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, checksum]) => `${name}:${checksum}`)
          .join(","),
      );
    const roots = [root()];
    for (const entry of canonicalReleaseMigrationEntries) {
      installed.push([entry.migrationName, entry.migrationSqlSha256]);
      roots.push(root());
    }
    expect(canonicalReleaseMigrationResumeManifestIdentities).toEqual([
      roots[0],
      roots.at(-1),
    ]);
    expect(roots.slice(1, -1)).not.toContain(
      canonicalReleaseMigrationResumeManifestIdentities[0],
    );
  });

  it("rejects any worker alteration of a server-trusted transition", () => {
    const trusted = createReleaseMigrationTransition({
      commitSha: "d".repeat(40),
      releaseImageDigest: `sha256:${"e".repeat(64)}`,
    });
    expect(() =>
      assertReleaseMigrationTransition(trusted, trusted),
    ).not.toThrow();
    expect(() =>
      assertReleaseMigrationTransition(
        { ...trusted, postManifestIdentity: `sha256:${"f".repeat(64)}` },
        trusted,
      ),
    ).toThrow("release_migration_transition_untrusted");
  });

  it("derives the ordered-pending digest and rejects an independently supplied value", () => {
    const trusted = createReleaseMigrationTransition({
      commitSha: "d".repeat(40),
      releaseImageDigest: `sha256:${"e".repeat(64)}`,
    });
    expect(trusted.orderedPendingEntriesSha256).toBe(
      "sha256:5bcb52cccf2a85533c73e55eb86ecf2bbb9396a15f084e2f1776af237a10df45",
    );
    expect(trusted.orderedPendingEntriesSha256).toBe(
      deriveOrderedPendingEntriesSha256(trusted.orderedMigrationEntries),
    );
    expect(trusted.orderedPendingEntriesSha256).not.toBe(
      trusted.migrationArtifactDigest,
    );
    expect(
      deriveOrderedPendingEntriesSha256(
        [...trusted.orderedMigrationEntries].reverse(),
      ),
    ).not.toBe(trusted.orderedPendingEntriesSha256);
    expect(() =>
      assertReleaseMigrationTransition(
        {
          ...trusted,
          orderedPendingEntriesSha256: `sha256:${"f".repeat(64)}`,
        },
        trusted,
      ),
    ).toThrow("release_migration_transition_untrusted");
  });

  it("trusts only the last promoted production catalog digest", () => {
    expect(canonicalReleaseMigrationArtifact.postCatalogDigest).toBe(
      "sha256:039bb3284d3e664958e40a3a319157ee04030240082c0e1e832dcf8d64b014f0",
    );
    expect(canonicalReleaseMigrationArtifact.postCatalogDigest).not.toBe(
      "sha256:e71e1fc196604551532c2a5f7fb6903ad0ea0838d8fa2f41e99f8a4791610c68",
    );
  });

  it("binds the live history projection to the canonical post-manifest identity", () => {
    expect(canonicalReleaseMigrationArtifact.postManifestIdentity).toBe(
      canonicalReleaseMigrationPostManifestIdentity,
    );
    expect(fencedLiveV70V73CatalogDigestSql).toContain(
      `= '${canonicalReleaseMigrationArtifact.postManifestIdentity}'`,
    );
    expect(fencedLiveV70V73CatalogDigestSql).not.toContain(
      "sha256:28941cb847006d45d798db0a363f3ba8a63454b4255e95632b69e4767769eb8e",
    );
  });

  it("projects every V79 reattestation authority, consumer, ACL, and replay guard", () => {
    expect(liveV70V79CatalogProjectionRelations).toEqual([
      "CodexOAuthWritebackIntent",
      "CodexOAuthSecretNamespace",
      "CodexOAuthProviderInstance",
      "RepositoryConnection",
      "CodexOAuthSetupDispatchAttempt",
      "CodexOAuthSetupPayloadClaim",
      "CodexOAuthDatabaseAuthorityReceipt",
      "CodexOAuthWorkflowCompatibility",
      "RuntimeGenerationWitnessProof",
      "RuntimeCanaryChallenge",
      "RuntimeCanaryChallengeProof",
    ]);
    expect(liveV70V79CatalogProjectionRoutines).toEqual([
      "reviewrouter_record_runtime_generation_witness_proof",
      "reviewrouter_read_runtime_generation_witness_proofs",
      "reviewrouter_runtime_generation_write_read_canary",
      "reviewrouter_request_runtime_canary_challenge",
      "reviewrouter_answer_runtime_canary_challenge",
      "reviewrouter_read_runtime_canary_challenge_proofs",
      "codex_oauth_v4_v5_reattestation_transition",
      "codex_oauth_reattest_active_namespace_v4_to_v5",
      "codex_oauth_secret_namespace_tombstone_guard",
      "codex_oauth_consume_database_authority",
      "codex_oauth_database_authority_receipt_guard",
      "codex_oauth_workflow_compatibility_guard",
    ]);
    expect(fencedLiveV70V73CatalogDigestSql).toContain("'acl',coalesce");
    expect(fencedLiveV70V73CatalogDigestSql).toContain("'triggers',coalesce");
    expect(canonicalReleaseMigrationArtifact.postCatalogDigest).toBe(
      "sha256:039bb3284d3e664958e40a3a319157ee04030240082c0e1e832dcf8d64b014f0",
    );
  });

  it("binds the target observation to the source inventory and fixed cutoff", () => {
    const transition = createReleaseMigrationTransition({
      commitSha: "d".repeat(40),
      releaseImageDigest: `sha256:${"e".repeat(64)}`,
    });
    const inventorySha256 =
      "sha256:ee9ab3e1f9d9f0e88e96addb3a20b70a04a166f0d979fd5ce3fc59e1dcdbf55f";
    const sourceLegacyAmbiguityUnsigned = {
      schemaVersion: 1 as const,
      rolloutId: "rollout-binding",
      sourceSystemIdentifier: "1",
      sourceDatabaseName: "reviewrouter",
      sourceRecoveryWitnessSha256: "b".repeat(64),
      authorityPrincipal: "source_admin",
      fenceId: "source-fence:rollout-binding",
      fenceEstablishedAt: "2026-08-15T00:00:00.000Z",
      fencedInventorySha256: `sha256:${"f".repeat(64)}`,
      inventorySha256,
      activeLeaseIds: [],
      fetchedSetupIds: [],
      pendingIntentIds: [],
      intentStatuses: [],
      observations: [
        { observedAt: "2026-08-15T00:00:01.000Z", inventorySha256 },
        { observedAt: "2026-08-15T00:00:02.000Z", inventorySha256 },
      ] as const,
      eligibilityCutoff: "2026-08-15T00:00:02.000Z",
      stable: true as const,
    };
    const permit = {
      schemaVersion: 1 as const,
      rolloutId: "rollout-binding",
      runId: "1",
      runAttempt: 1,
      targetSystemIdentifier: "2",
      targetRecoveryWitnessSha256: "a".repeat(64),
      transitionSha256: transition.transitionSha256,
      expectedPreviousReceiptSha256: `sha256:${"0".repeat(64)}`,
      sourceLegacyAmbiguity: {
        ...sourceLegacyAmbiguityUnsigned,
        receiptSha256: sha256(canonicalJson(sourceLegacyAmbiguityUnsigned)),
      },
      eligibilityCutoff: "2026-08-15T00:00:02.000Z",
      epoch: 1,
      nonce: "b".repeat(32),
    };
    const observation = {
      transitionSha256: transition.transitionSha256,
      migrationArtifactDigest: transition.migrationArtifactDigest,
      migrationBundleSha256: transition.migrationBundleSha256,
      preManifestIdentity: transition.preManifestIdentity,
      postManifestIdentity: transition.postManifestIdentity,
      postCatalogDigest: transition.postCatalogDigest,
      permitEpoch: 1,
      permitNonce: permit.nonce,
      targetSystemIdentifier: permit.targetSystemIdentifier,
      targetRecoveryWitnessSha256: permit.targetRecoveryWitnessSha256,
      sourceLegacyAmbiguitySha256: inventorySha256,
      eligibilityCutoff: permit.eligibilityCutoff,
    };
    expect(() =>
      assertReleaseMigrationObservation(observation, transition, permit),
    ).not.toThrow();
    expect(() =>
      assertReleaseMigrationObservation(
        { ...observation, eligibilityCutoff: "2026-08-15T00:00:03.000Z" },
        transition,
        permit,
      ),
    ).toThrow("release_migration_observation_binding_invalid");
    expect(() =>
      assertReleaseMigrationObservation(
        {
          ...observation,
          sourceLegacyAmbiguitySha256: `sha256:${"f".repeat(64)}`,
        },
        transition,
        permit,
      ),
    ).toThrow("release_migration_observation_binding_invalid");
  });
});
