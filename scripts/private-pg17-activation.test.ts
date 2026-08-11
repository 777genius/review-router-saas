import { describe, expect, it } from "vitest";
import {
  canonicalActivationSql,
  runtimeAclGateStatements,
  runtimeGrantSql,
} from "./run-codex-rotating-release-migration.mjs";

const configuration = {
  roles: [
    { role: "api", username: "reviewrouter_api" },
    { role: "web", username: "reviewrouter_web" },
    { role: "worker", username: "reviewrouter_worker" },
    {
      role: "effect-authority",
      username: "reviewrouter_codex_effect_authority",
    },
  ],
};

describe("transactional PG17 activation", () => {
  it("keeps every runtime role closed in the migration transaction", () => {
    const sql = runtimeGrantSql(configuration, { gateClosed: true });
    expect(sql).toContain("BEGIN;");
    expect(sql).toContain("ReleaseGenerationActivationReceipt");
    for (const role of configuration.roles) {
      expect(sql).toContain(
        `REVOKE CONNECT ON DATABASE :"DBNAME" FROM ${role.username}`,
      );
      expect(sql).toContain(
        `REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM ${role.username}`,
      );
    }
    expect(sql.lastIndexOf("COMMIT;")).toBeGreaterThan(
      sql.indexOf(runtimeAclGateStatements(configuration)),
    );
  });

  it("makes canonical grants and immutable receipt one commit boundary", () => {
    const activation = canonicalActivationSql(configuration, {
      rolloutId: "rollout-activation-1",
      sourceSystemIdentifier: "100",
      targetSystemIdentifier: "200",
    });
    expect(activation.canonicalPrivilegesSha256).toMatch(
      /^sha256:[a-f0-9]{64}$/u,
    );
    expect(activation.sql).toContain("BEGIN;");
    expect(activation.sql).toContain(
      'INSERT INTO public."ReleaseGenerationActivationReceipt"',
    );
    expect(activation.sql).toContain("firstWriteBoundary");
    expect(activation.sql.trim().endsWith("COMMIT;")).toBe(true);
    expect(activation.sql.indexOf("GRANT CONNECT")).toBeLessThan(
      activation.sql.indexOf("INSERT INTO"),
    );
  });

  it("rejects wrong or same generations", () => {
    expect(() =>
      canonicalActivationSql(configuration, {
        rolloutId: "rollout-activation-1",
        sourceSystemIdentifier: "100",
        targetSystemIdentifier: "100",
      }),
    ).toThrow("release_migration_activation_identity_invalid");
  });
});
