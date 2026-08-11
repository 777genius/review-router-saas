import { describe, expect, it } from "vitest";
import {
  resolveReleaseMigrationConfiguration,
  roleProvisioningSql,
  providerRuntimeUpdateColumns,
  rotatingEvidenceTables,
  runReleaseMigrationSubprocess,
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
    REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL:
      "postgresql://reviewrouter_codex_effect_authority:signer-secret@db.internal/review_router",
    REVIEW_ROUTER_RENDER_COMMIT_SHA: "a".repeat(40),
    REVIEW_ROUTER_RENDER_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
  };
}

describe("canonical exclusive release migration caller", () => {
  it("converges the four service roles and isolates effect authority", () => {
    const configuration = resolveReleaseMigrationConfiguration(environment());
    expect(configuration.roles.map((role) => role.username)).toEqual([
      "reviewrouter_api",
      "reviewrouter_web",
      "reviewrouter_worker",
      "reviewrouter_codex_effect_authority",
    ]);
    const provisioning = roleProvisioningSql(configuration);
    const grants = runtimeGrantSql(configuration);
    expect(provisioning.match(/CREATE ROLE/g)).toHaveLength(4);
    expect(provisioning.match(/NOCREATEROLE/g)).toHaveLength(4);
    expect(grants.match(/SELECT, INSERT, UPDATE, DELETE/g)).toHaveLength(6);
    expect(grants).toContain(
      "REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC",
    );
    expect(grants).not.toContain("GRANT reviewrouter_release_migration");
    expect(grants).toContain(
      'GRANT EXECUTE ON FUNCTION public."codex_oauth_sign_database_authority"(text) TO reviewrouter_codex_effect_authority',
    );
    expect(grants).toContain(
      "REVOKE ALL ON ALL TABLES IN SCHEMA public FROM reviewrouter_codex_effect_authority",
    );
    expect(grants).not.toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO reviewrouter_codex_effect_authority/u,
    );
    for (const role of [
      "reviewrouter_api",
      "reviewrouter_web",
      "reviewrouter_worker",
    ]) {
      expect(grants).toContain(
        `REVOKE INSERT, UPDATE, DELETE ON TABLE public."RepositoryConnection" FROM ${role}`,
      );
      expect(grants).toContain(
        `GRANT SELECT ON TABLE public."RepositoryConnection" TO ${role}`,
      );
      const genericGrant = grants.indexOf(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`,
      );
      const keyRevocation = grants.indexOf(
        `REVOKE ALL ON TABLE public."CodexOAuthDatabaseAuthorityKey" FROM ${role}`,
      );
      const receiptRevocation = grants.indexOf(
        `REVOKE ALL ON TABLE public."CodexOAuthDatabaseAuthorityReceipt" FROM ${role}`,
      );
      expect(genericGrant).toBeGreaterThan(-1);
      expect(keyRevocation).toBeGreaterThan(genericGrant);
      expect(receiptRevocation).toBeGreaterThan(genericGrant);
      expect(grants).toContain(
        `GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${role}`,
      );
      for (const table of rotatingEvidenceTables) {
        expect(grants).toContain(`'${table}'`);
      }
      expect(grants).toContain("REVOKE ALL (%I) ON TABLE public.%I FROM %I");
      expect(grants).toContain("'REVOKE DELETE ON TABLE public.%I FROM %I'");
      expect(grants).toContain(
        "'REVOKE INSERT, UPDATE, DELETE ON TABLE public.%I FROM %I'",
      );
      expect(grants).toContain(
        `REVOKE UPDATE ON TABLE public."CodexOAuthProviderInstance" FROM ${role}`,
      );
      expect(grants).toContain(
        `GRANT UPDATE (${providerRuntimeUpdateColumns
          .map((column) => `"${column}"`)
          .join(
            ", ",
          )}) ON TABLE public."CodexOAuthProviderInstance" TO ${role}`,
      );
    }
    expect(
      grants.indexOf(
        "REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM reviewrouter_codex_effect_authority",
      ),
    ).toBeLessThan(
      grants.indexOf(
        'GRANT EXECUTE ON FUNCTION public."codex_oauth_sign_database_authority"(text) TO reviewrouter_codex_effect_authority',
      ),
    );
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

  it("redacts credential-bearing argv and environment on subprocess failure", () => {
    const credential = "subprocess-credential-that-must-not-leak";
    expect(() =>
      runReleaseMigrationSubprocess(
        "redaction_regression",
        process.execPath,
        ["-e", "process.exit(19)", credential],
        {
          env: {
            ...process.env,
            DATABASE_URL: `postgresql://role:${credential}@db.internal/app`,
          },
        },
      ),
    ).toThrow("release_migration_step_failed:redaction_regression");
    try {
      runReleaseMigrationSubprocess("redaction_regression", process.execPath, [
        "-e",
        "process.exit(19)",
        credential,
      ]);
    } catch (error) {
      expect(String(error)).not.toContain(credential);
      expect(String(error)).not.toContain("postgresql://");
    }
  });
});
