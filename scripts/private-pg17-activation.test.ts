import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  activationAuthorityProvisioningSql,
  activationRoutineBodyTrustRoots,
  canonicalActivationCatalogPolicyCandidateSql,
  canonicalActivationSql,
  effectivePrincipalInventorySqlSha256,
  roleProvisioningSql,
  runtimeGrantStatements,
} from "./run-codex-rotating-release-migration.mjs";
import { effectivePrincipalInventorySql } from "../packages/features/release-rollout/src/index.ts";
import { fencedLiveV70V72CatalogDigestSql } from "../packages/features/release-rollout/src/adapters/live-v70-v72-catalog-digest.mjs";

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
      role: "comment-token-custody",
      username: "reviewrouter_comment_token_custody",
      password: "custody-pass",
    },
    {
      role: "effect-authority",
      username: "reviewrouter_codex_effect_authority",
      password: "effect-pass",
    },
  ],
  releasePassword: "release-pass",
  releaseUrl:
    "postgresql://reviewrouter_release_migration:release-pass@db.internal:5432/review_router",
  applicationSchemas: ["public"],
};
const forgedLegacyPrincipalEvidence = {
  beforePrincipalInventory: { version: 1, forgedClean: true },
  beforePrincipalInventorySha256: `sha256:${"1".repeat(64)}`,
};

