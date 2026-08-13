import { describe, expect, it } from "vitest";
import {
  releaseAuthorityMigrationBundle,
  releaseAuthorityMigrationPaths,
} from "./install-release-authority-db.mjs";

describe("release authority database installation", () => {
  it("applies the complete ordered migration chain exactly once in one transaction", () => {
    expect(releaseAuthorityMigrationPaths).toEqual([
      "packages/platform/release-authority-db/migrations/000001_release_authority/migration.sql",
      "packages/platform/release-authority-db/migrations/000002_external_effect_protocol/migration.sql",
      "packages/platform/release-authority-db/migrations/000002_transactional_service_transition/migration.sql",
    ]);
    const bundle = releaseAuthorityMigrationBundle();
    const first = bundle.indexOf("CREATE SCHEMA release_authority");
    const second = bundle.indexOf("ADD COLUMN effect_state");
    const third = bundle.indexOf("CREATE TABLE release_authority.service_transition");
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
    expect(bundle.match(/^BEGIN;$/gmu)).toHaveLength(1);
    expect(bundle.match(/^COMMIT;$/gmu)).toHaveLength(1);
    expect(bundle.match(/CREATE SCHEMA release_authority/gu)).toHaveLength(1);
    expect(bundle.match(/ADD COLUMN effect_state/gu)).toHaveLength(1);
    expect(
      bundle.match(/CREATE TABLE release_authority\.service_transition \(/gu),
    ).toHaveLength(1);
  });
});
