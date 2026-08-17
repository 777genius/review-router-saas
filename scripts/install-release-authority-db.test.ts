import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  installReleaseAuthorityDatabase,
  releaseAuthorityBootstrapAdministratorRole,
  releaseAuthorityBootstrapCleanupSql,
  releaseAuthorityBootstrapPreparationSql,
  releaseAuthorityBootstrapProvisioningSql,
  releaseAuthorityBootstrapRelinquishSql,
  releaseAuthorityBootstrapRecoverySql,
  releaseAuthorityBootstrapTerminalSql,
  releaseAuthorityBootstrapLifecycleSql,
  releaseAuthorityProviderRootProbeSql,
  validateProviderRootAttestation,
  releaseAuthorityAclFingerprintSql,
  releaseAuthorityCatalogFingerprintSql,
  releaseAuthorityMigrationBundle,
  releaseAuthorityMigrationManifest,
  releaseAuthorityMigrationPaths,
  postgresEnvironment,
} from "./install-release-authority-db.mjs";
import {
  parseReleaseAuthorityPostgresUrl,
  releaseAuthorityPostgresEndpoint,
  releaseAuthorityPostgresPassfileLine,
  releaseAuthorityPostgresUrlWithCredentials,
} from "./lib/release-authority-postgres-url.mjs";

const providerRoot = Object.freeze({
  contractVersion: 1,
  systemIdentifier: "72623859790382856",
  rootOid: 10,
  rootName: "opaque_provider_root",
  providerOid: 16_384,
  providerName: "reviewrouter_bootstrap_administrator",
});

