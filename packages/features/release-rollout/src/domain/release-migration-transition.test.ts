import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertReleaseMigrationTransition,
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

  it("pins every exact crash-resume root from pre through V72 post", () => {
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
    expect(roots).toEqual(canonicalReleaseMigrationResumeManifestIdentities);
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
});
