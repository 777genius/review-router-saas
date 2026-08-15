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
} from "./release-migration-transition";

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

  it("binds the target observation to the source inventory and fixed cutoff", () => {
    const transition = createReleaseMigrationTransition({
      commitSha: "d".repeat(40),
      releaseImageDigest: `sha256:${"e".repeat(64)}`,
    });
    const inventorySha256 =
      "sha256:ee9ab3e1f9d9f0e88e96addb3a20b70a04a166f0d979fd5ce3fc59e1dcdbf55f";
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
        inventorySha256,
        activeLeaseIds: [],
        fetchedSetupIds: [],
        pendingIntentIds: [],
        intentStatuses: [],
        observations: [
          { observedAt: "2026-08-15T00:00:00.000Z", inventorySha256 },
          { observedAt: "2026-08-15T00:00:01.000Z", inventorySha256 },
        ] as const,
        stable: true as const,
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
