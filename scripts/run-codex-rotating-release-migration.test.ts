import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  liveV70V72CatalogDigestSha256 as fencedLiveV70V72CatalogDigestSha256,
  fencedLiveV70V72CatalogDigestSql,
} from "../packages/features/release-rollout/src/adapters/live-v70-v72-catalog-digest.mjs";
import { canonicalReleaseMigrationArtifact } from "../packages/features/release-rollout/src/domain/release-migration-transition";
import { sha256Canonical } from "../packages/features/release-rollout/src/domain/release-rollout";
import {
  adaptGuardedMigrationForSchemaOwner,
  activationAuthorityProvisioningSql,
  atomicMigrationAndGrantSql,
  activationPrincipalRoleCapabilityMatrix,
  assertCanonicalRoleTopology,
  canonicalActivationCatalogPolicyCandidateSql,
  canonicalRoleTopologyObservationSql,
  canonicalDatabaseGenerationObservationSql,
  executeCanonicalReleaseMigration,
  executeCanonicalRoleBootstrap,
  liveV70V72CatalogDigestSha256,
  liveV70V72CatalogDigestSql,
  isActivationPrincipalRoleCapabilityPermitted,
  resolveReleaseMigrationConfiguration,
  resolveRoleBootstrapConfiguration,
  roleProvisioningSql,
  providerRuntimeUpdateColumns,
  rotatingEvidenceTables,
  runReleaseMigrationSubprocess,
  runtimeGrantSql,
  stripAtomicMigrationEnvelope,
} from "./run-codex-rotating-release-migration.mjs";

const legacyEvidenceUnsigned = {
  schemaVersion: 1 as const,
  rolloutId: "rollout-test",
  sourceSystemIdentifier: "100",
  sourceDatabaseName: "review_router",
  sourceRecoveryWitnessSha256: "b".repeat(64),
  authorityPrincipal: "source_admin",
  fenceId: "source-fence:rollout-test",
  fenceEstablishedAt: "2026-08-15T00:00:00.000Z",
  fencedInventorySha256: `sha256:${"f".repeat(64)}`,
  inventorySha256:
    "sha256:ee9ab3e1f9d9f0e88e96addb3a20b70a04a166f0d979fd5ce3fc59e1dcdbf55f",
  activeLeaseIds: [],
  fetchedSetupIds: [],
  pendingIntentIds: [],
  intentStatuses: [],
  observations: [
    {
      observedAt: "2026-08-15T00:00:01.000Z",
      inventorySha256:
        "sha256:ee9ab3e1f9d9f0e88e96addb3a20b70a04a166f0d979fd5ce3fc59e1dcdbf55f",
    },
    {
      observedAt: "2026-08-15T00:00:02.000Z",
      inventorySha256:
        "sha256:ee9ab3e1f9d9f0e88e96addb3a20b70a04a166f0d979fd5ce3fc59e1dcdbf55f",
    },
  ],
  eligibilityCutoff: "2026-08-15T00:00:02.000Z",
  stable: true,
} as const;
const legacyEvidence = {
  ...legacyEvidenceUnsigned,
  receiptSha256: `sha256:${sha256Canonical(legacyEvidenceUnsigned)}`,
} as const;

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
    REVIEW_ROUTER_ROLLOUT_ID: "rollout-test",
    REVIEW_ROUTER_MIGRATION_PERMIT_TARGET_SYSTEM_IDENTIFIER: "200",
    REVIEW_ROUTER_MIGRATION_PERMIT_TARGET_RECOVERY_WITNESS_SHA256: "c".repeat(
      64,
    ),
    REVIEW_ROUTER_MIGRATION_PERMIT_TRANSITION_SHA256: `sha256:${"d".repeat(64)}`,
    REVIEW_ROUTER_MIGRATION_PERMIT_PREVIOUS_RECEIPT_SHA256: `sha256:${"e".repeat(64)}`,
    REVIEW_ROUTER_MIGRATION_PERMIT_EPOCH: "1",
    REVIEW_ROUTER_MIGRATION_PERMIT_NONCE: "f".repeat(32),
    REVIEW_ROUTER_MIGRATION_PERMIT_SOURCE_LEGACY_AMBIGUITY_BASE64URL:
      Buffer.from(JSON.stringify(legacyEvidence)).toString("base64url"),
    REVIEW_ROUTER_MIGRATION_PERMIT_ELIGIBILITY_CUTOFF:
      "2026-08-15T00:00:02.000Z",
  };
}

const migrationPermit = () => ({
  rolloutId: "rollout-test",
  targetSystemIdentifier: "200",
  targetRecoveryWitnessSha256: "c".repeat(64),
  transitionSha256: `sha256:${"d".repeat(64)}`,
  previousReceiptSha256: `sha256:${"e".repeat(64)}`,
  epoch: "1",
  nonce: "f".repeat(32),
  sourceLegacyAmbiguity: legacyEvidence,
  eligibilityCutoff: "2026-08-15T00:00:02.000Z",
});

