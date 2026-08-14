import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  activationAuthorityProvisioningSql,
  atomicMigrationAndGrantSql,
  activationPrincipalRoleCapabilityMatrix,
  assertCanonicalRoleTopology,
  canonicalRoleTopologyObservationSql,
  canonicalDatabaseGenerationObservationSql,
  executeCanonicalReleaseMigration,
  executeCanonicalRoleBootstrap,
  isActivationPrincipalRoleCapabilityPermitted,
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

describe("application database release-authority isolation", () => {
  it("keeps migration 000069 as an immutable no-op marker", () => {
    const migration = readFileSync(
      new URL(
        "../packages/platform/db/prisma/migrations/000069_release_rollout_ledger/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(migration).toContain("immutable history marker");
    expect(migration).not.toMatch(
      /\b(?:CREATE|ALTER|DROP|GRANT|REVOKE)\s+(?:ROLE|TABLE|FUNCTION|PROCEDURE)\b/iu,
    );
    expect(migration).not.toContain("release_rollout_ledger");
  });

  it("provisions only target-local activation capability", () => {
    const sql = activationAuthorityProvisioningSql();
    expect(sql).toContain("reviewrouter_activation.activation_permit");
    expect(sql).toContain("reviewrouter_activation.activation_receipt");
    expect(sql).toContain("reviewrouter_activation_permit_installer");
    expect(sql).toContain("SET LOCAL lock_timeout = '5000ms'");
    expect(sql).toContain("pg_advisory_xact_lock(1381126735, 1129271120)");
    expect(sql).toContain("external activation guard is not pre-provisioned");
    expect(sql).toContain(
      "REVOKE ALL ON ALL TABLES IN SCHEMA reviewrouter_activation FROM reviewrouter_activation_permit_installer",
    );
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION reviewrouter_activation.install_activation_permit",
    );
    expect(sql).toContain(
      "GRANT CONNECT ON DATABASE %I TO reviewrouter_activation_permit_installer;",
    );
    expect(sql).toContain("REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC;");
    expect(sql).toContain("current_database())\n\\gexec\nSELECT format(");
    expect(sql).toContain("DO $installer_database_acl$");
    expect(sql).not.toContain(
      "GRANT EXECUTE ON FUNCTION reviewrouter_activation.activate_generation(text,text) TO reviewrouter_activation_permit_installer",
    );
    expect(sql).not.toMatch(/reviewrouter_release_(?:control|witness)/u);
    expect(sql).not.toMatch(/public\."release_(?:rollout|runner)_/u);
  });

  it("rejects runtime reachability to the activation guard and distinct roles", () => {
    for (const capability of ["usage", "set"] as const) {
      expect(
        isActivationPrincipalRoleCapabilityPermitted(
          "reviewrouter_api",
          "reviewrouter_activation_receipt_guard",
          capability,
        ),
      ).toBe(false);
      expect(
        isActivationPrincipalRoleCapabilityPermitted(
          "reviewrouter_api",
          "reviewrouter_web",
          capability,
        ),
      ).toBe(false);
      expect(
        isActivationPrincipalRoleCapabilityPermitted(
          "reviewrouter_worker",
          "reviewrouter_release_migration",
          capability,
        ),
      ).toBe(false);
    }
  });

  it("keeps only intended identity reachability for every activation principal", () => {
    const loginNames = new Set(
      activationPrincipalRoleCapabilityMatrix.map(({ login }) => login),
    );
    const roleNames = new Set(
      activationPrincipalRoleCapabilityMatrix.map(({ role }) => role),
    );
    expect(loginNames).toEqual(
      new Set([
        "reviewrouter_api",
        "reviewrouter_web",
        "reviewrouter_worker",
        "reviewrouter_codex_effect_authority",
        "reviewrouter_release_migration",
        "reviewrouter_role_bootstrap",
        "reviewrouter_activation_permit_installer",
        "reviewrouter_activation_receipt_reader",
      ]),
    );
    expect(roleNames).toEqual(
      new Set([...loginNames, "reviewrouter_activation_receipt_guard"]),
    );
    expect(activationPrincipalRoleCapabilityMatrix).toHaveLength(
      loginNames.size * roleNames.size,
    );
    for (const edge of activationPrincipalRoleCapabilityMatrix) {
      expect(edge.usage).toBe(edge.login === edge.role);
      expect(edge.set).toBe(edge.login === edge.role);
    }
    for (const login of loginNames) {
      expect(
        isActivationPrincipalRoleCapabilityPermitted(login, login, "usage"),
      ).toBe(true);
      expect(
        isActivationPrincipalRoleCapabilityPermitted(login, login, "set"),
      ).toBe(true);
    }
    expect(
      isActivationPrincipalRoleCapabilityPermitted(
        "reviewrouter_activation_receipt_guard",
        "reviewrouter_activation_receipt_guard",
        "usage",
      ),
    ).toBe(false);
  });

  it("embeds the exact matrix and fail-closed SET and USAGE proof", () => {
    const sql = activationAuthorityProvisioningSql();
    expect(sql).toContain(
      "'roleCapabilityMatrix',role_capability_matrix_contract",
    );
    expect(sql).toContain("unexpected_role_usage");
    expect(sql).toContain("unexpected_role_set");
    expect(sql).toContain("unexpected_inherited_permission");
    expect(sql).toContain("unexpected_set_permission");
    expect(sql).toContain("database_owner_contract_mismatch");
    expect(sql).toContain(
      "WHERE capability.enabled AND NOT coalesce(\n      CASE capability.kind",
    );
    expect(sql).toContain(
      '"login":"reviewrouter_api","role":"reviewrouter_activation_receipt_guard","usage":false,"set":false',
    );
  });
});

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
        grantor: "platform_role_authority",
        adminOption: true,
        inheritOption: false,
        setOption: false,
      })),
      guard: {
        username: "reviewrouter_activation_receipt_guard",
        login: false,
        superuser: false,
        createDatabase: false,
        createRole: false,
        replication: false,
        bypassRls: false,
        membershipCount: 0,
      },
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
        bootstrapMemberships: observation.bootstrapMemberships.map(
          (entry, index) =>
            index === 0 ? { ...entry, grantor: "foreign_role_admin" } : entry,
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
        guard: { ...observation.guard, superuser: true },
      }),
    ).toThrow("release_migration_role_observation_failed");
    expect(() =>
      assertCanonicalRoleTopology({
        ...observation,
        guard: { ...observation.guard, membershipCount: 1 },
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
    const activationAuthority = activationAuthorityProvisioningSql();
    const atomicMigration = atomicMigrationAndGrantSql(configuration);
    for (const migrationSql of [provisioning, grants, activationAuthority]) {
      expect(migrationSql).toContain(
        "pg_advisory_xact_lock(1381126735, 1129271120)",
      );
      expect(migrationSql).toContain("SET LOCAL lock_timeout = '5000ms'");
    }
    expect(atomicMigration).toContain(
      "SELECT pg_advisory_lock(1381126735, 1129271120)",
    );
    expect(atomicMigration).toContain(
      "\\! pnpm --filter @reviewrouter/platform-db db:migrate:deploy",
    );
    expect(atomicMigration).toContain("\\if :SHELL_ERROR");
    expect(atomicMigration).toContain("\\quit :SHELL_EXIT_CODE");
    expect(atomicMigration.indexOf("pg_advisory_lock")).toBeLessThan(
      atomicMigration.indexOf("db:migrate:deploy"),
    );
    expect(atomicMigration.indexOf("db:migrate:deploy")).toBeLessThan(
      atomicMigration.indexOf("BEGIN;"),
    );
    expect(atomicMigration.indexOf("COMMIT;")).toBeLessThan(
      atomicMigration.indexOf("pg_advisory_unlock"),
    );
    const observationSql = canonicalRoleTopologyObservationSql();
    const createdRoleIdentities = [
      ...provisioning.matchAll(/CREATE ROLE ([a-z_]+) ([^;]+);/gu),
    ].map(([, username, attributes]) => ({ attributes, username }));
    expect(createdRoleIdentities).toEqual(
      [
        "reviewrouter_api",
        "reviewrouter_web",
        "reviewrouter_worker",
        "reviewrouter_codex_effect_authority",
        "reviewrouter_release_migration",
      ].map((username) => ({
        username,
        attributes:
          "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '" +
          (username === "reviewrouter_api"
            ? "api-secret"
            : username === "reviewrouter_web"
              ? "web-secret"
              : username === "reviewrouter_worker"
                ? "worker-secret"
                : username === "reviewrouter_codex_effect_authority"
                  ? "signer-secret"
                  : "release") +
          "'",
      })),
    );
    expect(provisioning).not.toMatch(
      /ALTER ROLE [^;]+\b(?:SUPERUSER|NOSUPERUSER|CREATEDB|NOCREATEDB|REPLICATION|NOREPLICATION|BYPASSRLS|NOBYPASSRLS)\b/gu,
    );
    expect(provisioning).not.toContain(
      "ALTER ROLE reviewrouter_activation_receipt_guard",
    );
    expect(provisioning).not.toContain(
      "aclexplode(coalesce(attribute.attacl,'{}'::aclitem[]))",
    );
    expect(provisioning).toContain(
      "SET LOCAL ROLE reviewrouter_release_migration;",
    );
    expect(provisioning).toContain("DO $transferred_public_routine_acl$");
    expect(provisioning).toContain("REVOKE EXECUTE ON ROUTINE %s FROM PUBLIC");
    expect(provisioning).toContain(
      "'reviewrouter_activation_receipt_reader', routine.oid, 'EXECUTE'",
    );
    expect(provisioning).toContain(
      "transferred public routine ACL is non-canonical",
    );
    expect(provisioning.indexOf("DO $transfer_public_ownership$")).toBeLessThan(
      provisioning.indexOf("DO $transferred_public_routine_acl$"),
    );
    expect(
      provisioning.indexOf("DO $transferred_public_routine_acl_gate$"),
    ).toBeLessThan(
      provisioning.indexOf(
        "REVOKE reviewrouter_release_migration FROM reviewrouter_role_bootstrap",
      ),
    );
    expect(provisioning).toContain("OR observed.rolcanlogin");
    expect(provisioning).toContain("OR observed.rolsuper");
    expect(provisioning).toContain("OR observed.rolcreatedb");
    expect(provisioning).toContain("OR observed.rolcreaterole");
    expect(provisioning).toContain("OR observed.rolreplication");
    expect(provisioning).toContain("OR observed.rolbypassrls");
    expect(provisioning).toContain(
      "external activation receipt guard is not pre-provisioned canonically",
    );
    for (const removedAuthorityArtifact of [
      "reviewrouter_release_control",
      "reviewrouter_release_witness",
      "release_rollout_ledger",
      "release_rollout_receipt_ledger",
      "release_runner_provisioning_intent",
      "release_runner_job_ledger",
      "release_rollout_claim",
      "release_runner_persist_cleanup_witness",
    ]) {
      expect(provisioning).not.toContain(removedAuthorityArtifact);
      expect(grants).not.toContain(removedAuthorityArtifact);
      expect(observationSql).not.toContain(removedAuthorityArtifact);
    }
    expect(provisioning).not.toContain(
      "GRANT reviewrouter_activation_receipt_guard TO",
    );
    expect(provisioning).toContain(
      "activation receipt guard must have no membership edges",
    );
    expect(provisioning).toContain(
      "AND granted.rolname <> 'reviewrouter_activation_receipt_guard'",
    );
    expect(observationSql).toContain("'membershipCount', (SELECT count(*)");
    expect(observationSql).toContain(
      "AND granted.rolname <> 'reviewrouter_activation_receipt_guard'",
    );
    expect(
      provisioning.match(
        /ALTER ROLE reviewrouter_[a-z_]+ LOGIN NOCREATEROLE PASSWORD/gu,
      ),
    ).toHaveLength(5);
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
      "refusing non-canonical role membership topology",
    );
    expect(provisioning).toContain(
      "REVOKE %I FROM %I GRANTED BY reviewrouter_role_bootstrap",
    );
    expect(provisioning).toContain("count(DISTINCT grantor.oid)");
    expect(provisioning).toContain(
      "REVOKE reviewrouter_release_migration FROM reviewrouter_role_bootstrap GRANTED BY CURRENT_ROLE",
    );
    expect(provisioning).not.toContain(
      "TO reviewrouter_role_bootstrap WITH ADMIN TRUE",
    );
    expect(provisioning).not.toContain("ALTER DATABASE");
    expect(provisioning).toContain(
      "GRANT CREATE ON DATABASE %I TO reviewrouter_release_migration",
    );
    expect(provisioning).toContain(
      "GRANT CONNECT ON DATABASE %I TO reviewrouter_release_migration WITH GRANT OPTION",
    );
    expect(provisioning).toContain(
      "release migration database delegation is non-canonical",
    );
    expect(provisioning).toContain(
      "GRANT USAGE, CREATE ON SCHEMA public TO reviewrouter_release_migration",
    );
    expect(provisioning).toContain("shobj_description(oid, 'pg_database')");
    expect(provisioning).toContain(
      "CREATE SCHEMA IF NOT EXISTS reviewrouter_bootstrap AUTHORIZATION reviewrouter_role_bootstrap",
    );
    expect(provisioning).not.toContain(
      "DROP SCHEMA IF EXISTS reviewrouter_bootstrap",
    );
    expect(provisioning).toContain("SECURITY DEFINER");
    expect(activationAuthorityProvisioningSql()).toContain(
      "pg_catalog.sha256(convert_to(",
    );
    expect(provisioning).not.toContain("public.digest(");
    expect(provisioning).toContain(
      "reviewrouter_bootstrap.consume_migration_evidence",
    );
    expect(grants.match(/SELECT, INSERT, UPDATE, DELETE/g)).toHaveLength(6);
    expect(grants).toContain(
      "REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC",
    );
    expect(grants).not.toContain("GRANT reviewrouter_release_migration");
    expect(grants).not.toContain("GRANT EXECUTE ON FUNCTION public.digest");
    expect(grants).toContain("runtime CONNECT state mismatch for %");
    expect(grants).toContain("PUBLIC retained database CONNECT");
    expect(grants).toContain(
      'GRANT EXECUTE ON FUNCTION public."codex_oauth_sign_database_authority"(text) TO reviewrouter_codex_effect_authority',
    );
    expect(grants).toContain(
      "GRANT EXECUTE ON FUNCTION public.reviewrouter_record_runtime_generation_witness_proof(TEXT, TEXT, TEXT, TEXT) TO reviewrouter_web, reviewrouter_api, reviewrouter_worker",
    );
    expect(grants).toContain(
      "GRANT EXECUTE ON FUNCTION public.reviewrouter_read_runtime_generation_witness_proofs(TEXT, TEXT) TO reviewrouter_api",
    );
    expect(grants).toContain(
      "GRANT EXECUTE ON FUNCTION public.reviewrouter_runtime_generation_write_read_canary(TEXT, TEXT) TO reviewrouter_api",
    );
    expect(activationAuthority).toContain(
      "WHEN proname='reviewrouter_record_runtime_generation_witness_proof' THEN",
    );
    expect(activationAuthority).toContain(
      "role_kind IN ('api','web','worker')",
    );
    expect(activationAuthority).toContain(
      "WHEN role_kind='api' AND proname='reviewrouter_read_runtime_generation_witness_proofs' THEN",
    );
    expect(activationAuthority).toContain(
      "WHEN role_kind='api' AND proname='reviewrouter_runtime_generation_write_read_canary' THEN",
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
            grantor: "platform_role_authority",
            adminOption: true,
            inheritOption: false,
            setOption: false,
          })),
          guard: {
            username: "reviewrouter_activation_receipt_guard",
            login: false,
            superuser: false,
            createDatabase: false,
            createRole: false,
            replication: false,
            bypassRls: false,
            membershipCount: 0,
          },
          ownership: {
            databaseOwner: "reviewrouter_role_bootstrap",
            publicSchemaOwner: "reviewrouter_release_migration",
            bootstrapSchemaOwner: "reviewrouter_role_bootstrap",
            bootstrapFunctionOwner: "reviewrouter_role_bootstrap",
            bootstrapFunctionCount: 1,
            unexpectedPublicObjectOwnerCount: 0,
          },
        });
      if (step === "verify_database_generation")
        return JSON.stringify({
          systemIdentifier: "7612345678901234567",
          recoveryWitnessSha256: "f".repeat(64),
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
      "deploy_migrations_and_converge_grants",
      "verify_roles",
      "verify_database_generation",
    ]);
    expect(
      calls.every(
        (call) =>
          call.args[0]?.includes("reviewrouter_release_migration") ||
          call.step === "migration_history_preflight",
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

  it("emits only the authoritative generation identifier and witness hash", () => {
    expect(canonicalDatabaseGenerationObservationSql()).toContain(
      "pg_control_system()",
    );
    expect(canonicalDatabaseGenerationObservationSql()).toContain(
      "shobj_description",
    );
    const env = {
      ...environment(),
      REVIEW_ROUTER_ROLE_BOOTSTRAP_DATABASE_URL:
        "not-a-bootstrap-url-that-release-must-ignore",
    };
    expect(resolveReleaseMigrationConfiguration(env).releaseUrl).toContain(
      "reviewrouter_release_migration",
    );
  });

  it("keeps loopback identity available only through an explicit test dependency", () => {
    const env = Object.fromEntries(
      Object.entries(environment()).map(([name, value]) => [
        name,
        typeof value === "string"
          ? value.replaceAll("db.internal", "127.0.0.1:55432")
          : value,
      ]),
    );
    expect(() => resolveReleaseMigrationConfiguration(env)).toThrow(
      "release_migration_private_database_host_required",
    );
    const configuration = resolveReleaseMigrationConfiguration(env, (value) => {
      const url = value instanceof URL ? value : new URL(value);
      if (url.hostname !== "127.0.0.1") throw new Error("test_non_loopback");
      return `${url.hostname}:${url.port}${url.pathname}`;
    });
    expect(configuration.databaseIdentity).toBe(
      "127.0.0.1:55432/review_router",
    );
  });

  it("strictly normalizes historical receipts before replay checks", () => {
    const sql = roleProvisioningSql(
      resolveReleaseMigrationConfiguration(environment()),
    );
    expect(sql).toContain("jsonb_build_object('receiptVersion', 2)");
    expect(sql).toContain("receipt history replay invalid");
    expect(sql).toContain("expected_system_identifier");
    expect(sql).toContain("expected_recovery_witness_sha256");
    expect(sql).toContain(
      "(SELECT count(*) FROM jsonb_object_keys(binding)) NOT IN (3, 4)",
    );
    expect(sql).toContain("NOT binding ? 'consumedMigrationEvidence'");
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
    ).toThrow('"code":"release_migration_step_failed"');
    try {
      runReleaseMigrationSubprocess("redaction_regression", process.execPath, [
        "-e",
        "process.exit(19)",
        credential,
      ]);
    } catch (error) {
      expect(String(error)).not.toContain(credential);
      expect(String(error)).not.toContain("postgresql://");
      expect(JSON.stringify(error)).not.toContain(credential);
      expect(String(error).length).toBeLessThan(768);
    }
  });
});