describe("target-local PG17 activation permit", () => {
  it("canonicalizes the live digest search path across invoker and definer contexts", () => {
    expect(fencedLiveV70V72CatalogDigestSql).not.toContain("set_config(");
    expect(fencedLiveV70V72CatalogDigestSql).toContain(
      "pg_catalog.pg_get_functiondef",
    );
  });
  it("publishes deterministic non-secret routine-body trust roots", () => {
    const roots = activationRoutineBodyTrustRoots();
    expect(roots.installerRoutineBodySha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(roots.readerRoutineBodySha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(roots.installerRoutineBodySha256).not.toBe(
      roots.readerRoutineBodySha256,
    );
  });

  it("pins the exact principal inventory projection used inside activation", () => {
    expect(
      createHash("sha256").update(effectivePrincipalInventorySql).digest("hex"),
    ).toBe(effectivePrincipalInventorySqlSha256);
    expect(effectivePrincipalInventorySql).toContain(
      "'default:'||pg_get_userbyid(defaults.defaclrole)",
    );
    expect(effectivePrincipalInventorySql).toContain("pg_default_acl defaults");
    expect(effectivePrincipalInventorySql).toContain("pg_largeobject_metadata");
    expect(effectivePrincipalInventorySql).toContain("attribute.attacl");
    expect(effectivePrincipalInventorySql).toContain("routine.proacl");
    expect(effectivePrincipalInventorySql).toContain("database.datacl");
    expect(effectivePrincipalInventorySql).toContain("acl.is_grantable");
    expect(effectivePrincipalInventorySql).toContain(
      "pg_get_userbyid(acl.grantor)",
    );
    expect(effectivePrincipalInventorySql).toContain("'roleReachability'");
    expect(effectivePrincipalInventorySql).toContain("pg_has_role(");
    expect(effectivePrincipalInventorySql).toContain("'rowSecurity'");
    expect(effectivePrincipalInventorySql).toContain("policy.polroles");
    expect(effectivePrincipalInventorySql).toContain("policy.polqual");
    expect(effectivePrincipalInventorySql).toContain("policy.polwithcheck");
    expect(effectivePrincipalInventorySql).toContain(
      "namespace.nspname !~ '^pg_temp_'",
    );
  });

  it("gives the dedicated installer only the permit installation capability", () => {
    const sql = activationAuthorityProvisioningSql();
    expect(sql).toContain("reviewrouter_activation.install_activation_permit");
    expect(sql).toContain(
      "session_user <> 'reviewrouter_activation_permit_installer'",
    );
    expect(sql).toContain(
      "REVOKE ALL ON ALL TABLES IN SCHEMA reviewrouter_activation FROM reviewrouter_activation_permit_installer",
    );
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION reviewrouter_activation.install_activation_permit",
    );
    expect(sql).toContain(
      "'GRANT CONNECT ON DATABASE %I TO reviewrouter_activation_permit_installer;'",
    );
    expect(sql).toContain(
      "'reviewrouter_activation_permit_installer', current_database(), 'CONNECT'",
    );
    expect(sql).toContain(
      "'reviewrouter_activation_permit_installer', current_database(), 'TEMP'",
    );
    expect(sql).toContain("acl.privilege_type = 'CONNECT'");
    expect(sql).toContain("acl.is_grantable");
    expect(sql).not.toContain(
      "GRANT CONNECT ON DATABASE %I TO reviewrouter_activation_permit_installer WITH GRANT OPTION",
    );
    expect(sql).not.toContain("GRANT reviewrouter_activation_receipt_guard TO");
    expect(sql).not.toContain(
      "CREATE ROLE reviewrouter_activation_receipt_guard",
    );
  });

  it("canonicalizes every public routine before checking reader privileges", () => {
    const sql = activationAuthorityProvisioningSql();
    const canonicalizer = sql.slice(
      sql.indexOf("DO $public_routine_acl$"),
      sql.indexOf("DO $installer_database_acl$"),
    );
    expect(canonicalizer).toContain("FROM pg_proc catalog_routine");
    expect(canonicalizer).toContain("namespace.nspname = 'public'");
    expect(canonicalizer).toContain(
      "REVOKE ALL PRIVILEGES ON ROUTINE %s FROM reviewrouter_activation_receipt_reader",
    );
    expect(canonicalizer).toContain("REVOKE EXECUTE ON ROUTINE %s FROM PUBLIC");
    expect(sql.indexOf("DO $public_routine_acl$")).toBeLessThan(
      sql.indexOf("DO $installer_database_acl$"),
    );
    expect(sql).toContain(
      "has_function_privilege(\n           'reviewrouter_activation_receipt_reader', routine.oid, 'EXECUTE'",
    );
    expect(sql).toContain(
      "coalesce(routine.proacl, acldefault('f', routine.proowner))",
    );
    expect(sql).toContain("acl.grantee = 0");
    expect(sql).toContain("acl.privilege_type = 'EXECUTE'");
  });

  it("makes exact install replay idempotent and rejects a conflicting tuple", () => {
    const sql = activationAuthorityProvisioningSql();
    expect(sql).toContain("ON CONFLICT (rollout_id) DO NOTHING");
    expect(sql).toContain("WHERE rollout_id = requested_rollout_id FOR UPDATE");
    expect(sql).toContain("RETURN false;");
    expect(sql).toContain("activation permit conflicts with installed tuple");
    expect(sql).toContain("UNIQUE (permit_epoch, permit_nonce)");
    expect(sql).toContain("preactivation_catalog_policy_sha256");
    expect(sql).toContain("activated_catalog_policy_sha256");
    expect(sql).toContain("reviewrouter-activation-catalog-policy");
    expect(sql).toContain(
      "existing.preactivation_catalog_policy = requested_preactivation_catalog_policy",
    );
  });

  it("compares independently projected exact catalog and effective facts", () => {
    const sql = activationAuthorityProvisioningSql();
    expect(sql).toContain("'catalogPolicy',projected_catalog_policy");
    expect(sql).toContain("WITH RECURSIVE canonical_principals");
    expect(sql).toContain("relevance_seed(name)");
    expect(sql).toContain("normalized_memberships");
    expect(sql).toContain("'kind','external-bootstrap-authority'");
    expect(sql).toContain("bootstrap_membership_grantor_not_inert");
    expect(sql).toContain("bootstrap_membership_grantor_mismatch");
    expect(sql).toContain("unexpected_relevant_membership");
    expect(sql).toContain(
      "ON membership.member=relevant.name OR membership.role=relevant.name",
    );
    expect(sql).toContain(
      "member IN (SELECT name FROM relevant)\n       OR role IN (SELECT name FROM relevant)",
    );
    expect(sql).toContain(
      "Memberships are the authoritative exact edge inventory",
    );
    expect(sql).toContain("(edge->>'setOption')::boolean");
    expect(sql).toContain("(edge->>'inheritOption')::boolean");
    expect(sql).toContain("(edge->>'adminOption')::boolean");
    expect(sql).toContain(
      `reviewrouter_activation.canonical_json(edge->'grantor') COLLATE "C"`,
    );
    expect(sql).toContain("to_jsonb('external-bootstrap-authority'::text)");
    expect(sql).toContain("IF jsonb_array_length(policy_violations) <> 0");
    expect(sql).toContain("'catalogPolicy',NULL");
    expect(sql).toContain("'rowSecurity',projected_inventory->'rowSecurity'");
    expect(sql).toContain("normalized_extensions");
    expect(sql).toContain("'external-provider-authority'");
    expect(sql).toContain("'extensions'");
    expect(sql).toContain("unsupported_catalog_authority");
    expect(sql).toContain("unsupported_acl_privilege");
    expect(sql).toContain("unexpected_grant_principal");
    expect(sql).toContain(
      "grant_record->>'principal' IS DISTINCT FROM 'PUBLIC'\n      AND NOT EXISTS (SELECT 1 FROM allowed_principals",
    );
    expect(sql).toContain(
      "The inventory\n    -- grant union contains direct/default ACLs plus ownership and role\n    -- attributes",
    );
    expect(sql).toContain("unexpected_extension_owner");
    expect(sql).toContain("unexpected_external_grantor");
    expect(sql).toContain(
      "grant_record->>'source'='attribute'\n        AND (grant_record->>'grantable')::boolean",
    );
    expect(sql).toContain("edge->>'grantor'=grant_record->>'grantor'");
    expect(sql).not.toContain(
      "SELECT principal FROM grant_facts WHERE principal <> 'PUBLIC'",
    );
    expect(sql).toContain("'effectivePermissions'");
    expect(
      sql.match(/reachable\.login_name <> 'reviewrouter_role_bootstrap'/gu),
    ).toHaveLength(2);
    expect(sql).toContain(
      "catalog_policy IS DISTINCT FROM permit.preactivation_catalog_policy",
    );
    expect(sql).toContain(
      "live_activated_catalog_policy IS DISTINCT FROM permit.activated_catalog_policy",
    );
    expect(sql).toContain(
      "RAISE EXCEPTION 'activation catalog policy mismatch'",
    );
  });

  it("captures candidates without permit or activation authority", () => {
    const sql = canonicalActivationCatalogPolicyCandidateSql(
      configuration,
      "rr-disposable-activation-policy-test",
    );
    expect(sql).toContain("BEGIN;");
    expect(sql).toContain("capture_catalog_policy_candidate_pair()");
    expect(activationAuthorityProvisioningSql()).toContain(
      "activation catalog policy candidate target invalid",
    );
    expect(activationAuthorityProvisioningSql()).toContain(
      "activation catalog policy candidate disposable marker invalid",
    );
    for (const attestationFact of [
      "disposableCaptureAttestation",
      "reviewrouter-disposable-database-attestation-v1",
      "systemIdentifier",
      "databaseOid",
      "recoveryWitnessSha256",
      "nonce",
    ])
      expect(activationAuthorityProvisioningSql()).toContain(attestationFact);
    expect(activationAuthorityProvisioningSql()).toContain(
      "session_user <> 'reviewrouter_release_migration'",
    );
    expect(activationAuthorityProvisioningSql()).toContain(
      "USING DETAIL = reviewrouter_activation.canonical_json(\n        projection->'policy'->'violations'",
    );
    expect(sql).toContain(
      "reviewrouter.activation_catalog_candidate_capture = 'disposable-only'",
    );
    expect(sql).not.toContain("GRANT CONNECT");
    expect(sql).toContain("ROLLBACK;");
    expect(sql).not.toContain("install_activation_permit");
    expect(sql).not.toContain("stage_principal_evidence");
    expect(sql).not.toContain("activate_generation");
    expect(
      sql.match(/capture_catalog_policy_candidate_pair\(\)/gu),
    ).toHaveLength(1);
  });

  it("keeps the PG17 fixture production-shaped and permit proof pinned", () => {
    const source = readFileSync(
      new URL("./private-pg17-activation-adversarial.test.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("POSTGRES_USER=${providerAdminUsername}");
    expect(source).not.toContain("POSTGRES_USER=${adminUsername}");
    expect(source).toContain("disposablePg17TargetRoleFoundationSql({");
    expect(source).toContain(
      'providerAdminUsername = "disposable_provider_admin"',
    );
    expect(source).toContain(
      "NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
    );
    expect(source).toContain("disposablePg17CanonicalRoleBootstrapSetupSql()");
    expect(source).toContain("roleProvisioningSql(configuration, {");
    expect(source).toContain("ownerAuthorizedInitialRuntimeGateClosed: true");
    expect(
      source.indexOf(
        "canonicalRoleBootstrapSetup.publicTableAclCanonicalization",
      ),
    ).toBeLessThan(
      source.indexOf(
        "canonicalRoleBootstrapSetup.activationAuthorityProvisioning",
      ),
    );
    expect(source).not.toContain(
      "canonicalRoleBootstrapSetup.bootstrapDemotion",
    );
    expect(source.indexOf("roleProvisioningSql(configuration, {")).toBeLessThan(
      source.indexOf("atomicMigrationAndGrantSql(configuration, {"),
    );
    const seedInitializer = source.slice(
      source.indexOf("const initializeSeed = () =>"),
      source.indexOf("type CaseContext"),
    );
    expect(seedInitializer).not.toContain("runtimeGrantSql(");
    expect(
      seedInitializer.indexOf("ownerAuthorizedInitialRuntimeGateClosed: true"),
    ).toBeLessThan(
      seedInitializer.indexOf("const expectedPostCatalogDigest ="),
    );
    expect(
      seedInitializer.indexOf("const expectedPostCatalogDigest ="),
    ).toBeLessThan(
      seedInitializer.indexOf(
        "reviewrouter_activation.install_migration_permit(",
      ),
    );
    expect(
      seedInitializer.indexOf(
        "reviewrouter_activation.install_migration_permit(",
      ),
    ).toBeLessThan(
      seedInitializer.indexOf("atomicMigrationAndGrantSql(configuration, {"),
    );
    expect(source).toContain('"@reviewrouter/platform-db"');
    expect(source).toContain('"db:migrate:deploy"');
    expect(source).toContain("clone immutable production-shaped seed");
    expect(source).toContain(
      "const reactivateDisposableAdversarialAdminOffline =",
    );
    expect(source).toContain(
      "ALTER ROLE ${adversarialAdminUsername}\n       NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
    );
    expect(source).toContain('"postgres",\n      "--single"');
    expect(
      source.indexOf("reactivateDisposableAdversarialAdminOffline(volume)"),
    ).toBeLessThan(source.indexOf("startContainer(container, volume, false)"));
    expect(source).toContain(
      "const trustedBootstrap = arrange?.(context) === true;",
    );
    expect(
      source.indexOf("const trustedBootstrap = arrange?.(context) === true;"),
    ).toBeLessThan(
      source.indexOf("lockDownProvider(context, { trustedBootstrap });"),
    );
    expect(source).toContain(
      "canonicalActivationCatalogPolicies.preactivation.policy",
    );
    expect(source).toContain(
      "canonicalActivationCatalogPolicies.activated.sha256",
    );
    expect(source).not.toContain(
      "project_effective_principal_authority('preactivation')->'catalogPolicy' AS before_policy",
    );
    expect(source).toContain("const psqlAs = (");
    expect(source).toContain("session_user || '|' || current_user");
    expect(source).not.toContain("SET SESSION AUTHORIZATION");
    expect(source).not.toContain("activation_attack_target");
    const preReadinessAclProof = source.slice(
      source.indexOf(
        '"rejects a disconnected NOLOGIN role with a direct application ACL before trust-root readiness"',
      ),
      source.indexOf(
        '"rejects a second bootstrap grantor and an extra relevant edge"',
      ),
    );
    expect(preReadinessAclProof).toContain("CREATE ROLE rr_inert_acl NOLOGIN");
    expect(preReadinessAclProof).toContain(
      "GRANT SELECT ON ${applicationRelation} TO rr_inert_acl",
    );
    expect(preReadinessAclProof).toContain("attestDisposableCaptureSql()");
    expect(preReadinessAclProof).toContain("captureCandidateSql()");
    expect(source).toContain(
      "'rr-disposable-'||encode(pg_catalog.sha256(convert_to(",
    );
    expect(source).not.toMatch(/(?<!pg_catalog\.)sha256\(convert_to\(/u);
    expect(source).toContain(
      "shobj_description(oid,'pg_database')::jsonb\n    ->'disposableCaptureAttestation'->>'identity'",
    );
    expect(source).not.toContain(
      "const attestDisposableCaptureSql = (identity: string)",
    );
    expect(source).toContain(
      '"rejects durable binding and mismatched database identity before activation proof"',
    );
    expect(source).toContain('databaseOid: "0"');
    expect(source).toContain(
      '"omits a disconnected role only while it has no application authority"',
    );
    expect(source).toContain("another_disconnected_provider_role");
  });

  it("gives the guard only migration history and completion-status reads", () => {
    const sql = activationAuthorityProvisioningSql();
    expect(sql).toContain(
      "IF to_regclass('public._prisma_migrations') IS NULL",
    );
    expect(sql).toContain(
      'GRANT SELECT ON TABLE public."_prisma_migrations" TO reviewrouter_activation_receipt_guard',
    );
    expect(sql).toContain(
      "'reviewrouter_activation_receipt_guard', 'public._prisma_migrations', 'SELECT'",
    );
    expect(sql).toContain(
      "ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']",
    );
    expect(sql).toContain(
      "ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']",
    );
    expect(sql).toContain("relation.relname <> '_prisma_migrations'");
    expect(sql).toContain(
      "'reviewrouter_activation_permit_installer', relation.oid",
    );
    expect(sql).toContain(
      'GRANT SELECT ("status") ON TABLE public."CodexOAuthLease"',
    );
    expect(sql).toContain(
      "has_column_privilege('reviewrouter_activation_receipt_guard',relation.oid",
    );
    expect(sql).toContain("IS DISTINCT FROM (attribute.attname='status')");
    expect(sql).not.toMatch(
      /GRANT\s+(?:INSERT|UPDATE|DELETE|ALL).*_prisma_migrations.*reviewrouter_activation_receipt_guard/iu,
    );
  });

  it("locks, validates, grants, consumes and receipts in one transaction", () => {
    const authority = activationAuthorityProvisioningSql();
    const activation = canonicalActivationSql(configuration, {
      rolloutId: "rollout-activation-1",
      ...forgedLegacyPrincipalEvidence,
    });
    expect(authority).toContain(
      "FROM reviewrouter_activation.activation_permit\n  WHERE rollout_id = requested_rollout_id FOR UPDATE",
    );
    expect(authority).toContain("FROM pg_catalog.pg_control_system()");
    expect(authority).toContain("current_setting('server_version_num')");
    expect(authority).toContain("FROM public._prisma_migrations");
    expect(authority).toContain(
      "read_activation_migration_manifest_identity()",
    );
    expect(authority).toContain(
      "TO reviewrouter_activation_permit_installer, reviewrouter_activation_receipt_reader",
    );
    expect(authority).toContain("reviewrouter_release_migration;");
    expect(authority).not.toContain(
      "reviewrouter_release_migration, reviewrouter_release_schema_owner",
    );
    expect(authority).toContain(
      "evidence->>'commit' = permit.expected_commit_sha",
    );
    expect(authority).toContain("WITH runtime_roles(role_name, role_kind)");
    expect(authority).toContain("has_table_privilege(role_name,tables.oid");
    expect(authority).toContain("has_column_privilege(role_name,relation.oid");
    expect(authority).toContain(
      "has_sequence_privilege(role_name,sequences.oid",
    );
    expect(authority).toContain(
      "has_function_privilege(role_name,routines.oid",
    );
    expect(authority).toContain(
      "RAISE EXCEPTION 'runtime ACL is not canonical'",
    );
    expect(authority).toContain(
      "'RuntimeGenerationWitnessProof','RuntimeCanaryChallenge','RuntimeCanaryChallengeProof'",
    );
    expect(authority).toContain(
      "proname='reviewrouter_request_runtime_canary_challenge'",
    );
    expect(authority).toContain(
      "proname='reviewrouter_read_runtime_canary_challenge_proofs'",
    );
    expect(authority).toContain(
      "proname='reviewrouter_answer_runtime_canary_challenge'",
    );
    expect(authority).toContain(
      "has_database_privilege('public',current_database(),'CONNECT')",
    );
    expect(authority).toContain("has_table_privilege('public',oid,privilege)");
    expect(authority).toContain("acl.is_grantable");
    expect(authority).toContain(
      "UPDATE reviewrouter_activation.activation_permit\n    SET consumed_at = transaction_timestamp()",
    );
    expect(
      authority.indexOf(
        "INSERT INTO reviewrouter_activation.activation_receipt",
      ),
    ).toBeLessThan(
      authority.indexOf("SET consumed_at = transaction_timestamp()"),
    );
    expect(activation.sql).toContain("BEGIN;");
    expect(activation.sql).not.toContain("GRANT CONNECT");
    expect(activation.sql).toContain(
      "reviewrouter_activation.activate_generation(",
    );
    expect(activation.sql.trim().endsWith("COMMIT;")).toBe(true);
    expect(activation.sql.indexOf("stage_principal_evidence")).toBeLessThan(
      activation.sql.indexOf("activate_generation"),
    );
    expect(
      authority.indexOf(
        "principal evidence is not transaction-bound to activation",
      ),
    ).toBeLessThan(
      authority.indexOf("PERFORM reviewrouter_activation.apply_runtime_acl()"),
    );
    expect(
      authority.indexOf("PERFORM reviewrouter_activation.apply_runtime_acl()"),
    ).toBeLessThan(
      authority.indexOf("project_effective_principal_authority('activated')"),
    );
    expect(activation.sql).not.toContain("forgedClean");
  });

  it("returns the immutable receipt on crash replay and fails closed on torn consume", () => {
    const sql = activationAuthorityProvisioningSql();
    expect(sql).toContain(
      "SELECT * INTO receipt FROM reviewrouter_activation.activation_receipt",
    );
    expect(sql).toContain("activation receipt conflicts with permit replay");
    expect(sql).toContain("activation receipt conflicts with catalog replay");
    expect(
      sql.indexOf("WITH runtime_roles(role_name, role_kind)"),
    ).toBeLessThan(sql.lastIndexOf("IF receipt.rollout_id IS NOT NULL THEN"));
    expect(sql).toContain("consumed activation permit has no receipt");
    expect(sql).toContain("activation permit superseded");
    expect(sql).toContain("newer.permit_epoch > permit.permit_epoch");
    expect(sql).toContain("activation permit consumption raced");
  });

  it("binds independently validated principal evidence to the permit and activation transaction", () => {
    const sql = activationAuthorityProvisioningSql();
    expect(sql).toContain(
      "CREATE TABLE IF NOT EXISTS reviewrouter_activation.activation_principal_evidence",
    );
    expect(sql).toContain(
      "principal_evidence.transaction_id <> txid_current()",
    );
    expect(sql).toContain(
      "project_effective_principal_authority('preactivation')",
    );
    expect(sql).toContain("project_effective_principal_authority('activated')");
    expect(sql).toContain("reviewrouter-effective-principal-projection");
    expect(sql).toContain("reviewrouter-effective-principal-policy");
    expect(sql).toContain("unexpected_login");
    expect(sql).toContain("unexpected_role_usage");
    expect(sql).toContain("unexpected_role_set");
    expect(sql).toContain("unexpected_effective_permission");
    expect(sql).toContain("unexpected_ownership");
    expect(sql).toContain("unexpected_row_security_principal");
    expect(sql).toContain("principal_login_contract_mismatch");
    expect(sql).toContain("projected_inventory->'roleReachability'");
    expect(sql).toContain("unexpected_public_permission");
    expect(sql).toContain("projected_inventory->'rowSecurity'");
    expect(sql).toContain("principal evidence invalid or stale");
    expect(sql).toContain("principal evidence activation update raced");
    expect(sql).toContain(
      "principal evidence is not transaction-bound to activation",
    );
    expect(sql).toContain("activationPrincipalEvidenceContract");
    expect(sql).toContain("principalInventorySqlSha256");
    expect(sql).toContain("principalProjectorBodySha256");
    expect(sql).toContain("principalEvidenceValidatorBodySha256");
    expect(sql).toContain("runtimeAclBodySha256");
    expect(sql).toContain("runtimeAclPolicyPairBodySha256");
    expect(sql).toContain("activateGenerationBodySha256");
    expect(sql).toContain("readActivationReceiptBodySha256");
    expect(sql).toContain("validate_principal_evidence(");
    expect(sql).toContain("requested_rollout_id,receipt.transaction_id");
    expect(sql).toContain(
      "activation receipt principal evidence invalid or legacy",
    );
  });

  it("emits all durable policy and inventory digests on direct and reconstructed receipt paths", () => {
    const sql = activationAuthorityProvisioningSql();
    for (const field of [
      "beforePrincipalInventorySha256",
      "beforePrincipalPolicySha256",
      "activatedPrincipalInventorySha256",
      "activatedPrincipalPolicySha256",
      "preactivationCatalogPolicySha256",
      "activatedCatalogPolicySha256",
    ]) {
      expect(sql.match(new RegExp(`'${field}'`, "gu"))).toHaveLength(2);
    }
    expect(sql).toContain("legacy activation receipt lacks principal evidence");
  });

  it("keeps rollout bootstrap outside guard authority and global ledgers", () => {
    const authority = activationAuthorityProvisioningSql();
    const sql = roleProvisioningSql(configuration);
    expect(authority).toContain(
      "CREATE OR REPLACE FUNCTION reviewrouter_activation.assert_no_activation_receipt()",
    );
    expect(authority).toContain("STABLE SECURITY DEFINER");
    expect(authority).toContain(
      "session_user <> 'reviewrouter_role_bootstrap'",
    );
    expect(authority).toContain(
      "GRANT EXECUTE ON FUNCTION reviewrouter_activation.assert_no_activation_receipt() TO reviewrouter_role_bootstrap",
    );
    expect(authority).not.toMatch(
      /GRANT\s+SELECT\s+ON[^;]*activation_receipt[^;]*TO reviewrouter_role_bootstrap/iu,
    );
    expect(sql).toContain(
      "SELECT reviewrouter_activation.assert_no_activation_receipt();",
    );
    expect(sql).not.toContain(
      "SELECT count(*) FROM reviewrouter_activation.activation_receipt",
    );
    expect(sql).toContain(
      "RAISE EXCEPTION 'activation_authority_boundary:%', failed_invariant",
    );
    expect(sql).toContain(
      "activation_authority_boundary:receipt_reader_migration_receipt_execute_missing",
    );
    expect(sql).not.toContain(
      "activation_authority_boundary:schema_owner_manifest_identity_execute_missing",
    );
    expect(sql).toContain(
      "activation_authority_boundary:unrelated_principal_manifest_identity_execute_present",
    );
    expect(sql).toContain(
      "activation_authority_boundary:required_manifest_identity_execute_missing",
    );
    expect(sql).toContain(
      "activation receipt guard must have no membership edges",
    );
    expect(sql).not.toContain(
      "CREATE ROLE reviewrouter_activation_receipt_guard",
    );
    expect(sql).not.toContain("GRANT reviewrouter_activation_receipt_guard TO");
    expect(sql).not.toContain(
      "CREATE TABLE IF NOT EXISTS reviewrouter_bootstrap.release_rollout_ledger",
    );
    expect(sql).not.toContain(
      "CREATE TABLE IF NOT EXISTS reviewrouter_bootstrap.release_runner_job_ledger",
    );
  });

  it("uses one canonical schema-owner handoff and removes it after role provisioning", () => {
    const authority = activationAuthorityProvisioningSql();
    const provisioning = roleProvisioningSql(configuration);
    const convergence = "DO $schema_owner_membership_convergence$";
    const handoff =
      "GRANT reviewrouter_release_schema_owner TO reviewrouter_role_bootstrap\n  WITH ADMIN TRUE, INHERIT FALSE, SET TRUE;";
    expect(authority).toContain(convergence);
    expect(authority).toContain(handoff);
    expect(
      authority.match(
        /GRANT reviewrouter_release_schema_owner TO reviewrouter_role_bootstrap/gu,
      ),
    ).toHaveLength(1);
    expect(authority).not.toContain("GRANTED BY CURRENT_ROLE");
    expect(authority).not.toContain("schema_owner_handoff_normalization");
    expect(authority.indexOf(convergence)).toBeLessThan(
      authority.indexOf(handoff),
    );
    expect(authority.indexOf(handoff)).toBeLessThan(
      authority.indexOf("DO $schema_owner_handoff$"),
    );
    expect(authority).toContain(
      "AND grantor.rolname<>'reviewrouter_role_bootstrap'",
    );
    expect(authority).toContain("DO $schema_owner_handoff$");
    expect(provisioning).toContain(
      "AND grantor.rolname <> 'reviewrouter_role_bootstrap'\n             AND grantor.rolname <> 'reviewrouter_release_schema_owner'",
    );
    expect(provisioning).toContain("DO $schema_owner_membership_cleanup$");
    expect(provisioning).not.toContain(
      "GRANT reviewrouter_release_schema_owner TO reviewrouter_role_bootstrap",
    );
    expect(provisioning).toContain(
      "release schema owner membership survived trusted bootstrap cleanup",
    );
    expect(provisioning).toContain(
      "ALTER ROLE reviewrouter_role_bootstrap NOSUPERUSER NOCREATEROLE;\nCOMMIT;",
    );
  });

  it("installs owner-only runtime ACL routines behind the no-login guard", () => {
    const provisioning = activationAuthorityProvisioningSql();
    const roleBootstrap = roleProvisioningSql(configuration);
    expect(provisioning).toContain(
      "CREATE OR REPLACE FUNCTION reviewrouter_activation.apply_runtime_acl()",
    );
    expect(provisioning).toContain(
      "CREATE OR REPLACE FUNCTION reviewrouter_activation.capture_runtime_acl_policy_pair()",
    );
    expect(provisioning).toContain(
      "CREATE OR REPLACE FUNCTION reviewrouter_activation.apply_runtime_database_acl(",
    );
    expect(provisioning).toContain(
      "ALTER FUNCTION reviewrouter_activation.apply_runtime_database_acl(text)\n  OWNER TO reviewrouter_role_bootstrap",
    );
    expect(provisioning).toContain(
      "GRANT EXECUTE ON FUNCTION reviewrouter_activation.apply_runtime_database_acl(text)\n  TO reviewrouter_release_schema_owner",
    );
    expect(provisioning).toContain(
      "IF session_user <> 'reviewrouter_release_migration' THEN",
    );
    expect(provisioning).toContain("SECURITY DEFINER");
    expect(provisioning).toContain("SET search_path = pg_catalog, pg_temp");
    expect(provisioning).toContain(
      "OWNER TO reviewrouter_release_schema_owner",
    );
    expect(provisioning).toContain("TO reviewrouter_activation_receipt_guard");
    expect(provisioning).toContain(
      runtimeGrantStatements(configuration, undefined, {
        skipDatabaseAcl: true,
      }),
    );
    expect(provisioning).toContain(
      "PERFORM reviewrouter_activation.apply_runtime_database_acl('activated')",
    );
    expect(provisioning).toContain("USING ERRCODE = 'RRACL'");
    expect(provisioning).toContain("EXCEPTION WHEN SQLSTATE 'RRACL' THEN");
    expect(provisioning).toContain("IF activated_policy IS NULL THEN");
    expect(provisioning).toContain(
      "runtime ACL routine integrity binding invalid",
    );
    expect(provisioning).not.toContain("DECLARE routine record;");
    expect(provisioning).toContain("runtime ACL routine execute ACL invalid");
    expect(provisioning).toContain(
      "REVOKE CREATE ON SCHEMA reviewrouter_activation",
    );
    expect(roleBootstrap).not.toContain(
      "CREATE OR REPLACE FUNCTION reviewrouter_activation.apply_runtime_acl()",
    );
    expect(roleBootstrap).toContain(
      "PERFORM reviewrouter_activation.apply_runtime_database_acl('preactivation')",
    );
    const initialGateBootstrap = roleProvisioningSql(configuration, {
      ownerAuthorizedInitialRuntimeGateClosed: true,
    });
    expect(initialGateBootstrap).toContain(
      'GRANT CONNECT ON DATABASE :"DBNAME" TO reviewrouter_api;',
    );
    expect(initialGateBootstrap).toContain(
      'REVOKE CONNECT ON DATABASE :"DBNAME" FROM reviewrouter_api;',
    );
    expect(initialGateBootstrap).not.toContain(
      "EXECUTE format('GRANT CONNECT ON DATABASE",
    );
    const pairStart = provisioning.indexOf(
      "AS $capture_runtime_acl_policy_pair$",
    );
    const pairEnd = provisioning.indexOf(
      "$capture_runtime_acl_policy_pair$;",
      pairStart + 1,
    );
    const pair = provisioning.slice(pairStart, pairEnd);
    expect(
      pair.indexOf("capture_catalog_policy_candidate('preactivation')"),
    ).toBeLessThan(
      pair.indexOf("PERFORM reviewrouter_activation.apply_runtime_acl()"),
    );
    expect(
      pair.indexOf("PERFORM reviewrouter_activation.apply_runtime_acl()"),
    ).toBeLessThan(
      pair.indexOf("capture_catalog_policy_candidate('activated')"),
    );
  });

  it("rejects authority material from the cutover request surface", () => {
    const activation = canonicalActivationSql(configuration, {
      rolloutId: "rollout-activation-1",
      ...forgedLegacyPrincipalEvidence,
      permitNonce: "caller-controlled",
      permitEpoch: 999,
    });
    expect(activation.sql).not.toContain("caller-controlled");
    expect(activation.sql).not.toContain("999");
    expect(activation.sql).not.toContain(
      "requested_canonical_privileges_sha256",
    );
    expect(activation.sql).not.toContain("forgedClean");
  });

  it("accepts no caller principal-evidence arguments", () => {
    const activation = canonicalActivationSql(configuration, {
      rolloutId: "rollout-activation-1",
    });
    expect(activation.sql).toContain(
      "stage_principal_evidence(\n  'rollout-activation-1'",
    );
    expect(activation.sql).not.toContain("::jsonb");
  });

  it("derives receipt digests from normalized catalog facts", () => {
    const sql = activationAuthorityProvisioningSql();
    expect(sql).toContain("jsonb_build_object('policyVersion',1,'facts'");
    expect(sql).toContain("INTO catalog_acl_facts, acl_is_canonical");
    expect(sql).toContain("canonical_privileges_sha256 := 'sha256:'");
    expect(sql).toContain("catalog_facts_sha256 := 'sha256:'");
    expect(sql).not.toContain("requested_canonical_privileges_sha256");
    expect(sql).toContain(
      "ALTER FUNCTION reviewrouter_activation.activate_generation(text)",
    );
  });

  it("gives the receipt reader only its target-local read capability", () => {
    const sql = activationAuthorityProvisioningSql();
    expect(sql).toContain(
      "activation receipt reader is not pre-provisioned canonically",
    );
    expect(sql).toContain(
      "edge.roleid IN (guard.oid, installer.oid, reader.oid)",
    );
    expect(sql).toContain(
      "'GRANT CONNECT ON DATABASE %I TO reviewrouter_activation_receipt_reader;'",
    );
    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION reviewrouter_activation.read_activation_receipt(",
    );
    expect(sql).toContain("STABLE SECURITY DEFINER");
    expect(sql).toContain(
      "session_user NOT IN ('reviewrouter_activation_receipt_reader','reviewrouter_release_migration')",
    );
    expect(sql).toContain(
      "REVOKE ALL ON ALL TABLES IN SCHEMA reviewrouter_activation FROM reviewrouter_activation_receipt_reader",
    );
    expect(sql).toContain(
      "GRANT USAGE ON SCHEMA reviewrouter_activation TO reviewrouter_activation_receipt_reader",
    );
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION reviewrouter_activation.read_activation_receipt(text) TO reviewrouter_activation_receipt_reader",
    );
    expect(sql).toContain(
      "REVOKE ALL PRIVILEGES ON ROUTINE %s FROM reviewrouter_activation_receipt_reader",
    );
    expect(sql).toContain("REVOKE EXECUTE ON ROUTINE %s FROM PUBLIC");
    expect(sql).toContain("acl.grantee = 0");
    expect(sql).not.toMatch(
      /GRANT\s+SELECT\s+ON[^;]+TO reviewrouter_activation_receipt_reader/iu,
    );
  });
});
