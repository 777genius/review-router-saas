import { describe, expect, it } from "vitest";
import {
  resolveReleaseMigrationConfiguration,
  roleProvisioningSql,
  runtimeGrantSql,
} from "./run-codex-rotating-release-migration.mjs";

function environment() {
  return {
    REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL:
      "postgresql://reviewrouter_release_migration:release@db.internal/review_router",
    REVIEW_ROUTER_API_DATABASE_URL:
      "postgresql://reviewrouter_api:api-secret@db.internal/review_router",
    REVIEW_ROUTER_WEB_DATABASE_URL:
      "postgresql://reviewrouter_web:web-secret@db.internal/review_router",
    REVIEW_ROUTER_WORKER_DATABASE_URL:
      "postgresql://reviewrouter_worker:worker-secret@db.internal/review_router",
    REVIEW_ROUTER_RENDER_COMMIT_SHA: "a".repeat(40),
    REVIEW_ROUTER_RENDER_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
  };
}

describe("canonical exclusive release migration caller", () => {
  it("converges exactly the three runtime roles and denies migration-role assumption", () => {
    const configuration = resolveReleaseMigrationConfiguration(environment());
    expect(configuration.roles.map((role) => role.username)).toEqual([
      "reviewrouter_api",
      "reviewrouter_web",
      "reviewrouter_worker",
    ]);
    const provisioning = roleProvisioningSql(configuration);
    const grants = runtimeGrantSql(configuration);
    expect(provisioning.match(/CREATE ROLE/g)).toHaveLength(3);
    expect(provisioning.match(/NOCREATEROLE/g)).toHaveLength(3);
    expect(grants.match(/SELECT, INSERT, UPDATE, DELETE/g)).toHaveLength(6);
    expect(grants).toContain(
      "REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC",
    );
    expect(grants).not.toContain("GRANT reviewrouter_release_migration");
  });

  it.each([
    [
      "wrong database",
      {
        REVIEW_ROUTER_API_DATABASE_URL:
          "postgresql://reviewrouter_api:secret@other.internal/review_router",
      },
    ],
    [
      "wrong role",
      {
        REVIEW_ROUTER_API_DATABASE_URL:
          "postgresql://reviewrouter_worker:secret@db.internal/review_router",
      },
    ],
  ])("rejects %s before execution", (_name, override) => {
    expect(() =>
      resolveReleaseMigrationConfiguration({ ...environment(), ...override }),
    ).toThrow("release_migration_runtime_role_mismatch");
  });

  it("never includes credential values in validation errors", () => {
    const secret = "credential-that-must-not-be-logged";
    try {
      resolveReleaseMigrationConfiguration({
        ...environment(),
        REVIEW_ROUTER_API_DATABASE_URL: `postgresql://wrong:${secret}@db.internal/review_router`,
      });
      throw new Error("expected failure");
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});