describe("release authority database installation", () => {
  it("probes, pins, and classifies the opaque provider trust root", () => {
    const probe = releaseAuthorityProviderRootProbeSql(
      `rr_root_probe_${"a".repeat(32)}`,
    );
    expect(probe).toContain("SET LOCAL createrole_self_grant=''");
    expect(probe).toContain('CREATE ROLE "rr_root_probe_');
    expect(probe).toContain("pg_catalog.pg_control_system()");
    expect(probe).toContain('DROP ROLE "rr_root_probe_');
    expect(probe).not.toContain("postgres");
    expect(validateProviderRootAttestation(providerRoot)).toEqual(providerRoot);
    expect(() =>
      validateProviderRootAttestation({ ...providerRoot, rootOid: 16_384 }),
    ).toThrow("release_authority_provider_root_attestation_invalid");
    const lifecycle = releaseAuthorityBootstrapLifecycleSql(
      "reviewrouter_role_bootstrap",
      providerRoot,
    );
    for (const state of [
      "fresh",
      "provisioned",
      "retryable",
      "cleanup-pending",
      "terminal",
      "drifted",
    ])
      expect(lifecycle).toContain(`'${state}'`);
    expect(lifecycle).toContain("membership.grantor=10");
    expect(lifecycle).toContain("system_identifier::text");
  });

  it("provisions an independent grantor and one-shot provider-owned retirement helper", () => {
    const provisioning = releaseAuthorityBootstrapProvisioningSql(
      "reviewrouter_role_bootstrap",
      "unused-password",
      providerRoot,
    );
    expect(provisioning).toContain(
      "GRANT reviewrouter_authority_owner TO reviewrouter_migration_broker\n  WITH ADMIN TRUE, INHERIT FALSE, SET FALSE",
    );
    expect(provisioning).toContain(
      'GRANT reviewrouter_authority_owner TO "reviewrouter_role_bootstrap"\n  WITH ADMIN FALSE, INHERIT TRUE, SET TRUE',
    );
    expect(provisioning).toContain(
      "membership.inherit_option IS NOT DISTINCT FROM",
    );
    expect(provisioning).toContain("membership.grantor<>10");
    expect(provisioning).toContain(
      "RAISE EXCEPTION 'release authority provider ADMIN topology is noncanonical'",
    );
    for (const cyclicGrant of [
      "GRANT reviewrouter_authority_owner TO reviewrouter_bootstrap_administrator",
      "GRANT reviewrouter_migration_broker TO reviewrouter_bootstrap_administrator",
      'GRANT "reviewrouter_role_bootstrap" TO reviewrouter_bootstrap_administrator',
    ])
      expect(provisioning).not.toContain(cyclicGrant);
    expect(provisioning).toContain(
      "CREATE FUNCTION reviewrouter_migration_bootstrap.quiesce(",
    );
    expect(provisioning).not.toContain(" CASCADE");
    expect(releaseAuthorityBootstrapAdministratorRole).toBe(
      "reviewrouter_bootstrap_administrator",
    );
    expect(provisioning).toContain("AND NOT role.rolsuper");
    expect(provisioning).toContain(
      "pg_has_role(current_user,'pg_signal_backend','MEMBER')",
    );
    expect(provisioning).toContain("pid<>pg_catalog.pg_backend_pid()");
    expect(provisioning).toContain(
      'ALTER ROLE "reviewrouter_role_bootstrap" LOGIN PASSWORD',
    );
    expect(provisioning).toContain(
      "AND NOT owner.rolsuper AND NOT owner.rolcreatedb",
    );
    expect(provisioning).toContain("bootstrap quiescence is noncanonical");
    expect(provisioning).not.toMatch(/\bCREATEDB\b/u);
    const preparation = releaseAuthorityBootstrapPreparationSql(
      "reviewrouter_role_bootstrap",
      providerRoot,
    );
    const relinquishment = releaseAuthorityBootstrapRelinquishSql(
      "reviewrouter_role_bootstrap",
    );
    expect(preparation).toContain(
      'GRANT CREATE ON DATABASE :"DBNAME"\n  TO reviewrouter_bootstrap_administrator',
    );
    expect(preparation).toContain(
      "AND NOT role.rolcreatedb AND role.rolcreaterole",
    );
    expect(relinquishment).toContain(
      'REVOKE CREATE ON DATABASE :"DBNAME"\n  FROM reviewrouter_bootstrap_administrator',
    );
    const recovery = releaseAuthorityBootstrapRecoverySql(
      "reviewrouter_role_bootstrap",
      "retry-password",
      providerRoot,
    );
    expect(recovery).toContain(
      "ALTER ROLE \"reviewrouter_role_bootstrap\" LOGIN PASSWORD 'retry-password'",
    );
    expect(recovery).toContain("CONNECTION LIMIT 1");
    expect(recovery).not.toContain("$bound_bootstrap_connections$");
    expect(recovery).toContain("membership.grantor=10");
    expect(recovery).toContain(
      "WHERE role.rolname='reviewrouter_role_bootstrap' AND NOT role.rolsuper\n        AND NOT role.rolcreatedb AND NOT role.rolreplication",
    );
    expect(recovery).not.toMatch(/\bCREATEDB\b/u);
    expect(() =>
      releaseAuthorityBootstrapProvisioningSql(
        "bad role;DROP ROLE x",
        "unused",
        providerRoot,
      ),
    ).toThrow("release_authority_bootstrap_role_invalid");
  });

  it("attests every helper property and converges sessions and credentials", () => {
    const provisioning = releaseAuthorityBootstrapProvisioningSql(
      "reviewrouter_role_bootstrap",
      "unused-password",
      providerRoot,
    );
    const helperBody = provisioning.match(
      /CREATE FUNCTION reviewrouter_migration_bootstrap\.quiesce\([\s\S]*?AS \$body\$([\s\S]*?)\$body\$;/u,
    )?.[1];
    expect(helperBody).toBeDefined();
    const helperSha256 = createHash("sha256").update(helperBody!).digest("hex");
    const migration = readFileSync(
      "packages/platform/release-authority-db/migrations/000015_migration_credential_lease/migration.sql",
      "utf8",
    );
    for (const contract of [
      `convert_to(procedure.prosrc,'UTF8')`,
      `'${helperSha256}'`,
      "procedure.provolatile='v'",
      "NOT procedure.proisstrict",
      "NOT procedure.proleakproof",
      "procedure.proparallel='u'",
      "procedure.prosupport=0",
      "procedure.proargtypes='19 19'",
      "count(*) FROM pg_catalog.pg_proc procedure",
      "pg_catalog.pg_operator object",
      "pg_catalog.pg_extension object",
      "pg_catalog.pg_statistic_ext object",
      "pg_catalog.pg_default_acl object",
      "has_database_privilege",
      "count(*) FROM pg_catalog.aclexplode(namespace.nspacl)",
      "count(*) FROM pg_catalog.aclexplode(procedure.proacl)",
    ])
      expect(migration).toContain(contract);
    expect(migration).not.toContain(
      "ALTER ROLE reviewrouter_authority_owner RESET ALL",
    );
    expect(migration).not.toContain(
      "ALTER ROLE reviewrouter_migration_broker RESET ALL",
    );
    expect(migration).not.toContain("procedure.protransform");
    expect(migration).not.toContain("RESET ROLE;\n\nDO $quiesce_bootstrap$");
    expect(migration).toContain(
      "REASSIGN OWNED BY %I TO reviewrouter_authority_owner",
    );
    expect(migration).toContain(
      "release authority bootstrap retained unexpected ownership",
    );
    expect(migration).toContain(
      "GRANT SELECT ON TABLE reviewrouter_migration_credential.provider_root_pin",
    );
    expect(migration).toContain(
      "GRANT SELECT ON TABLE reviewrouter_migration_credential.bootstrap_retirement",
    );
    expect(migration).toContain(
      "TO reviewrouter_release_control,reviewrouter_provider_authority,\n     reviewrouter_release_witness",
    );
    expect(migration).toContain(
      "current_user IS DISTINCT FROM 'reviewrouter_migration_broker'",
    );
    expect(migration).toContain(
      "session_user::pg_catalog.regrole::oid<>p_provider_oid",
    );
    expect(migration).toContain(
      "CREATE FUNCTION reviewrouter_migration_credential.login_role_membership_is_canonical(",
    );
    expect(migration).toContain(
      "CREATE FUNCTION reviewrouter_migration_credential.retire_terminal_login_roles()",
    );
    expect(migration).toContain(
      "CREATE FUNCTION reviewrouter_migration_credential.provider_terminal_topology_is_exact()",
    );
    expect(migration).toContain(
      "CREATE FUNCTION reviewrouter_migration_credential.terminalize_login_role(",
    );
    expect(migration).toContain(
      "reviewrouter_migration_credential.login_role_is_inert(item.login_role)",
    );
    expect(migration).toContain(
      "WHERE usename=item.login_role) THEN\n      CONTINUE;",
    );
    expect(migration).toContain(
      "migration credential terminal role is noncanonical",
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION reviewrouter_migration_credential.bootstrap_is_retired()\n  TO reviewrouter_authority_owner",
    );
    const cleanup = releaseAuthorityBootstrapCleanupSql(
      "reviewrouter_role_bootstrap",
      providerRoot,
    );
    expect(cleanup).toContain("pg_terminate_backend(backend.pid,5000)");
    expect(cleanup).toContain("NOLOGIN PASSWORD NULL");
    expect(cleanup).toContain(
      "role.rolsuper OR role.rolcreatedb OR role.rolreplication",
    );
    expect(cleanup).toContain(
      "membership.member=\n            'reviewrouter_bootstrap_administrator'::pg_catalog.regrole",
    );
    expect(cleanup).toContain("membership.grantor=10");
    expect(cleanup).toContain(
      "release authority cleanup left bootstrap memberships",
    );
    expect(cleanup).toContain(
      "DROP SCHEMA reviewrouter_migration_bootstrap RESTRICT",
    );
    const terminal = releaseAuthorityBootstrapTerminalSql(
      "reviewrouter_role_bootstrap",
      providerRoot,
    );
    expect(terminal).toContain(
      "NOT EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity",
    );
    expect(terminal).toContain("provider_root_pin_is_exact");
    expect(terminal).toContain("bootstrap_is_retired");
    expect(terminal).toContain("provider_terminal_topology_is_exact");
    expect(terminal).not.toContain(
      "FROM reviewrouter_migration_credential.bootstrap_retirement",
    );
    expect(terminal).toContain("count(*)=6 AND bool_and");
    expect(terminal).toContain(
      "pg_catalog.to_regnamespace('reviewrouter_migration_bootstrap') IS NULL",
    );
  });

  it("attests privileged bootstrap attributes before using only provider-permitted ALTER ROLE options", () => {
    const generated = [
      releaseAuthorityBootstrapProvisioningSql(
        "reviewrouter_role_bootstrap",
        "provision-password",
        providerRoot,
      ),
      releaseAuthorityBootstrapRecoverySql(
        "reviewrouter_role_bootstrap",
        "recovery-password",
        providerRoot,
      ),
      releaseAuthorityBootstrapCleanupSql(
        "reviewrouter_role_bootstrap",
        providerRoot,
      ),
    ];
    for (const sql of generated) {
      const firstAlter = sql.indexOf("ALTER ROLE");
      expect(firstAlter).toBeGreaterThan(-1);
      for (const attribute of [
        "rolsuper",
        "rolcreatedb",
        "rolreplication",
        "rolbypassrls",
      ]) {
        const attestation = sql.indexOf(attribute);
        expect(attestation).toBeGreaterThan(-1);
        expect(attestation).toBeLessThan(firstAlter);
      }
      for (const statement of sql.matchAll(/ALTER ROLE[^;]*;/gu))
        expect(statement[0]).not.toMatch(
          /\b(?:SUPERUSER|NOSUPERUSER|CREATEDB|NOCREATEDB|REPLICATION|NOREPLICATION|BYPASSRLS|NOBYPASSRLS)\b/u,
        );
    }
  });

  it("requires an explicit fresh-install or incremental-upgrade gate", () => {
    expect(() => releaseAuthorityMigrationBundle(undefined)).toThrow(
      "release_authority_migration_mode_required",
    );
    const fresh = releaseAuthorityMigrationBundle("fresh-install");
    const upgrade = releaseAuthorityMigrationBundle("incremental-upgrade");
    for (const bundle of [fresh, upgrade]) {
      expect(bundle).toContain(
        "pg_try_advisory_xact_lock(1381126735, 1381258071)",
      );
      expect(bundle).toContain("SET LOCAL lock_timeout = '5000ms'");
      expect(bundle).toContain("SET LOCAL statement_timeout = '120000ms'");
      expect(bundle).toContain("current_user IS DISTINCT FROM session_user");
      expect(bundle).toContain(
        "release authority migration caller is not the database owner session",
      );
      expect(bundle.match(/^BEGIN;$/gmu)).toHaveLength(1);
      expect(bundle.match(/^COMMIT;$/gmu)).toHaveLength(1);
    }
    expect(fresh).toContain(
      "release authority fresh install requires an absent authority schema",
    );
    expect(upgrade).toContain(
      "release authority incremental upgrade requires an existing authority schema",
    );
    expect(upgrade).toContain(
      "release authority migration caller does not own the authority schema",
    );
  });

  it("bounds production timeout configuration", () => {
    expect(() =>
      releaseAuthorityMigrationBundle("incremental-upgrade", process.cwd(), {
        lockTimeoutMs: 99,
      }),
    ).toThrow("release_authority_lock_timeout_invalid");
    expect(() =>
      releaseAuthorityMigrationBundle("incremental-upgrade", process.cwd(), {
        lockTimeoutMs: 2_000,
        statementTimeoutMs: 2_000,
      }),
    ).toThrow("release_authority_statement_timeout_invalid");
  });

  it("holds a credential lease and its owner grant inside the migration transaction", () => {
    const lease = {
      leaseId: `rrml-${"a".repeat(64)}`,
      loginRole: `rr_migration_${"b".repeat(24)}`,
      databaseName: "reviewrouter",
      ownerRole: "reviewrouter_authority_owner",
      expectedCommitSha: "c".repeat(40),
      workflowRunId: "123",
      workflowRunAttempt: 1,
      operation: "incremental-upgrade",
      expiresAt: "2026-08-16T12:00:00.000Z",
      passwordSha256: `sha256:${"d".repeat(64)}`,
      nonce: "A".repeat(43),
      receiptSha256: `sha256:${"e".repeat(64)}`,
    };
    const bundle = releaseAuthorityMigrationBundle(
      "incremental-upgrade",
      process.cwd(),
      { lease },
    );
    const consume = bundle.indexOf(
      "SELECT reviewrouter_migration_credential.consume(",
    );
    const assumeOwner = bundle.indexOf(
      "SET ROLE reviewrouter_authority_owner;",
      consume,
    );
    const finalize = bundle.indexOf(
      "SELECT reviewrouter_migration_credential.finalize(",
      assumeOwner,
    );
    const commit = bundle.indexOf("COMMIT;", finalize);
    expect(bundle.match(/^BEGIN;$/gmu)).toHaveLength(1);
    expect(bundle.match(/^COMMIT;$/gmu)).toHaveLength(1);
    expect(consume).toBeGreaterThan(bundle.indexOf("BEGIN;"));
    expect(assumeOwner).toBeGreaterThan(consume);
    expect(bundle.slice(consume, assumeOwner)).not.toContain("COMMIT;");
    expect(finalize).toBeGreaterThan(assumeOwner);
    expect(commit).toBeGreaterThan(finalize);
    expect(bundle).toContain(
      "reviewrouter_migration_credential.membership_is_active(\n                   member.rolname,granted.rolname)",
    );
    expect(bundle).toContain(
      "grantor.rolname='reviewrouter_migration_broker'\n                 AND NOT membership.admin_option\n                 AND NOT membership.inherit_option AND membership.set_option",
    );
    expect(bundle).toContain(
      "reviewrouter_migration_credential.login_role_membership_is_canonical(\n                   granted.rolname,member.rolname)",
    );
    expect(bundle).toContain("(CASE WHEN bootstrap_retired THEN 4 ELSE 5 END)");
    expect(bundle).toContain("(CASE WHEN bootstrap_retired THEN 3 ELSE 4 END)");
  });

  it("quiesces bootstrap before the final ACL and catalog gates", () => {
    const bundle = releaseAuthorityMigrationBundle("fresh-install");
    const migration = bundle.indexOf(
      "CREATE SCHEMA reviewrouter_migration_credential",
    );
    const finalCatalog = bundle.indexOf("DO $final_catalog$", migration);
    const quiescence = bundle.indexOf(
      "PERFORM reviewrouter_migration_bootstrap.quiesce(\n    session_user,current_database())",
      migration,
    );
    const commit = bundle.indexOf("COMMIT;", quiescence);
    expect(migration).toBeGreaterThan(-1);
    expect(quiescence).toBeGreaterThan(migration);
    expect(finalCatalog).toBeGreaterThan(quiescence);
    expect(commit).toBeGreaterThan(quiescence);
  });

  it("bounds consumed owner authority by the absolute lease expiry", () => {
    const migration = readFileSync(
      "packages/platform/release-authority-db/migrations/000015_migration_credential_lease/migration.sql",
      "utf8",
    );
    expect(migration).toContain("set_config('transaction_timeout'");
    expect(migration).toContain("set_config('statement_timeout'");
    expect(migration).toContain(
      "set_config('idle_in_transaction_session_timeout'",
    );
    expect(migration).toContain(
      "active.expires_at-pg_catalog.clock_timestamp()",
    );
    expect(migration).toContain(
      "CREATE CONSTRAINT TRIGGER migration_credential_consume_finalize_guard",
    );
    expect(migration).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(migration).toContain(
      "migration credential consume requires same-transaction finalize",
    );
  });

  it("fails closed on global and schema-scoped creating-owner default ACLs before DDL", () => {
    for (const mode of ["fresh-install", "incremental-upgrade"] as const) {
      const bundle = releaseAuthorityMigrationBundle(mode);
      const gate = bundle.indexOf("DO $default_acl_gate$");
      const firstAuthorityDdl = bundle.indexOf(
        "CREATE SCHEMA release_authority",
      );
      expect(gate).toBeGreaterThan(bundle.indexOf("DO $upgrade_gate$"));
      expect(gate).toBeLessThan(firstAuthorityDdl);
      expect(bundle).toContain("pg_catalog.pg_default_acl");
      expect(bundle).toContain("WITH relevant_owners(owner_oid) AS");
      expect(bundle).toContain(
        "default_acl.defaclrole IN (SELECT owner_oid FROM relevant_owners)",
      );
      expect(bundle).toContain(
        "default_acl.defaclnamespace IN\n        (0,coalesce(pg_catalog.to_regnamespace('release_authority')::oid,0))",
      );
      for (const kind of ["r", "S", "f", "T"])
        expect(bundle).toContain(`'${kind}'::"char"`);
      expect(bundle).toContain(
        "release authority creating owner default ACL is noncanonical",
      );
    }
  });

  it("independently gates activation on the explicit final object ACL matrix", () => {
    const bundle = releaseAuthorityMigrationBundle("incremental-upgrade");
    const finalGate = bundle.indexOf("DO $final_catalog$");
    const attestation = bundle.indexOf(
      "COMMENT ON SCHEMA release_authority",
      finalGate,
    );
    expect(finalGate).toBeGreaterThan(-1);
    expect(attestation).toBeGreaterThan(finalGate);
    expect(bundle.slice(finalGate, attestation)).toContain(
      "release authority final default ACL is noncanonical",
    );
    expect(bundle.slice(finalGate, attestation)).toContain(
      "release authority final object ACL matrix mismatch",
    );
    expect(bundle.slice(finalGate, attestation)).toContain(
      "attribute.attacl IS NOT NULL",
    );
    expect(bundle.slice(finalGate, attestation)).toContain(
      "type_record.typacl IS NOT NULL",
    );
    expect(bundle.slice(finalGate, attestation)).toContain("acl.is_grantable");
    expect(bundle.slice(finalGate, attestation)).toContain(
      "acl.grantor<>target.nspowner",
    );
    expect(bundle.slice(finalGate, attestation)).toContain(
      "relation.relowner=target.nspowner",
    );
    expect(bundle.slice(finalGate, attestation)).toContain(
      "sequence.relowner=target.nspowner",
    );
    expect(bundle.slice(finalGate, attestation)).toContain(
      "procedure.proowner=target.nspowner",
    );
    expect(bundle.slice(finalGate, attestation)).toContain(
      "pg_catalog.pg_auth_members",
    );
    expect(bundle.slice(finalGate, attestation)).toContain(
      "reviewrouter_release_control",
    );
    expect(bundle.slice(finalGate, attestation)).toContain(
      "reviewrouter_provider_authority",
    );
    expect(bundle.slice(finalGate, attestation)).toContain(
      "reviewrouter_release_witness",
    );
  });

  it("isolates owner psql from ambient PostgreSQL configuration", () => {
    const environment = postgresEnvironment(
      "postgresql://owner:secret@authority.internal/reviewrouter",
      {
        PATH: "/custom/bin",
        LANG: "en_US.UTF-8",
        PGSERVICE: "attacker",
        PGOPTIONS: "-c search_path=attacker",
        PGSSLMODE: "disable",
      },
      "/tmp/rr-authority-test/pgpass",
    );
    expect(environment).toEqual({
      PATH: "/custom/bin",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      PGCONNECT_TIMEOUT: "10",
      PGSSLMODE: "require",
      PGHOST: "authority.internal",
      PGPORT: "5432",
      PGDATABASE: "reviewrouter",
      PGUSER: "owner",
      PGPASSFILE: "/tmp/rr-authority-test/pgpass",
    });
    expect(environment).not.toHaveProperty("PGSERVICE");
    expect(environment).not.toHaveProperty("PGOPTIONS");
  });

  it("never propagates database URLs or raw subprocess output on failure", () => {
    const directory = mkdtempSync(join(tmpdir(), "release-authority-gate-"));
    try {
      const credentialFile = join(directory, "database-url");
      const fakePsql = join(directory, "psql");
      writeFileSync(
        credentialFile,
        "postgresql://owner:credential-canary@authority.internal/reviewrouter",
        { mode: 0o600 },
      );
      writeFileSync(
        fakePsql,
        "#!/bin/sh\nprintf '%s\\n' 'postgresql://owner:credential-canary@authority.internal/reviewrouter' >&2\nexit 7\n",
        { mode: 0o700 },
      );
      chmodSync(fakePsql, 0o700);
      expect(() =>
        installReleaseAuthorityDatabase({
          PATH: process.env.PATH,
          REVIEW_ROUTER_PSQL_BINARY: fakePsql,
          REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_MODE: "incremental-upgrade",
          REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_DATABASE_URL_FILE:
            credentialFile,
        }),
      ).toThrow('"code":"release_authority_migration_process_failed"');
      try {
        installReleaseAuthorityDatabase({
          PATH: process.env.PATH,
          REVIEW_ROUTER_PSQL_BINARY: fakePsql,
          REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_MODE: "incremental-upgrade",
          REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_DATABASE_URL_FILE:
            credentialFile,
        });
      } catch (error) {
        expect(String(error)).not.toContain("credential-canary");
        expect(String(error)).not.toContain("postgresql://");
        expect(JSON.stringify(error)).not.toContain("credential-canary");
        expect(String(error).length).toBeLessThan(768);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("redacts malformed credential URL canaries from every parser diagnostic", () => {
    const canary = "malformed-url-credential-canary";
    const malformed = `postgresql://owner:${canary}%ZZ@authority.internal/reviewrouter`;
    for (const parse of [
      () => postgresEnvironment(malformed),
      () => parseReleaseAuthorityPostgresUrl(malformed),
      () => releaseAuthorityPostgresEndpoint(malformed),
      () => releaseAuthorityPostgresPassfileLine(malformed),
      () =>
        releaseAuthorityPostgresUrlWithCredentials(
          malformed,
          "replacement",
          "replacement",
        ),
    ]) {
      let rejected = false;
      try {
        parse();
      } catch (error) {
        rejected = true;
        expect(String(error)).not.toContain(canary);
        expect(JSON.stringify(error)).not.toContain(canary);
        expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
      }
      expect(rejected).toBe(true);
    }

    const directory = mkdtempSync(join(tmpdir(), "authority-url-canary-"));
    try {
      const issuerFile = join(directory, "issuer-url");
      writeFileSync(issuerFile, malformed, { mode: 0o600 });
      const result = spawnSync(
        process.execPath,
        ["scripts/release-authority-migration-credential.mjs", "issue"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            REVIEW_ROUTER_RELEASE_AUTHORITY_CREDENTIAL_ISSUER_DATABASE_URL_FILE:
              issuerFile,
            REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_DATABASE_URL_FILE: join(
              directory,
              "lease-url",
            ),
            REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_LEASE_FILE: join(
              directory,
              "lease",
            ),
            REVIEW_ROUTER_RELEASE_AUTHORITY_EXPECTED_SHA: "a".repeat(40),
            REVIEW_ROUTER_RELEASE_AUTHORITY_WORKFLOW_RUN_ID: "1",
            REVIEW_ROUTER_RELEASE_AUTHORITY_WORKFLOW_RUN_ATTEMPT: "1",
            REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_MODE:
              "incremental-upgrade",
          },
        },
      );
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).not.toContain(canary);
      expect(result.stderr).toContain("release_authority_database_url_invalid");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["%00", "%0A", "%0D", "%C2%85", "%E2%80%A8"])(
    "rejects decoded passfile control character %s in every credential field",
    (encoded) => {
      const urls = [
        `postgresql://owner:secret@authority.internal/review${encoded}router`,
        `postgresql://own${encoded}er:secret@authority.internal/reviewrouter`,
        `postgresql://owner:sec${encoded}ret@authority.internal/reviewrouter`,
      ];
      for (const url of urls) {
        expect(() => parseReleaseAuthorityPostgresUrl(url)).toThrow(
          "release_authority_database_url_invalid",
        );
        expect(() => releaseAuthorityPostgresPassfileLine(url)).toThrow(
          "release_authority_database_url_invalid",
        );
      }
    },
  );

  it.each(["\n", "\r", "\t"])(
    "rejects literal URL control character %j before parser normalization",
    (control) => {
      const unsafe = `postgresql://owner:sec${control}ret@authority.internal/reviewrouter`;
      for (const parse of [
        () => parseReleaseAuthorityPostgresUrl(unsafe),
        () => releaseAuthorityPostgresPassfileLine(unsafe),
        () => postgresEnvironment(unsafe),
      ])
        expect(parse).toThrow("release_authority_database_url_invalid");

      const directory = mkdtempSync(join(tmpdir(), "authority-raw-control-"));
      try {
        const credentialFile = join(directory, "credential-url");
        writeFileSync(credentialFile, unsafe, { mode: 0o600 });
        expect(() =>
          installReleaseAuthorityDatabase({
            PATH: process.env.PATH,
            REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_MODE:
              "incremental-upgrade",
            REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_DATABASE_URL_FILE:
              credentialFile,
          }),
        ).toThrow("release_authority_database_url_invalid");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(["\n", "\r", "\t"])(
    "rejects leading and trailing credential-file control character %j",
    (control) => {
      const canonical =
        "postgresql://owner:secret@authority.internal/reviewrouter";
      for (const unsafe of [
        `${control}${canonical}`,
        `${canonical}${control}`,
      ]) {
        const directory = mkdtempSync(
          join(tmpdir(), "authority-boundary-control-"),
        );
        try {
          const credentialFile = join(directory, "credential-url");
          writeFileSync(credentialFile, unsafe, { mode: 0o600 });
          expect(() =>
            installReleaseAuthorityDatabase({
              PATH: process.env.PATH,
              REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_MODE:
                "incremental-upgrade",
              REVIEW_ROUTER_RELEASE_AUTHORITY_MIGRATION_DATABASE_URL_FILE:
                credentialFile,
            }),
          ).toThrow("release_authority_database_url_invalid");
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }
    },
  );

  it.each(["user\nname", "user\rname", "user\u0085name", "user\u2028name"])(
    "rejects replacement credentials containing control characters",
    (unsafeUsername) => {
      expect(() =>
        releaseAuthorityPostgresUrlWithCredentials(
          "postgresql://owner:secret@authority.internal/reviewrouter",
          unsafeUsername,
          "replacement",
        ),
      ).toThrow("release_authority_database_url_invalid");
    },
  );

  it("fails the database compensation gate on unresolved freeze effects", () => {
    const migration = readFileSync(
      "packages/platform/release-authority-db/migrations/000003_partial_source_freeze/migration.sql",
      "utf8",
    );
    expect(migration).toContain("phase IN ('intent','unchanged','suspended')");
    expect(migration).toContain("completed.phase='suspended'");
    expect(migration).toContain(
      "release runner effects unsafe for compensation",
    );
    expect(migration).toContain("source_freeze_completion");
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION release_authority.release_source_freeze_immutable() FROM PUBLIC;",
    );
  });
  it("installs the late-effect activation fence and forward-only persistence repair", () => {
    const migration = readFileSync(
      "packages/platform/release-authority-db/migrations/000005_late_runner_effects/migration.sql",
      "utf8",
    );
    expect(migration).toContain(
      "release runner duplicate effects unsafe for activation",
    );
    expect(migration).toContain("rolloutStateAtPersistence");
    expect(migration).toContain("release_authority.release_runner_persist_job");
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION release_authority.release_runner_compensation_gate() FROM PUBLIC;",
    );
  });
  it("installs the provider creation not-before boundary without rewriting migration history", () => {
    const migration = readFileSync(
      "packages/platform/release-authority-db/migrations/000006_runner_provider_creation_boundary/migration.sql",
      "utf8",
    );
    expect(migration).toContain("provider_creation_not_before");
    expect(migration).toContain(
      "not_before IS DISTINCT FROM intent.created_at",
    );
    expect(migration).toContain(
      "providerCreatedAt')::timestamptz < current_row.provider_creation_not_before",
    );
  });
  it("rechecks late runner effects at every compensation boundary", () => {
    const migration = readFileSync(
      "packages/platform/release-authority-db/migrations/000007_compensation_effect_fence/migration.sql",
      "utf8",
    );
    expect(migration).toContain("release_compensation_effects_are_safe");
    expect(migration).toContain("release_compensation_receipt_effect_gate");
    expect(migration).toContain("release_compensation_source_recovery_gate");
    expect(migration).toContain("sourceEligible',false");
    expect(migration).toContain(
      "WHERE rollout_id=p_input->>'rolloutId' FOR UPDATE;",
    );
    expect(migration.indexOf("DECLARE rollout_row")).toBeLessThan(
      migration.indexOf("DECLARE transition"),
    );
  });
  it("revokes public execution of the service transition trigger helper forward-only", () => {
    const migration = readFileSync(
      "packages/platform/release-authority-db/migrations/000008_trigger_helper_acl/migration.sql",
      "utf8",
    );
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION release_authority.release_service_transition_immutable() FROM PUBLIC;",
    );
  });
  it("keeps published 000009 immutable and records canonical or legacy byte identity", () => {
    const migration = readFileSync(
      "packages/platform/release-authority-db/migrations/000009_authority_history_and_forward_repairs/migration.sql",
      "utf8",
    );
    expect(migration).toContain(
      "CREATE TABLE release_authority.schema_migration",
    );
    expect(migration).toContain("legacy_equivalent");
    expect(migration).toContain(
      "sha256:eb4039b43228a07c241593d4d6dd863eceac7731d5898b0264e9bc67b3d746cf",
    );
    expect(migration).toContain(
      "sha256:e88a7cc8f29e91a86434bf14b4051f1fb17b5df02f8fc2dae6ec63d5792b398b",
    );
    expect(migration).toContain(
      "receipt_sha256=current_row.last_receipt_sha256",
    );
    expect(migration).toContain("intent_rollout_id");
    expect(migration).toContain("release_schema_migration_manifest");
    expect(createHash("sha256").update(migration).digest("hex")).toBe(
      "bc2fb62a012ad9676ce696a5652abc8d29f2110243f0072dc75bcdcfb0ac8e25",
    );
  });
  it("identifies exact two-file catalogs before later migrations can erase byte evidence", () => {
    const bundle = releaseAuthorityMigrationBundle("incremental-upgrade");
    expect(bundle).toContain("release_authority_verify_canonical");
    expect(bundle).toContain("release_authority_verify_legacy");
    expect(bundle).toContain("complete_catalog_v5_provider_root_pin");
    expect(bundle).toContain(
      "legacy catalog is ambiguous or modified; audited repair required",
    );
    expect(bundle).toContain("procedure.prosrc");
    expect(bundle).toContain("pg_catalog.pg_get_triggerdef");
    expect(bundle).toContain("pg_catalog.pg_get_constraintdef");
    expect(bundle).toContain("pg_catalog.pg_get_indexdef");
    expect(bundle).toContain("pg_catalog.aclexplode");
    expect(bundle).toContain("pg_catalog.pg_enum");
    expect(bundle).toContain("attribute.attacl");
    expect(bundle).toContain("pg_catalog.pg_get_function_arguments");
    const canonicalAudit = bundle.indexOf(
      "building verified catalog release_authority_verify_canonical",
    );
    const legacyAudit = bundle.indexOf(
      "building verified catalog release_authority_verify_legacy",
    );
    const auditsComplete = bundle.indexOf(
      "DROP SCHEMA release_authority_verify_legacy CASCADE",
    );
    const catchup = bundle.indexOf(
      "applying packages/platform/release-authority-db/migrations/000002_transactional_service_transition/migration.sql",
      auditsComplete,
    );
    expect(canonicalAudit).toBeGreaterThan(-1);
    expect(legacyAudit).toBeGreaterThan(canonicalAudit);
    expect(auditsComplete).toBeGreaterThan(legacyAudit);
    expect(catchup).toBeGreaterThan(auditsComplete);
    expect(bundle.slice(canonicalAudit, auditsComplete)).not.toContain(
      "CREATE TABLE release_authority_verify_canonical.service_transition",
    );
    expect(bundle.slice(legacyAudit, auditsComplete)).not.toContain(
      "CREATE TABLE release_authority_verify_legacy.service_transition",
    );
    expect(
      bundle.indexOf("UPDATE release_authority_catalog_verification", catchup),
    ).toBeGreaterThan(catchup);
    expect(
      createHash("sha256")
        .update(
          readFileSync(
            "packages/platform/release-authority-db/legacy-catalog/000001_release_authority/migration.sql",
          ),
        )
        .digest("hex"),
    ).toBe("e88a7cc8f29e91a86434bf14b4051f1fb17b5df02f8fc2dae6ec63d5792b398b");
    expect(
      createHash("sha256")
        .update(
          readFileSync(
            "packages/platform/release-authority-db/legacy-catalog/000002_external_effect_protocol/migration.sql",
          ),
        )
        .digest("hex"),
    ).toBe("cd50e36c2b357fe03a81204b99f38c5c1e6b9ff94660dfecb9a2fccb782a512e");
  });
  it("serializes ACL rows canonically without passing empty arrays to aclexplode", () => {
    expect(releaseAuthorityAclFingerprintSql).toContain(
      "jsonb_agg(jsonb_build_object(",
    );
    expect(releaseAuthorityAclFingerprintSql).toContain("'grantor'");
    expect(releaseAuthorityAclFingerprintSql).toContain("'grantee'");
    expect(releaseAuthorityAclFingerprintSql).toContain("'privilege_type'");
    expect(releaseAuthorityAclFingerprintSql).toContain("'is_grantable'");
    expect(releaseAuthorityAclFingerprintSql).toContain(
      "WHEN acl.grantee=0 THEN 'PUBLIC'",
    );
    expect(releaseAuthorityAclFingerprintSql).toContain(
      "acl.privilege_type,acl.is_grantable),'[]'::jsonb",
    );
    expect(releaseAuthorityAclFingerprintSql).toContain(
      "pg_catalog.cardinality(p_acl)>0",
    );
    expect(releaseAuthorityAclFingerprintSql).toContain("ELSE NULL::aclitem[]");
    expect(releaseAuthorityAclFingerprintSql).not.toContain(
      "jsonb_build_array",
    );
    expect(releaseAuthorityCatalogFingerprintSql).toContain(
      `\n${releaseAuthorityAclFingerprintSql}\n\nCREATE OR REPLACE FUNCTION pg_temp.release_authority_catalog_fingerprint`,
    );
    expect(releaseAuthorityCatalogFingerprintSql).not.toContain(
      "'{}'::aclitem[]",
    );
    expect(
      releaseAuthorityCatalogFingerprintSql.match(
        /pg_temp\.release_authority_acl_fingerprint\(/gu,
      ),
    ).toHaveLength(6);
    expect(releaseAuthorityCatalogFingerprintSql).toContain(
      "coalesce(nspacl,pg_catalog.acldefault('n',nspowner))",
    );
    expect(releaseAuthorityCatalogFingerprintSql).toContain(
      "coalesce(procedure.proacl,pg_catalog.acldefault('f',procedure.proowner))",
    );
    expect(releaseAuthorityCatalogFingerprintSql).toContain(
      "coalesce(type_record.typacl,pg_catalog.acldefault('T',type_record.typowner))",
    );
  });
  it("emits the complete production catalog fingerprint SQL", () => {
    const bundle = releaseAuthorityMigrationBundle("incremental-upgrade");
    const fingerprintStart = bundle.indexOf(
      "CREATE TEMP TABLE release_authority_catalog_verification",
    );
    const fingerprintEnd = bundle.indexOf(
      "\\if :authority_schema_absent",
      fingerprintStart,
    );

    expect(fingerprintStart).toBeGreaterThan(-1);
    expect(fingerprintEnd).toBeGreaterThan(fingerprintStart);
    const fingerprint = bundle.slice(fingerprintStart, fingerprintEnd).trim();
    expect(fingerprint).toContain(
      "verifier text NOT NULL CHECK (verifier IN ('complete_catalog_v1','complete_catalog_v5_provider_root_pin'))",
    );
    expect(fingerprint).toContain("SELECT 'default_acl', p_schema");
    expect(fingerprint).toContain("pg_catalog.pg_default_acl default_acl");
    expect(fingerprint).toContain("default_acl.defaclobjtype=ANY");
    expect(fingerprint).toContain("SELECT 'schema', p_schema");
    expect(fingerprint).toContain("SELECT 'relation', relation.relname");
    expect(fingerprint).toContain(
      "SELECT 'function', procedure.oid::regprocedure::text",
    );
    expect(fingerprint).toContain("SELECT 'type', type_record.typname");
  });
  it("keeps published 000010 immutable and appends hardened recovery and provider permits", () => {
    const published = readFileSync(
      "packages/platform/release-authority-db/migrations/000010_recovery_effect_permits/migration.sql",
      "utf8",
    );
    expect(createHash("sha256").update(published).digest("hex")).toBe(
      "a7f1f5063b83f53dfd95dda6bf70740fd2e586dbed368903d7098190cf6200fd",
    );
    const migration = readFileSync(
      "packages/platform/release-authority-db/migrations/000012_provider_mutation_resource_fence/migration.sql",
      "utf8",
    );
    expect(migration).toContain("release_recovery_effect_consume");
    expect(migration).toContain("release_recovery_effect_validate_execution");
    expect(migration).toContain("execution_receipt_sha256");
    expect(migration).toContain("state='executing'");
    expect(migration).toContain("release_recovery_effect_reconcile");
    expect(migration).toContain("release_late_job_recovery_effect_gate");
    expect(migration).toContain("release_recovery_checkpoint_permit_gate");
    expect(migration).toContain("state='forward_repair'");
    expect(migration).toContain("gen_random_uuid()");
    expect(migration).not.toContain("gen_random_bytes");
    expect(migration).toContain("provider_resource_lease");
    expect(migration).toContain("receipt_id");
    expect(migration).toContain("provider mutation terminal replay conflict");
    const recover = migration.slice(
      migration.indexOf(
        "CREATE FUNCTION release_authority.release_provider_mutation_recover",
      ),
      migration.indexOf(
        "CREATE FUNCTION release_authority.release_provider_mutation_consume",
      ),
    );
    expect(
      recover.indexOf("FROM release_authority.provider_resource_lease"),
    ).toBeLessThan(recover.indexOf("FROM release_authority.provider_mutation"));
  });
  it("appends the immutable phase-aware application manifest protocol", () => {
    const migration = readFileSync(
      "packages/platform/release-authority-db/migrations/000013_phase_aware_application_manifest/migration.sql",
      "utf8",
    );
    expect(migration).toContain("release_rollout_claim_transition");
    expect(migration).toContain("release_migration_begin");
    expect(migration).toContain("release_migration_complete");
    expect(migration).toContain("release_migration_fail");
    expect(migration).toContain("target_generation_claim");
    expect(migration).toContain("postCatalogDigest");
    expect(migration).toContain(
      "jsonb_array_length(transition->'orderedMigrationEntries') < 1",
    );
    expect(migration).toContain("transition-'transitionSha256'");
    expect(migration).toContain(
      "pg_catalog.pg_input_is_valid(receipt->>'observedAt','timestamptz')",
    );
    expect(migration).toContain(
      "char_length(receipt->>'receiptId') NOT BETWEEN 3 AND 512",
    );
    expect(migration).toContain(
      "receipt->>'receiptId' !~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]*$'",
    );
    expect(migration).not.toContain("{2,511}");
    expect(migration).not.toContain("'timestamptz'::pg_catalog.regtype");
  });
  it("binds immutable source evidence and its second-observation cutoff in migration 14", () => {
    const migration = readFileSync(
      "packages/platform/release-authority-db/migrations/000014_source_ambiguity_migration_permit/migration.sql",
      "utf8",
    );
    expect(migration).toContain(
      "CREATE TABLE release_authority.release_migration_evidence",
    );
    expect(migration).toContain("release_migration_evidence_immutable_guard");
    expect(migration).toContain(
      "(source_evidence->'observations'->1->>'observedAt')::timestamptz",
    );
    expect(migration).toContain(
      "release migration source evidence digest invalid",
    );
    expect(migration).toContain(
      "release migration source evidence replay conflict",
    );
    expect(migration).toContain(
      "permit-'sourceLegacyAmbiguity'-'eligibilityCutoff'",
    );
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION release_authority.release_migration_begin_v13(jsonb)",
    );
    expect(migration).toContain("DO $schema_version_marker$");
    expect(migration).toContain(
      "marker||pg_catalog.jsonb_build_object('schemaVersion',14)",
    );
    expect(migration).not.toContain("clock_timestamp()");
  });
  it.each(["fresh-install", "incremental-upgrade"] as const)(
    "persists the authoritative schema version in the %s catalog attestation",
    (mode) => {
      const bundle = releaseAuthorityMigrationBundle(mode);
      expect(bundle).toContain("DO $schema_version_marker$");
      expect(bundle).toContain("'schemaVersion',16");
      const finalCatalog = bundle.indexOf("DO $final_catalog$");
      const finalMarker = bundle.indexOf("'schemaVersion',16", finalCatalog);
      expect(finalCatalog).toBeGreaterThan(-1);
      expect(finalMarker).toBeGreaterThan(finalCatalog);
      expect(bundle.indexOf("COMMIT;", finalMarker)).toBeGreaterThan(
        finalMarker,
      );
    },
  );
  it("keeps generated PostgreSQL regex bounds within the ARE limit", () => {
    const bundle = releaseAuthorityMigrationBundle("fresh-install");
    const bounds = [...bundle.matchAll(/\{(\d+)(?:,(\d+))?\}/gu)];
    expect(bounds.length).toBeGreaterThan(0);
    for (const bound of bounds) {
      const upper = Number(bound[2] ?? bound[1]);
      expect(
        upper,
        `unsupported PostgreSQL regex bound ${bound[0]}`,
      ).toBeLessThanOrEqual(255);
    }
  });
  it("removes implicit PUBLIC usage from the declared authority type", () => {
    const migration = readFileSync(
      "packages/platform/release-authority-db/migrations/000011_default_and_final_acl_exactness/migration.sql",
      "utf8",
    );
    expect(migration).toContain(
      "REVOKE ALL ON TYPE release_authority.aggregate_state FROM PUBLIC",
    );
  });
  it("applies the complete ordered migration chain exactly once in one transaction", () => {
    expect(releaseAuthorityMigrationPaths).toEqual([
      "packages/platform/release-authority-db/migrations/000001_release_authority/migration.sql",
      "packages/platform/release-authority-db/migrations/000002_external_effect_protocol/migration.sql",
      "packages/platform/release-authority-db/migrations/000002_transactional_service_transition/migration.sql",
      "packages/platform/release-authority-db/migrations/000003_partial_source_freeze/migration.sql",
      "packages/platform/release-authority-db/migrations/000004_selective_source_recovery/migration.sql",
      "packages/platform/release-authority-db/migrations/000005_late_runner_effects/migration.sql",
      "packages/platform/release-authority-db/migrations/000006_runner_provider_creation_boundary/migration.sql",
      "packages/platform/release-authority-db/migrations/000007_compensation_effect_fence/migration.sql",
      "packages/platform/release-authority-db/migrations/000008_trigger_helper_acl/migration.sql",
      "packages/platform/release-authority-db/migrations/000009_authority_history_and_forward_repairs/migration.sql",
      "packages/platform/release-authority-db/migrations/000010_recovery_effect_permits/migration.sql",
      "packages/platform/release-authority-db/migrations/000011_default_and_final_acl_exactness/migration.sql",
      "packages/platform/release-authority-db/migrations/000012_provider_mutation_resource_fence/migration.sql",
      "packages/platform/release-authority-db/migrations/000013_phase_aware_application_manifest/migration.sql",
      "packages/platform/release-authority-db/migrations/000014_source_ambiguity_migration_permit/migration.sql",
      "packages/platform/release-authority-db/migrations/000015_migration_credential_lease/migration.sql",
      "packages/platform/release-authority-db/migrations/000016_quiescence_before_backup/migration.sql",
    ]);
    expect(
      releaseAuthorityMigrationPaths
        .slice(0, -2)
        .map((path) =>
          createHash("sha256").update(readFileSync(path)).digest("hex"),
        ),
    ).toEqual([
      "eb4039b43228a07c241593d4d6dd863eceac7731d5898b0264e9bc67b3d746cf",
      "66a1cd48303f31691596ae4e64d952d0fe3543444d042b17243c1a60efb10201",
      "5f52fdc1fcf6e37fabe9a69908d3c4e4bf82dfa6ab24c6b2ee9c4f3cda2a1099",
      "02dcd03e3d86c362598537e2ac7afc1dff2d20713fa01158f65e02db621d0da5",
      "c86e2546a9e135f5b23142a2ef1eb70bc12a0b41345f29abd5d2e5b7cbcaed97",
      "35db45ebd364e6f8cbeafbfb0ab6ac0056fe7e51de2b5fe844b91f1207ba1cfb",
      "4ee3a75a1528870df6d66a24eded9fc588aed2681b82aef57335ad7bbadf1260",
      "99e384395f93e2c82ea900fdfd86a810f5067bfafec5c32fe5ccd7d51a8d93a9",
      "550e7c1e5f11bd795a867c03873d09a6b681c559f07b2101b8e8a3dbea3408c8",
      "bc2fb62a012ad9676ce696a5652abc8d29f2110243f0072dc75bcdcfb0ac8e25",
      "a7f1f5063b83f53dfd95dda6bf70740fd2e586dbed368903d7098190cf6200fd",
      "727a6615bb6c1af3aee4e69ed33648726b581adb4f4b2f7610be9f5518347420",
      "095ce8c8859c8ddf51a526aeee2673f1f84853f2c479cef7cb92871ef749554a",
      "c14c52ce2594f49a23663a22a16ca789454e059bdb9abd6070d1b773cc847465",
      "09f6f3eb861a6610492ba77af708911afbdfee5ded5d82cd6e26f1ce32b9658a",
    ]);
    const bundle = releaseAuthorityMigrationBundle("fresh-install");
    const first = bundle.indexOf("CREATE SCHEMA release_authority");
    const second = bundle.indexOf("ADD COLUMN effect_state");
    const third = bundle.indexOf(
      "CREATE TABLE release_authority.service_transition",
    );
    const fourth = bundle.indexOf(
      "CREATE TABLE release_authority.source_freeze_observation",
    );
    const fifth = bundle.indexOf(
      "CREATE TRIGGER release_source_resume_rollout_ownership_guard",
    );
    const sixth = bundle.indexOf("rolloutStateAtPersistence");
    const seventh = bundle.indexOf("runner_job_provider_creation_boundary");
    const eighth = bundle.indexOf("release_compensation_effects_are_safe");
    const ninth = bundle.indexOf(
      "REVOKE ALL ON FUNCTION release_authority.release_service_transition_immutable() FROM PUBLIC;",
      eighth,
    );
    const tenth = bundle.indexOf(
      "CREATE TABLE release_authority.schema_migration",
      ninth,
    );
    const eleventh = bundle.indexOf(
      "CREATE TABLE release_authority.recovery_effect",
      tenth,
    );
    const twelfth = bundle.indexOf(
      "REVOKE ALL ON TYPE release_authority.aggregate_state FROM PUBLIC",
      eleventh,
    );
    const thirteenth = bundle.indexOf(
      "CREATE TABLE release_authority.provider_resource_lease",
      twelfth,
    );
    const fourteenth = bundle.indexOf(
      "CREATE TABLE release_authority.target_generation_claim",
      thirteenth,
    );
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
    expect(fourth).toBeGreaterThan(third);
    expect(fifth).toBeGreaterThan(fourth);
    expect(sixth).toBeGreaterThan(fifth);
    expect(seventh).toBeGreaterThan(sixth);
    expect(eighth).toBeGreaterThan(seventh);
    expect(ninth).toBeGreaterThan(eighth);
    expect(tenth).toBeGreaterThan(ninth);
    expect(eleventh).toBeGreaterThan(tenth);
    expect(twelfth).toBeGreaterThan(eleventh);
    expect(thirteenth).toBeGreaterThan(twelfth);
    expect(fourteenth).toBeGreaterThan(thirteenth);
    expect(bundle.match(/^BEGIN;$/gmu)).toHaveLength(1);
    expect(bundle.match(/^COMMIT;$/gmu)).toHaveLength(1);
    expect(bundle.match(/CREATE SCHEMA release_authority/gu)).toHaveLength(4);
    expect(bundle.match(/ADD COLUMN effect_state/gu)).toHaveLength(4);
    expect(
      bundle.match(/CREATE TABLE release_authority\.service_transition \(/gu),
    ).toHaveLength(2);
    expect(
      bundle.match(
        /CREATE FUNCTION release_authority\.release_source_freeze_prepare/gu,
      ),
    ).toHaveLength(2);
    expect(
      bundle.match(
        /CREATE FUNCTION release_authority\.release_source_freeze_complete/gu,
      ),
    ).toHaveLength(2);
  });

  it("keeps clean fresh install, clean upgrade, and idempotent replay deterministic", () => {
    const fresh = releaseAuthorityMigrationBundle("fresh-install");
    const upgrade = releaseAuthorityMigrationBundle("incremental-upgrade");
    expect(releaseAuthorityMigrationBundle("fresh-install")).toBe(fresh);
    expect(releaseAuthorityMigrationBundle("incremental-upgrade")).toBe(
      upgrade,
    );
    for (const bundle of [fresh, upgrade]) {
      expect(bundle).toContain("authority_forward_11_present");
      expect(bundle).toContain("authority_forward_12_present");
      expect(bundle).toContain("authority_forward_13_present");
      expect(bundle).toContain("authority_forward_14_present");
      expect(bundle).toContain("authority_forward_16_present");
      expect(bundle).toContain("authority_forward_17_present");
      expect(bundle).toContain(
        "release authority forward migration 14 already present",
      );
      expect(bundle).toContain(
        "release authority final object ACL matrix mismatch",
      );
      expect(bundle.match(/^COMMIT;$/gmu)).toHaveLength(1);
    }
  });

  it("compares the exact fresh and 000012-to-000014 ACL states", () => {
    const contract = readFileSync(
      "packages/platform/release-authority-db/test-contract.sh",
      "utf8",
    );
    expect(contract).toContain(
      "000011_default_and_final_acl_exactness \\\n  000012_provider_mutation_resource_fence",
    );
    expect(contract).toContain("(13,'000012_provider_mutation_resource_fence'");
    expect(contract).toContain(
      "SELECT 'column',relation.oid::regclass::text||'.'||attribute.attname",
    );
    expect(contract).toContain(
      "SELECT 'default_acl',default_acl.defaclobjtype::text",
    );
    expect(contract).toContain(
      'test "$upgrade_acl_state" = "$fresh_acl_state"',
    );
  });

  it("binds the migration cutoff to source observation[1] and declares every 000014 ACL object", () => {
    const migration = readFileSync(
      "packages/platform/release-authority-db/migrations/000014_source_ambiguity_migration_permit/migration.sql",
      "utf8",
    );
    expect(migration).toContain(
      "(source_evidence->'observations'->1->>'observedAt')::timestamptz",
    );
    expect(migration).not.toContain(
      "date_trunc('milliseconds',transaction_timestamp())",
    );
    const bundle = releaseAuthorityMigrationBundle("fresh-install");
    expect(bundle).toContain("release_migration_evidence");
    for (const helper of [
      "release_migration_begin_v13",
      "release_migration_checkpoint_v13",
      "release_migration_complete_v13",
      "release_migration_fail_v13",
    ])
      expect(bundle).toContain(helper);
  });

  it("builds the activation target from the canonical pre-release application fixture", () => {
    const contract = readFileSync(
      "packages/platform/release-authority-db/test-contract.sh",
      "utf8",
    );
    expect(contract).toContain("resolvePreReleaseMigrationExclusions");
    expect(contract).toContain(
      "pnpm --filter @reviewrouter/platform-db exec prisma migrate deploy",
    );
    expect(contract).toContain(
      "CREATE DATABASE rr_activation_target OWNER reviewrouter_role_bootstrap",
    );
    expect(contract).not.toContain('CREATE TABLE public."_prisma_migrations"');
    expect(contract.indexOf("prisma migrate deploy")).toBeLessThan(
      contract.indexOf("activationAuthorityProvisioningSql()"),
    );
  });

  it("keeps the static migration ledger identical to the immutable file bytes", () => {
    expect(
      releaseAuthorityMigrationManifest.map(
        ([migrationName, checksumSha256]) => ({
          migrationName,
          checksumSha256,
        }),
      ),
    ).toEqual(
      releaseAuthorityMigrationPaths.map((path) => ({
        migrationName: path.split("/").at(-2),
        checksumSha256: `sha256:${createHash("sha256")
          .update(readFileSync(path))
          .digest("hex")}`,
      })),
    );
    const bundle = releaseAuthorityMigrationBundle("incremental-upgrade");
    expect(bundle).toContain("authority_forward_11_present");
    expect(bundle).toContain("authority_forward_12_present");
    expect(bundle).toContain("authority_forward_13_present");
    expect(bundle).toContain("authority_forward_14_present");
    expect(bundle).toContain("release authority migration history mismatch");
    expect(bundle).toContain("position=1) IS DISTINCT FROM");
    expect(bundle).toContain("VALUES (11, '000010_recovery_effect_permits'");
    expect(bundle).toContain(
      "VALUES (12, '000011_default_and_final_acl_exactness'",
    );
    expect(bundle).toContain(
      "VALUES (13, '000012_provider_mutation_resource_fence'",
    );
    expect(bundle).toContain(
      "VALUES (14, '000013_phase_aware_application_manifest'",
    );
  });

  it("requires rollout-owned suspension evidence for every source resume", () => {
    const migration = readFileSync(
      "packages/platform/release-authority-db/migrations/000004_selective_source_recovery/migration.sql",
      "utf8",
    );
    expect(migration).toContain(
      "release source resume lacks rollout suspension evidence",
    );
    expect(migration).toContain("release source recovery manifest mismatch");
    expect(migration).toContain("freeze_observation.phase = 'suspended'");
    expect(migration).toContain("checkpoint.step='source_resumed'");
  });
});