describe("application database release-authority isolation", () => {
  it("skips legacy owner transfers without granting schema-owner role reachability", () => {
    const legacy =
      "IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reviewrouter_release_migration') THEN\n  SELECT 1;\nEND IF;";
    expect(
      adaptGuardedMigrationForSchemaOwner(
        legacy,
        "000064_codex_oauth_versioned_secret_namespaces",
      ),
    ).toContain(
      "AND pg_has_role(current_user, 'reviewrouter_release_migration', 'SET') THEN",
    );
    expect(adaptGuardedMigrationForSchemaOwner(legacy, "000070_other")).toBe(
      legacy,
    );
    expect(() =>
      adaptGuardedMigrationForSchemaOwner(
        "SELECT 1;",
        "000066_codex_oauth_rotating_cascade_authority",
      ),
    ).toThrow(
      "release_migration_schema_owner_compatibility_invalid:000066_codex_oauth_rotating_cascade_authority",
    );
  });

  it("strips only a valid top-level migration transaction envelope", () => {
    expect(
      stripAtomicMigrationEnvelope(
        "BEGIN;\nSELECT 1;\nCOMMIT;\n\n-- trailing rationale\n",
        "wrapped",
      ),
    ).toBe("SELECT 1;\n\n-- trailing rationale\n");
    expect(stripAtomicMigrationEnvelope("SELECT 1;\n", "unwrapped")).toBe(
      "SELECT 1;\n",
    );
  });

  it("rejects ambiguous migration transaction envelopes", () => {
    expect(() =>
      stripAtomicMigrationEnvelope(
        "BEGIN;\nSELECT 1;\nCOMMIT;\nCOMMIT;\n",
        "duplicate-commit",
      ),
    ).toThrow(
      "release_migration_transaction_envelope_invalid:duplicate-commit",
    );
    expect(() =>
      stripAtomicMigrationEnvelope(
        "BEGIN;\nSELECT 1;\nCOMMIT;\nSELECT 2;\n",
        "content-after-commit",
      ),
    ).toThrow(
      "release_migration_transaction_envelope_invalid:content-after-commit",
    );
  });

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
  it("binds capture to a structured live disposable-database attestation", () => {
    const sql = canonicalActivationCatalogPolicyCandidateSql(
      resolveReleaseMigrationConfiguration(environment()),
      "rr-disposable-activation-policy-test",
    );

    expect(sql).toContain("ROLLBACK;");
    expect(sql).toContain(
      "reviewrouter.activation_catalog_candidate_capture = 'disposable-only'",
    );
    const authoritySql = activationAuthorityProvisioningSql();
    expect(authoritySql).toContain("disposableCaptureAttestation");
    expect(authoritySql).toContain(
      "reviewrouter-disposable-database-attestation-v1",
    );
    expect(authoritySql).toContain("systemIdentifier");
    expect(authoritySql).toContain("databaseOid");
    expect(authoritySql).toContain("recoveryWitnessSha256");
    expect(authoritySql).toContain("nonce");
    expect(sql).not.toContain("install_activation_permit");
    expect(sql).not.toContain("activate_generation");
  });

  it("provisions only target-local activation capability", () => {
    const sql = activationAuthorityProvisioningSql();
    expect(sql).toContain("reviewrouter_activation.activation_permit");
    expect(sql).toContain("reviewrouter_activation.activation_receipt");
    expect(sql).toContain("expected_post_manifest_identity");
    expect(sql).toContain("expected_post_catalog_digest");
    expect(sql).toContain("The database owns the receipt");
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
      new Set([
        ...loginNames,
        "reviewrouter_activation_receipt_guard",
        "reviewrouter_release_schema_owner",
      ]),
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
      "WHERE capability.enabled\n      AND reachable.login_name <> 'reviewrouter_role_bootstrap'\n      AND NOT coalesce(",
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
      schemaOwner: {
        username: "reviewrouter_release_schema_owner",
        login: false,
        superuser: false,
        createDatabase: false,
        createRole: false,
        replication: false,
        bypassRls: false,
        migrationCanSet: false,
        bootstrapCanSet: false,
      },
      ownership: {
        databaseOwner: "reviewrouter_role_bootstrap",
        publicSchemaOwner: "reviewrouter_release_schema_owner",
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
        bootstrapMemberships: observation.bootstrapMemberships.map((entry) => ({
          ...entry,
          grantor: "reviewrouter_release_schema_owner",
        })),
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
        bootstrapMemberships: [
          ...observation.bootstrapMemberships,
          {
            granted: "reviewrouter_release_schema_owner",
            member: "reviewrouter_role_bootstrap",
            grantor: "platform_role_authority",
            adminOption: true,
            inheritOption: false,
            setOption: false,
          },
        ],
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
    const ownerAuthorizedInitialProjection = roleProvisioningSql(
      configuration,
      { ownerAuthorizedInitialRuntimeGateClosed: true },
    );
    const grants = runtimeGrantSql(configuration);
    expect(grants).toContain("BEGIN;");
    const activationAuthority = activationAuthorityProvisioningSql();
    const atomicMigration = atomicMigrationAndGrantSql(configuration, {
      migrationPermit: migrationPermit(),
      legacyReconciliation: {
        evidence: legacyEvidence,
      },
    });
    const gateClosedAtomicMigration = atomicMigrationAndGrantSql(
      configuration,
      {
        gateClosed: true,
        migrationPermit: migrationPermit(),
        legacyReconciliation: {
          evidence: legacyEvidence,
        },
      },
    );
    expect(atomicMigration).toContain(
      canonicalReleaseMigrationArtifact.postManifestIdentity,
    );
    expect(fencedLiveV70V72CatalogDigestSql).toContain(
      canonicalReleaseMigrationArtifact.postManifestIdentity,
    );
    expect(fencedLiveV70V72CatalogDigestSql).toContain(
      "000072_retire_superseded_codex_setup_claims",
    );
    expect(activationAuthority).toContain(
      "reviewrouter_activation.migration_permit",
    );
    expect(activationAuthority).toContain(
      "DO $schema_owner_membership_convergence$",
    );
    expect(activationAuthority).toContain("GRANTED BY %I CASCADE");
    expect(activationAuthority).toContain(
      "release schema owner membership convergence failed",
    );
    expect(activationAuthority).toContain(
      "OR edge.grantor IN (guard.oid, installer.oid, reader.oid)",
    );
    const schemaOwnerConvergence = "DO $schema_owner_membership_convergence$";
    const schemaOwnerHandoff =
      "GRANT reviewrouter_release_schema_owner TO reviewrouter_role_bootstrap\n  WITH ADMIN TRUE, INHERIT FALSE, SET TRUE;";
    const schemaOwnerHandoffGate = "DO $schema_owner_handoff$";
    expect(activationAuthority).toContain(schemaOwnerHandoff);
    expect(activationAuthority).not.toContain("GRANTED BY CURRENT_ROLE");
    expect(activationAuthority).not.toContain(
      "schema_owner_handoff_normalization",
    );
    expect(activationAuthority).not.toContain("grantor.rolname<>current_role");
    expect(activationAuthority).toContain("LIMIT 16");
    expect(activationAuthority).toContain("left(coalesce(string_agg(format(");
    expect(activationAuthority).toContain("bounded role/flag summary:");
    expect(activationAuthority).toContain(schemaOwnerHandoffGate);
    expect(activationAuthority.indexOf(schemaOwnerConvergence)).toBeLessThan(
      activationAuthority.indexOf(schemaOwnerHandoff),
    );
    expect(activationAuthority.indexOf(schemaOwnerHandoff)).toBeLessThan(
      activationAuthority.indexOf(schemaOwnerHandoffGate),
    );
    const receiptReaderReset =
      "REVOKE ALL ON ALL FUNCTIONS IN SCHEMA reviewrouter_activation FROM reviewrouter_activation_receipt_reader";
    const migrationReceiptReaderGrant =
      "GRANT EXECUTE ON FUNCTION reviewrouter_activation.read_migration_receipt(text,bigint,text)";
    expect(activationAuthority).toContain(receiptReaderReset);
    expect(activationAuthority).toContain(migrationReceiptReaderGrant);
    expect(activationAuthority.indexOf(receiptReaderReset)).toBeLessThan(
      activationAuthority.lastIndexOf(migrationReceiptReaderGrant),
    );
    expect(
      activationAuthority.slice(
        activationAuthority.indexOf(receiptReaderReset),
      ),
    ).toContain(migrationReceiptReaderGrant);
    const manifestIdentityRevoke =
      "REVOKE ALL ON FUNCTION reviewrouter_activation.read_activation_migration_manifest_identity()";
    const manifestIdentityGrant =
      "GRANT EXECUTE ON FUNCTION reviewrouter_activation.read_activation_migration_manifest_identity()";
    expect(activationAuthority).toContain(manifestIdentityRevoke);
    expect(activationAuthority).toContain(manifestIdentityGrant);
    expect(
      activationAuthority.lastIndexOf(manifestIdentityRevoke),
    ).toBeLessThan(activationAuthority.lastIndexOf(manifestIdentityGrant));
    const finalManifestIdentityGrant = activationAuthority.slice(
      activationAuthority.lastIndexOf(manifestIdentityGrant),
      activationAuthority.indexOf(
        "-- Install the schema-owner ACL projectors",
        activationAuthority.lastIndexOf(manifestIdentityGrant),
      ),
    );
    expect(finalManifestIdentityGrant).not.toContain(
      "reviewrouter_release_schema_owner",
    );
    expect(finalManifestIdentityGrant).toContain(
      "reviewrouter_activation_permit_installer",
    );
    expect(finalManifestIdentityGrant).toContain(
      "reviewrouter_activation_receipt_reader",
    );
    for (const unrelatedLogin of [
      "reviewrouter_api",
      "reviewrouter_web",
      "reviewrouter_worker",
      "reviewrouter_codex_effect_authority",
      "reviewrouter_role_bootstrap",
    ])
      expect(finalManifestIdentityGrant).not.toContain(unrelatedLogin);
    for (const routine of [
      "install_migration_permit",
      "consume_migration_permit",
      "complete_migration_permit",
      "terminalize_migration_permit",
    ])
      expect(activationAuthority).toContain(routine);
    expect(atomicMigration).toContain(
      "CALL public.reviewrouter_execute_release_migration",
    );
    expect(atomicMigration).not.toContain("consume_migration_permit");
    expect(atomicMigration).not.toContain("complete_migration_permit");
    expect(atomicMigration).toContain("false::boolean");
    expect(gateClosedAtomicMigration).toContain("true::boolean");
    expect(gateClosedAtomicMigration).not.toContain(
      'REVOKE CONNECT ON DATABASE :"DBNAME"',
    );
    expect(provisioning).toContain(
      "requested_inventory_sha256 !~ '^sha256:[a-f0-9]{64}$'",
    );
    expect(provisioning).not.toContain(
      "activation_authority_boundary:schema_owner_manifest_identity_execute_missing",
    );
    expect(provisioning).toContain(
      "activation_authority_boundary:unrelated_principal_manifest_identity_execute_present",
    );
    expect(provisioning).toContain(
      "activation_authority_boundary:required_manifest_identity_execute_missing",
    );
    const activationBoundaryStart = provisioning.indexOf(
      "DO $activation_authority_boundary$",
    );
    const activationBoundary = provisioning.slice(
      activationBoundaryStart,
      provisioning.indexOf(
        "$activation_authority_boundary$;",
        activationBoundaryStart,
      ),
    );
    expect(activationBoundary).toContain("DECLARE failed_invariant text;");
    for (const representativeReason of [
      "activation_permit_relation_missing",
      "install_activation_permit_routine_missing",
      "activation_receipt_owner_mismatch",
      "release_migration_install_activation_permit_execute_present",
      "receipt_reader_activation_receipt_select_present",
      "bootstrap_activation_receipt_select_present",
      "schema_owner_complete_migration_permit_execute_missing",
      "release_migration_read_migration_receipt_execute_missing",
    ])
      expect(activationBoundary).toContain(
        `failed_invariant := '${representativeReason}'`,
      );
    const stableBoundaryReasons = Array.from(
      activationBoundary.matchAll(/failed_invariant := '([a-z_]+)'/gu),
      (match) => match[1],
    );
    expect(stableBoundaryReasons).toHaveLength(51);
    expect(new Set(stableBoundaryReasons).size).toBe(
      stableBoundaryReasons.length,
    );
    expect(activationBoundary).toContain(
      "acl.grantee='reviewrouter_role_bootstrap'::regrole",
    );
    expect(activationBoundary).not.toContain(
      "has_table_privilege('reviewrouter_role_bootstrap','reviewrouter_activation.activation_receipt','SELECT')",
    );
    expect(activationBoundary).toContain(
      "RAISE EXCEPTION 'activation_authority_boundary:%', failed_invariant;",
    );
    expect(activationBoundary).not.toContain(
      "external activation authority boundary is not installed canonically",
    );
    expect(activationBoundary).not.toMatch(
      /IF to_regclass\('reviewrouter_activation\.activation_permit'\) IS NULL\s+OR/u,
    );
    expect(
      activationBoundary.match(
        /has_function_privilege\(\s+'reviewrouter_activation_receipt_reader',\s+'reviewrouter_activation\.read_migration_receipt\(text,bigint,text\)'/gu,
      ),
    ).toHaveLength(1);
    expect(provisioning).not.toContain(
      "A fresh target may need its first canonical ACL projection",
    );
    expect(ownerAuthorizedInitialProjection).toContain(
      "A fresh target may need its first canonical ACL projection",
    );
    expect(ownerAuthorizedInitialProjection).toContain(
      "REVOKE CONNECT ON DATABASE",
    );
    expect(provisioning).toContain(
      "requested_recovery_witness_sha256 !~ '^[a-f0-9]{64}$'",
    );
    expect(provisioning).not.toMatch(
      /\{64\}\s+LOCK TABLE "CodexOAuthProviderInstance"/u,
    );
    const postCallSql = gateClosedAtomicMigration.slice(
      gateClosedAtomicMigration.indexOf(
        "CALL public.reviewrouter_execute_release_migration",
      ),
      gateClosedAtomicMigration.indexOf(
        "SET LOCAL search_path = pg_catalog, pg_temp",
      ),
    );
    expect(postCallSql).not.toContain("REVOKE ");
    for (const migrationSql of [provisioning, grants, activationAuthority]) {
      expect(migrationSql).toContain(
        "pg_advisory_xact_lock(1381126735, 1129271120)",
      );
      expect(migrationSql).toContain("SET LOCAL lock_timeout = '5000ms'");
    }
    expect(atomicMigration).toContain(
      "SELECT pg_advisory_xact_lock(1381126735, 1129271120)",
    );
    expect(atomicMigration).not.toContain("pg_advisory_xact_lock_shared");
    expect(atomicMigration).not.toContain("\\! pnpm");
    expect(atomicMigration).not.toContain("pg_advisory_unlock");
    expect(atomicMigration.indexOf("BEGIN;")).toBeLessThan(
      atomicMigration.indexOf("pg_advisory_xact_lock(1381126735"),
    );
    expect(
      atomicMigration.indexOf("pg_advisory_xact_lock(1381126735"),
    ).toBeLessThan(
      atomicMigration.indexOf(
        "CALL public.reviewrouter_execute_release_migration",
      ),
    );
    expect(provisioning).toContain("000060_codex_oauth_setup_serialization");
    const reconciliationCall = provisioning.indexOf(
      "CALL public.reviewrouter_reconcile_legacy_ambiguity",
    );
    const migrationExecutorStart = provisioning.indexOf(
      "CREATE OR REPLACE PROCEDURE public.reviewrouter_execute_release_migration",
    );
    const inventoryLock = provisioning.indexOf(
      'LOCK TABLE public."CodexOAuthLease" IN SHARE ROW EXCLUSIVE MODE',
      migrationExecutorStart,
    );
    const migration60 = provisioning.indexOf(
      "'000060_codex_oauth_setup_serialization'",
    );
    const migration61 = provisioning.indexOf(
      "'000061_codex_oauth_provider_mutation_fence'",
    );
    const migration62 = provisioning.indexOf(
      "'000062_codex_oauth_remote_outcome_unknown'",
    );
    const migration64 = provisioning.indexOf(
      "'000064_codex_oauth_versioned_secret_namespaces'",
    );
    const migration65 = provisioning.indexOf(
      "'000065_codex_oauth_authority_acl_hardening'",
    );
    expect(migration60).toBeGreaterThan(-1);
    expect(migrationExecutorStart).toBeGreaterThan(-1);
    expect(inventoryLock).toBeGreaterThan(migrationExecutorStart);
    expect(inventoryLock).toBeLessThan(migration60);
    expect(migration60).toBeLessThan(migration61);
    expect(migration61).toBeLessThan(migration62);
    expect(migration64).toBeLessThan(reconciliationCall);
    expect(reconciliationCall).toBeLessThan(migration65);
    for (const migrationName of [
      "000060_codex_oauth_setup_serialization",
      "000061_codex_oauth_provider_mutation_fence",
      "000062_codex_oauth_remote_outcome_unknown",
    ])
      expect(provisioning.match(new RegExp(migrationName, "gu"))).toHaveLength(
        3,
      );
    expect(atomicMigration.trim().endsWith("COMMIT;")).toBe(true);
    expect(atomicMigration).toContain(liveV70V72CatalogDigestSql);
    for (const catalogSemantic of [
      "attacl",
      "attcollation",
      "attidentity",
      "attgenerated",
      "nspacl",
      "nspowner",
      "relrowsecurity",
      "relforcerowsecurity",
      "relreplident",
      "indisvalid",
      "indisready",
      "indislive",
      "pg_policy",
      "pg_trigger",
      "pg_rewrite",
      "pg_inherits",
    ])
      expect(liveV70V72CatalogDigestSql).toContain(catalogSemantic);
    expect(liveV70V72CatalogDigestSha256).toBe(
      fencedLiveV70V72CatalogDigestSha256,
    );
    expect(fencedLiveV70V72CatalogDigestSql).toContain(
      "read_activation_migration_manifest_identity()",
    );
    expect(fencedLiveV70V72CatalogDigestSql).not.toContain(
      "FROM public._prisma_migrations",
    );
    for (const catalogFact of [
      "'columns'",
      "'constraints'",
      "'indexes'",
      "'relations'",
      "'functions'",
      "'defaultAcl'",
      "'history'",
      "'unresolvedHistory'",
      "'legacyAuthoritySchemaPresent'",
      "pg_get_functiondef",
      "securityDefiner",
      "searchPath",
    ])
      expect(liveV70V72CatalogDigestSql).toContain(catalogFact);
    expect(atomicMigration).toContain(
      "release migration V70-V73 live catalog digest mismatch",
    );
    const observationSql = canonicalRoleTopologyObservationSql();
    const createdRoleIdentities = [
      ...provisioning.matchAll(/CREATE ROLE ([a-z_]+) ([^;]+);/gu),
    ].map(([, username, attributes]) => ({ attributes, username }));
    expect(createdRoleIdentities).toEqual([
      {
        username: "reviewrouter_release_schema_owner",
        attributes:
          "NOLOGIN NOSUPERUSER NOCREATEDB\n      NOCREATEROLE NOREPLICATION NOBYPASSRLS",
      },
      ...[
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
    ]);
    expect(
      provisioning.match(
        /ALTER ROLE [^;]+\b(?:SUPERUSER|NOSUPERUSER|CREATEDB|NOCREATEDB|REPLICATION|NOREPLICATION|BYPASSRLS|NOBYPASSRLS)\b[^;]*;/gu,
      ),
    ).toEqual([
      "ALTER ROLE reviewrouter_role_bootstrap NOSUPERUSER NOCREATEROLE;",
    ]);
    expect(provisioning).not.toContain(
      "ALTER ROLE reviewrouter_activation_receipt_guard",
    );
    expect(provisioning).not.toContain(
      "aclexplode(coalesce(attribute.attacl,'{}'::aclitem[]))",
    );
    expect(provisioning).toContain(
      "SET LOCAL ROLE reviewrouter_release_schema_owner;",
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
    expect(provisioning).toContain("DO $trusted_bootstrap_authority$");
    expect(provisioning).toContain("observed.rolsuper IS DISTINCT FROM true");
    expect(provisioning).toContain(
      "observed.rolcreaterole IS DISTINCT FROM true",
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
    expect(provisioning).not.toContain(
      "GRANT reviewrouter_release_schema_owner TO reviewrouter_role_bootstrap",
    );
    expect(provisioning).toContain(
      "ALTER ROUTINE %s OWNER TO reviewrouter_release_schema_owner",
    );
    expect(provisioning).toContain(
      "GRANT reviewrouter_release_migration TO reviewrouter_role_bootstrap\n  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY CURRENT_ROLE",
    );
    expect(provisioning).toContain(
      "GRANT reviewrouter_release_schema_owner TO reviewrouter_release_migration\n  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE",
    );
    expect(provisioning).toContain(
      "SET LOCAL ROLE reviewrouter_release_migration;",
    );
    expect(provisioning).toContain("DO $release_owner_transfer_edge_cleanup$");
    expect(provisioning).toContain(
      "AND grantor.rolname = 'reviewrouter_role_bootstrap'",
    );
    expect(provisioning).toContain(
      "temporary release owner transfer cleanup or canonical membership failed",
    );
    expect(provisioning).toContain(
      "public ownership convergence did not reach the release schema owner",
    );
    expect(
      provisioning.indexOf(
        "GRANT reviewrouter_release_schema_owner TO reviewrouter_release_migration\n  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE",
      ),
    ).toBeLessThan(
      provisioning.indexOf("SET LOCAL ROLE reviewrouter_release_migration;"),
    );
    expect(
      provisioning.indexOf("SET LOCAL ROLE reviewrouter_release_migration;"),
    ).toBeLessThan(
      provisioning.indexOf("DO $release_owner_transfer_edge_cleanup$"),
    );
    expect(provisioning).not.toContain("REASSIGN OWNED");
    expect(provisioning).toContain(
      "refusing to take over public objects owned by unexpected role",
    );
    expect(provisioning).toContain(
      "refusing non-canonical role membership topology",
    );
    expect(provisioning).toContain("REVOKE %I FROM %I GRANTED BY %I CASCADE");
    expect(provisioning).toContain("count(DISTINCT grantor.oid)");
    expect(provisioning).toContain("DO $schema_owner_membership_cleanup$");
    expect(provisioning).toContain(
      "release schema owner membership survived trusted bootstrap cleanup",
    );
    expect(
      provisioning.indexOf("DO $schema_owner_membership_cleanup$"),
    ).toBeLessThan(
      provisioning.indexOf(
        "ALTER ROLE reviewrouter_role_bootstrap NOSUPERUSER NOCREATEROLE;\nCOMMIT;",
      ),
    );
    expect(provisioning).not.toContain("ALTER DATABASE");
    expect(provisioning).toContain(
      "GRANT CREATE ON DATABASE %I TO reviewrouter_release_schema_owner",
    );
    expect(provisioning).toContain(
      "GRANT TEMPORARY ON DATABASE %I TO reviewrouter_release_schema_owner",
    );
    expect(provisioning).toContain(
      "'reviewrouter_release_schema_owner',current_database(),'TEMP'",
    );
    expect(provisioning).toContain(
      "GRANT CONNECT ON DATABASE %I TO reviewrouter_release_schema_owner WITH GRANT OPTION",
    );
    expect(provisioning).toContain(
      "release migration database delegation is non-canonical",
    );
    expect(provisioning).toContain(
      "GRANT USAGE, CREATE ON SCHEMA public TO reviewrouter_release_schema_owner",
    );
    expect(provisioning).toContain(
      "REVOKE CREATE, TEMPORARY ON DATABASE %I FROM reviewrouter_release_migration",
    );
    expect(provisioning).toContain(
      "CREATE OR REPLACE PROCEDURE public.reviewrouter_execute_release_migration(",
    );
    expect(provisioning).toContain(
      "permit_result := reviewrouter_activation.consume_migration_permit(",
    );
    expect(provisioning).toContain(
      "PERFORM reviewrouter_activation.complete_migration_permit(",
    );
    expect(provisioning).toContain("requested_acl_gate_closed boolean");
    expect(provisioning).toContain(
      "text,text,text,text,text,bigint,text,jsonb,timestamptz,boolean",
    );
    expect(provisioning).toContain(
      "release migration executor ACL gate mode invalid",
    );
    expect(provisioning).toContain(
      "release migration executor replay ACL gate mode conflict",
    );
    expect(provisioning.indexOf("consume_migration_permit(")).toBeLessThan(
      provisioning.indexOf("IF requested_acl_gate_closed THEN"),
    );
    expect(
      provisioning.indexOf("IF requested_acl_gate_closed THEN"),
    ).toBeLessThan(provisioning.indexOf("complete_migration_permit("));
    const guardedExecutorStart = provisioning.indexOf(
      "CREATE OR REPLACE PROCEDURE public.reviewrouter_execute_release_migration(",
    );
    const guardedExecutor = provisioning.slice(
      guardedExecutorStart,
      provisioning.indexOf(
        "REVOKE ALL ON PROCEDURE public.reviewrouter_execute_release_migration(",
        guardedExecutorStart,
      ),
    );
    expect(guardedExecutor).toContain("requested_source_legacy_ambiguity");
    expect(guardedExecutor).toContain("requested_eligibility_cutoff");
    expect(guardedExecutor).toContain(
      "legacy_reconciliation_inventory_changed",
    );
    expect(
      guardedExecutor.indexOf('LOCK TABLE public."CodexOAuthLease"'),
    ).toBeLessThan(guardedExecutor.indexOf("INTO STRICT observed_inventory"));
    expect(
      guardedExecutor.indexOf("INTO STRICT observed_inventory"),
    ).toBeLessThan(
      guardedExecutor.indexOf("legacy_reconciliation_inventory_changed"),
    );
    expect(guardedExecutor).toContain("requested_eligibility_cutoff");
    expect(guardedExecutor).toContain("'{}'::jsonb");
    expect(guardedExecutor).toContain("SET search_path = public, pg_temp");
    expect(guardedExecutor).not.toContain(
      "SET search_path = pg_catalog, public, pg_temp",
    );
    expect(guardedExecutor).not.toContain("postManifestIdentity");
    expect(guardedExecutor).not.toContain("postCatalogDigest");
    expect(guardedExecutor).not.toContain("observed_post_catalog_digest");
    expect(guardedExecutor).not.toMatch(/^(?:BEGIN|COMMIT);$/gmu);
    expect(guardedExecutor).toContain("ON COMMIT DROP");
    expect(
      guardedExecutor.match(
        /AND pg_has_role\(current_user, 'reviewrouter_release_migration', 'SET'\) THEN/gu,
      ),
    ).toHaveLength(2);
    const completionGuardStart = activationAuthority.indexOf(
      "CREATE OR REPLACE FUNCTION reviewrouter_activation.complete_migration_permit(",
    );
    const completionGuard = activationAuthority.slice(
      completionGuardStart,
      activationAuthority.indexOf(
        "ALTER FUNCTION reviewrouter_activation.complete_migration_permit(",
        completionGuardStart,
      ),
    );
    expect(completionGuard).toContain(
      "requested_permit_nonce text, requested_effect_receipt jsonb",
    );
    expect(completionGuard).toContain(
      "DECLARE requested_effect_metadata CONSTANT jsonb := requested_effect_receipt;",
    );
    const liveCompletionInvariants = [
      {
        condition:
          "observed_manifest_identity IS DISTINCT FROM\n       current_permit.expected_post_manifest_identity",
        reason: "manifest_identity_observed",
      },
      {
        condition:
          "observed_catalog_digest IS DISTINCT FROM\n       current_permit.expected_post_catalog_digest",
        reason: "catalog_digest_observed",
      },
      {
        condition:
          "EXISTS (SELECT 1 FROM public._prisma_migrations\n       WHERE finished_at IS NULL AND rolled_back_at IS NULL)",
        reason: "unfinished_migration",
      },
      {
        condition:
          "EXISTS (SELECT 1 FROM public.\"CodexOAuthLease\"\n       WHERE \"status\" IN ('preleased','finalized'))",
        reason: "active_lease",
      },
      {
        condition:
          'EXISTS (SELECT 1 FROM public."CodexOAuthSetupManifest"\n       WHERE "status"=\'fetched\')',
        reason: "fetched_setup_manifest",
      },
      {
        condition:
          "EXISTS (SELECT 1 FROM public.\"CodexOAuthWritebackIntent\"\n       WHERE \"status\" IN ('pending','remote_outcome_unknown'))",
        reason: "unresolved_writeback_intent",
      },
    ] as const;
    let previousReasonIndex = -1;
    for (const { condition, reason } of liveCompletionInvariants) {
      const conditionIndex = completionGuard.indexOf(condition);
      const message = `release migration target live completion mismatch:${reason}`;
      const reasonIndex = completionGuard.indexOf(message);
      expect(conditionIndex, `${reason} condition was lost`).toBeGreaterThan(
        -1,
      );
      expect(reasonIndex, `${reason} reason was lost`).toBeGreaterThan(
        conditionIndex,
      );
      expect(
        completionGuard.match(new RegExp(message, "gu")),
        `${reason} must remain deterministic and unique`,
      ).toHaveLength(1);
      expect(reasonIndex, `${reason} evaluation order changed`).toBeGreaterThan(
        previousReasonIndex,
      );
      previousReasonIndex = reasonIndex;
    }
    expect(completionGuard).toContain(
      "requested_effect_metadata IS DISTINCT FROM '{}'::jsonb",
    );
    expect(completionGuard).toContain("The database owns the receipt");
    expect(completionGuard).toContain(
      "'legacyReconciliation',jsonb_build_object(",
    );
    expect(completionGuard).toContain("current_permit.eligibility_cutoff");
    expect(completionGuard).toContain(
      "(current_permit.source_legacy_ambiguity->>'inventorySha256')||':'||",
    );
    expect(completionGuard).not.toContain(
      "current_permit.source_legacy_ambiguity->>'inventorySha256'||':'||",
    );
    expect(activationAuthority).toContain(
      "release migration target source evidence catalog invalid",
    );
    expect(activationAuthority).toContain(
      "evidence_attribute.atttypid IS DISTINCT FROM 'jsonb'::pg_catalog.regtype",
    );
    expect(activationAuthority).toContain(
      "evidence_attribute.attnotnull IS DISTINCT FROM true",
    );
    expect(completionGuard).toContain(
      "'acknowledgement','all_prior_installers_and_writers_are_stopped'",
    );
    expect(completionGuard).not.toContain(
      "requested_effect_metadata->>'postManifestIdentity'",
    );
    expect(completionGuard).not.toContain(
      "requested_effect_metadata->>'postCatalogDigest'",
    );
    expect(completionGuard).not.toContain("manifest_identity_receipt");
    expect(completionGuard).not.toContain("catalog_digest_receipt");
    expect(completionGuard).toContain(
      "'postManifestIdentity',observed_manifest_identity",
    );
    expect(completionGuard).toContain(
      "'postCatalogDigest',observed_catalog_digest",
    );
    expect(completionGuard).toContain(
      "'expected=%s observed=%s',\n        current_permit.expected_post_catalog_digest,observed_catalog_digest",
    );
    expect(
      completionGuard.match(
        /release migration target live completion mismatch:[a-z_]+/gu,
      ),
    ).toHaveLength(liveCompletionInvariants.length);
    expect(completionGuard).not.toContain(
      "RAISE EXCEPTION 'release migration target live completion mismatch';",
    );
    expect(provisioning).toContain(
      "GRANT EXECUTE ON PROCEDURE public.reviewrouter_execute_release_migration(\n  text,text,text,text,text,bigint,text,jsonb,timestamptz,boolean) TO reviewrouter_release_migration;",
    );
    expect(provisioning).not.toContain(
      "GRANT EXECUTE ON PROCEDURE public.reviewrouter_execute_release_migration(\n  text,text,text,text,text,bigint,text,jsonb,boolean) TO reviewrouter_release_migration;",
    );
    expect(provisioning).not.toContain(
      "GRANT EXECUTE ON FUNCTION reviewrouter_activation.consume_migration_permit(text,text,text,text,text,jsonb,timestamptz,bigint,text) TO reviewrouter_release_migration",
    );
    expect(grants).toContain(
      "ALTER DEFAULT PRIVILEGES FOR ROLE reviewrouter_release_schema_owner",
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
    expect(grants).toContain(
      'REVOKE ALL ON TABLE public."RuntimeGenerationWitnessProof" FROM reviewrouter_api',
    );
    expect(grants).toContain(
      "ALTER FUNCTION public.reviewrouter_runtime_generation_write_read_canary(TEXT, TEXT)\n  SET search_path TO pg_catalog, public, pg_temp",
    );
    expect(activationAuthority).toContain("'RuntimeGenerationWitnessProof'");
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
          superuser: true,
          createDatabase: false,
          createRole: true,
          replication: false,
          bypassRls: false,
        });
      if (step === "verify_bootstrap_demotion")
        return JSON.stringify({
          currentUser: "reviewrouter_role_bootstrap",
          sessionUser: "reviewrouter_role_bootstrap",
          login: true,
          superuser: false,
          createDatabase: false,
          createRole: false,
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
          schemaOwner: {
            username: "reviewrouter_release_schema_owner",
            login: false,
            superuser: false,
            createDatabase: false,
            createRole: false,
            replication: false,
            bypassRls: false,
            migrationCanSet: false,
            bootstrapCanSet: false,
          },
          ownership: {
            databaseOwner: "reviewrouter_role_bootstrap",
            publicSchemaOwner: "reviewrouter_release_schema_owner",
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
      if (step.startsWith("legacy_ambiguity_inventory_"))
        return JSON.stringify({
          activeLeaseIds: [],
          fetchedSetupIds: [],
          pendingIntentIds: [],
          intentStatuses: [],
        });
      if (step === "read_target_migration_receipt")
        return JSON.stringify({
          legacyReconciliation: {
            version: 1,
            acknowledgement: "all_prior_installers_and_writers_are_stopped",
            inventory: {
              activeLeaseIds: [],
              fetchedSetupIds: [],
              pendingIntentIds: [],
              intentStatuses: [],
            },
            inventorySha256: legacyEvidence.inventorySha256,
            stableSamples: 2,
            after: {
              activeLeaseIds: [],
              fetchedSetupIds: [],
              pendingIntentIds: [],
              intentStatuses: [],
            },
            status: "reconciled",
          },
        });
      return step === "migration_history_preflight" ? "preflight" : "";
    };
    executeCanonicalRoleBootstrap(environment(), run);
    expect(calls.map((call) => call.step)).toEqual([
      "verify_bootstrap_authority",
      "provision_roles",
      "verify_bootstrap_demotion",
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
      "read_target_migration_receipt",
      "legacy_ambiguity_inventory_after",
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
