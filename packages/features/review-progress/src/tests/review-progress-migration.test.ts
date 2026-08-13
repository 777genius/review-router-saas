import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../platform/db/prisma/migrations/000067_review_live_progress/migration.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const validationMigration = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../platform/db/prisma/migrations/000068_validate_review_assignment_manifest/migration.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("review live progress migration", () => {
  it("adds the existing-table manifest check as not valid", () => {
    expect(migration).toMatch(
      /ADD CONSTRAINT "ReviewExecutionV2_assignment_manifest_all_or_none"[\s\S]*?NOT VALID;/u,
    );
    expect(migration).not.toContain("VALIDATE CONSTRAINT");
  });

  it("validates the existing-table manifest check in a later migration", () => {
    expect(validationMigration.trim()).toBe(
      'ALTER TABLE "ReviewExecutionV2"\n  VALIDATE CONSTRAINT "ReviewExecutionV2_assignment_manifest_all_or_none";',
    );
  });

  it("rejects partial-null coverage tuples in the non-null branch", () => {
    const coverageCheck = migration.match(
      /CONSTRAINT "ReviewExecutionProgressV1_coverage_all_or_none" CHECK \(([\s\S]*?)\n {2}\)/u,
    )?.[1];
    expect(coverageCheck).toBeDefined();
    for (const column of [
      "eligibleFileCount",
      "coveredFileCount",
      "uncoveredFileCount",
      "excludedFileCount",
    ]) {
      expect(coverageCheck).toContain(`"${column}" IS NOT NULL`);
    }
  });

  it("keeps only the partial due-publication index", () => {
    expect(migration).not.toContain("ReviewProgressPublicationV1_due_idx");
    expect(migration).toContain("ReviewProgressPublicationV1_due_partial_idx");
    expect(migration).toContain('WHERE "desiredVersion" > "publishedVersion"');
  });
});
