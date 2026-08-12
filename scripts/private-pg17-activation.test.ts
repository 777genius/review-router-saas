import { describe, expect, it } from "vitest";
import {
  canonicalActivationSql,
  roleProvisioningSql,
  runtimeAclGateStatements,
  runtimeGrantSql,
} from "./run-codex-rotating-release-migration.mjs";

const configuration = {
  roles: [
    { role: "api", username: "reviewrouter_api", password: "api-pass" },
    { role: "web", username: "reviewrouter_web", password: "web-pass" },
    {
      role: "worker",
      username: "reviewrouter_worker",
      password: "worker-pass",
    },
    {
      role: "effect-authority",
      username: "reviewrouter_codex_effect_authority",
      password: "effect-pass",
    },
  ],
  releasePassword: "release-pass",
};
const activationFence = {
  rolloutId: "rollout-activation-1",
  expectedCommitSha: "a".repeat(40),
  runId: "12",
  jobId: "34",
  runAttempt: 1,
  sourceSystemIdentifier: "100",
  targetSystemIdentifier: "200",
  previousReceiptSha256: `sha256:${"b".repeat(64)}`,
  fenceNonce: "c".repeat(32),
  fenceVersion: 1,
  claimVersion: 1,
  targetDeployIds: ["dep-target"],
};

describe("transactional PG17 activation", () => {
  it("keeps every runtime role closed in the migration transaction", () => {
    const sql = runtimeGrantSql(configuration, { gateClosed: true });
    expect(sql).toContain("BEGIN;");
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
    const activation = canonicalActivationSql(configuration, activationFence);
    expect(activation.canonicalPrivilegesSha256).toMatch(
      /^sha256:[a-f0-9]{64}$/u,
    );
    expect(activation.sql).toContain("BEGIN;");
    expect(activation.sql).toContain(
      "reviewrouter_bootstrap.activate_generation(",
    );
    expect(activation.sql.trim().endsWith("COMMIT;")).toBe(true);
    expect(activation.sql.indexOf("GRANT CONNECT")).toBeLessThan(
      activation.sql.indexOf("activate_generation("),
    );
    expect(activation.sql).toContain(activationFence.fenceNonce);
    expect(activation.sql).toContain(activationFence.previousReceiptSha256);
  });

  it("keeps the receipt behind a bootstrap-owned security-definer function", () => {
    const sql = roleProvisioningSql(configuration);
    expect(sql).toContain(
      "reviewrouter_bootstrap.release_generation_activation_receipt",
    );
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION reviewrouter_bootstrap.activate_generation",
    );
    expect(sql).toContain(
      "role bootstrap forbidden after generation activation",
    );
    expect(sql).toContain("activation receipt is append-only");
    expect(sql).not.toContain(
      "GRANT SELECT ON TABLE reviewrouter_bootstrap.release_generation_activation_receipt",
    );
  });

  it("rejects wrong or same generations", () => {
    expect(() =>
      canonicalActivationSql(configuration, {
        ...activationFence,
        targetSystemIdentifier: "100",
      }),
    ).toThrow("release_migration_activation_identity_invalid");
  });
});
