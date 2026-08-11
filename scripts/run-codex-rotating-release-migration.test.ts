import { describe, expect, it } from "vitest";
import {
  assertCanonicalRoleTopology,
  executeCanonicalReleaseMigration,
  executeCanonicalRoleBootstrap,
  resolveReleaseMigrationConfiguration,
  resolveRoleBootstrapConfiguration,
  roleProvisioningSql,
  providerRuntimeUpdateColumns,
  rotatingEvidenceTables,
  runReleaseMigrationSubprocess,
  runtimeGrantSql,
} from "./run-codex-rotating-release-migration.mjs";

function environment() {
  return {
    REVIEW_ROUTER_ROLE_BOOTSTRAP_DATABASE_URL:
      "postgresql://reviewrouter_role_bootstrap:bootstrap@db.internal/review_router",
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
    REVIEW_ROUTER_RELEASE_COMMIT_SHA: "a".repeat(40),
    REVIEW_ROUTER_RELEASE_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
  };
}

describe("canonical exclusive release migration caller", () => {
  it("rejects role-attribute drift and non-canonical bootstrap topology", () => {
    const names = [
      "reviewrouter_api",
      "reviewrouter_codex_effect_authority",
      "reviewrouter_release_migration",
      "reviewrouter_web",
      "reviewrouter_worker",
    ];
    const observation = {
      callerCount: 1,
      roles: names.map((username) => ({
        username,
        login: true,
        superuser: false,
        createDatabase: false,
        createRole: false,
        replication: false,
        bypassRls: false,
        canSetReleaseRole: username === "reviewrouter_release_migration",
      })),
      setRoleMatrix: names.flatMap((member) =>
        names.map((target) => ({ member, target, canSet: member === target })),
      ),
      bootstrapMemberships: names.map((granted) => ({
        granted,
        member: "reviewrouter_role_bootstrap",
        adminOption: true,
        inheritOption: false,
        setOption: false,
      })),
      ownership: {
        databaseOwner: "reviewrouter_role_bootstrap",
        publicSchemaOwner: "reviewrouter_release_migration",
        bootstrapSchemaOwner: "reviewrouter_role_bootstrap",
        bootstrapFunctionOwner: "reviewrouter_role_bootstrap",
        bootstrapFunctionCount: 1,
        unexpectedPublicObjectOwnerCount: 0,
      },
    };
    expect(assertCanonicalRoleTopology(observation)).toBe(observation);
    expect(() =>
      assertCanonicalRoleTopology({
        ...observation,
        roles: observation.roles.map((role, index) =>
          index === 0 ? { ...role, replication: true } : role,
        ),
      }),
    ).toThrow("release_migration_role_observation_failed");
    expect(() =>
      assertCanonicalRoleTopology({
        ...observation,
        bootstrapMemberships: observation.bootstrapMemberships.slice(1),
      }),
    ).toThrow("release_migration_role_observation_failed");
    expect(() =>
      assertCanonicalRoleTopology({
        ...observation,
        setRoleMatrix: [
          observation.setRoleMatrix[1],
          ...observation.setRoleMatrix.slice(1),
        ],
      }),
    ).toThrow("release_migration_role_observation_failed");
    expect(() =>
      assertCanonicalRoleTopology({
        ...observation,
        bootstrapMemberships: [
          observation.bootstrapMemberships[1],
          ...observation.bootstrapMemberships.slice(1),
        ],
      }),
    ).toThrow("release_migration_role_observation_failed");
    expect(() =>
      assertCanonicalRoleTopology({
        ...observation,
        ownership: {
          ...observation.ownership,
          publicSchemaOwner: "reviewrouter_role_bootstrap",
        },
      }),
    ).toThrow("release_migration_role_observation_failed");
  });

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
    expect(provisioning.match(/CREATE ROLE/g)).toHaveLength(5);
    expect(provisioning.match(/NOCREATEDB/g)).toHaveLength(5);
    expect(provisioning.match(/NOCREATEROLE/g)).toHaveLength(10);
    expect(provisioning).toContain(
      "refusing to converge unexpectedly privileged role",
    );
    expect(provisioning).toContain(
      "GRANT reviewrouter_release_migration TO reviewrouter_role_bootstrap WITH SET TRUE",
    );
    expect(provisioning).toContain(
      "ALTER ROUTINE %s OWNER TO reviewrouter_release_migration",
    );
    expect(provisioning).not.toContain("REASSIGN OWNED");
    expect(provisioning).toContain(
      "refusing to take over public objects owned by unexpected role",
    );
    expect(provisioning).toContain(
      "REVOKE reviewrouter_release_migration FROM reviewrouter_role_bootstrap GRANTED BY CURRENT_ROLE",
    );
    expect(provisioning).not.toContain(
      "TO reviewrouter_role_bootstrap WITH ADMIN TRUE",
    );
    expect(provisioning).not.toContain("ALTER DATABASE");
    expect(provisioning).toContain(
      "GRANT CONNECT, CREATE ON DATABASE %I TO reviewrouter_release_migration",
    );
    expect(provisioning).toContain(
      "CREATE SCHEMA IF NOT EXISTS reviewrouter_bootstrap AUTHORIZATION reviewrouter_role_bootstrap",
    );
    expect(provisioning).toContain(
      "DROP SCHEMA IF EXISTS reviewrouter_bootstrap",
    );
    expect(provisioning).toContain("SECURITY DEFINER");
    expect(provisioning).toContain(
      "reviewrouter_bootstrap.consume_migration_evidence",
    );
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
      const migrationHistoryRevocation = grants.indexOf(
        `REVOKE ALL ON TABLE public."_prisma_migrations" FROM ${role}`,
      );
      const keyRevocation = grants.indexOf(
        `REVOKE ALL ON TABLE public."CodexOAuthDatabaseAuthorityKey" FROM ${role}`,
      );
      const receiptRevocation = grants.indexOf(
        `REVOKE ALL ON TABLE public."CodexOAuthDatabaseAuthorityReceipt" FROM ${role}`,
      );
      expect(genericGrant).toBeGreaterThan(-1);
      expect(migrationHistoryRevocation).toBeGreaterThan(genericGrant);
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
      "swapped bootstrap role",
      {
        REVIEW_ROUTER_ROLE_BOOTSTRAP_DATABASE_URL:
          "postgresql://reviewrouter_release_migration:bootstrap@db.internal/review_router",
      },
      "release_migration_bootstrap_role_mismatch",
    ],
    [
      "swapped release role",
      {
        REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL:
          "postgresql://reviewrouter_role_bootstrap:release@db.internal/review_router",
      },
      "release_migration_caller_role_mismatch",
    ],
    [
      "bootstrap targets another port",
      {
        REVIEW_ROUTER_ROLE_BOOTSTRAP_DATABASE_URL:
          "postgresql://reviewrouter_role_bootstrap:bootstrap@db.internal:5433/review_router",
      },
      "release_migration_bootstrap_database_mismatch",
    ],
    [
      "wrong database",
      {
        REVIEW_ROUTER_API_DATABASE_URL:
          "postgresql://reviewrouter_api:secret@other.internal/review_router",
      },
      "release_migration_runtime_role_mismatch",
    ],
    [
      "wrong role",
      {
        REVIEW_ROUTER_API_DATABASE_URL:
          "postgresql://reviewrouter_worker:secret@db.internal/review_router",
      },
      "release_migration_runtime_role_mismatch",
    ],
  ])("rejects %s before execution", (_name, override, message) => {
    const resolver = message.includes("bootstrap")
      ? resolveRoleBootstrapConfiguration
      : resolveReleaseMigrationConfiguration;
    expect(() => resolver({ ...environment(), ...override })).toThrow(message);
  });

  it("separates role bootstrap from every release migration step", () => {
    const calls: Array<{
      step: string;
      args: string[];
      env?: NodeJS.ProcessEnv;
    }> = [];
    const roleNames = [
      "reviewrouter_api",
      "reviewrouter_codex_effect_authority",
      "reviewrouter_release_migration",
      "reviewrouter_web",
      "reviewrouter_worker",
    ];
    const run = (
      step: string,
      _command: string,
      args: string[],
      options = {},
    ) => {
      calls.push({ step, args, ...(options as object) });
      if (step === "verify_bootstrap_authority")
        return JSON.stringify({
          currentUser: "reviewrouter_role_bootstrap",
          sessionUser: "reviewrouter_role_bootstrap",
          login: true,
          superuser: false,
          createDatabase: false,
          createRole: true,
          replication: false,
          bypassRls: false,
        });
      if (step === "verify_release_authority")
        return JSON.stringify({
          currentUser: "reviewrouter_release_migration",
          sessionUser: "reviewrouter_release_migration",
          login: true,
          superuser: false,
          createDatabase: false,
          createRole: false,
          replication: false,
          bypassRls: false,
        });
      if (step === "verify_roles")
        return JSON.stringify({
          callerCount: 1,
          roles: roleNames.map((username) => ({
            username,
            login: true,
            superuser: false,
            createDatabase: false,
            createRole: false,
            replication: false,
            bypassRls: false,
            canSetReleaseRole: username === "reviewrouter_release_migration",
          })),
          setRoleMatrix: roleNames.flatMap((member) =>
            roleNames.map((target) => ({
              member,
              target,
              canSet: member === target,
            })),
          ),
          bootstrapMemberships: roleNames.map((granted) => ({
            granted,
            member: "reviewrouter_role_bootstrap",
            adminOption: true,
            inheritOption: false,
            setOption: false,
          })),
          ownership: {
            databaseOwner: "reviewrouter_role_bootstrap",
            publicSchemaOwner: "reviewrouter_release_migration",
            bootstrapSchemaOwner: "reviewrouter_role_bootstrap",
            bootstrapFunctionOwner: "reviewrouter_role_bootstrap",
            bootstrapFunctionCount: 1,
            unexpectedPublicObjectOwnerCount: 0,
          },
        });
      return step === "migration_history_preflight" ? "preflight" : "";
    };
    executeCanonicalRoleBootstrap(environment(), run);
    expect(calls.map((call) => call.step)).toEqual([
      "verify_bootstrap_authority",
      "provision_roles",
      "verify_release_authority",
      "verify_roles",
    ]);
    expect(
      calls.every(
        (call) =>
          call.args[0]?.includes("reviewrouter_role_bootstrap") ||
          call.step === "verify_release_authority" ||
          call.step === "verify_roles",
      ),
    ).toBe(true);

    calls.length = 0;
    executeCanonicalReleaseMigration(environment(), run);
    expect(calls.map((call) => call.step)).toEqual([
      "verify_release_authority",
      "migration_history_preflight",
      "deploy_migrations",
      "converge_runtime_grants",
      "verify_roles",
    ]);
    expect(
      calls.every(
        (call) =>
          call.args[0]?.includes("reviewrouter_release_migration") ||
          call.step === "migration_history_preflight" ||
          call.step === "deploy_migrations",
      ),
    ).toBe(true);
    expect(
      calls.every((call) =>
        (call as any).env?.DATABASE_URL.includes(
          "reviewrouter_release_migration",
        ),
      ),
    ).toBe(true);
  });

  it("rejects an unexpectedly privileged release connection before migrations", () => {
    const run = (step: string) => {
      if (step === "verify_bootstrap_authority")
        return JSON.stringify({
          currentUser: "reviewrouter_role_bootstrap",
          sessionUser: "reviewrouter_role_bootstrap",
          login: true,
          superuser: false,
          createDatabase: false,
          createRole: true,
          replication: false,
          bypassRls: false,
        });
      if (step === "verify_release_authority")
        return JSON.stringify({
          currentUser: "reviewrouter_release_migration",
          sessionUser: "reviewrouter_release_migration",
          login: true,
          superuser: false,
          createDatabase: false,
          createRole: true,
          replication: false,
          bypassRls: false,
        });
      return "";
    };
    expect(() =>
      executeCanonicalReleaseMigration(environment(), run as never),
    ).toThrow(
      "release_migration_connection_authority_mismatch:reviewrouter_release_migration",
    );
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
