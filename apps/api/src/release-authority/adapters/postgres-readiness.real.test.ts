import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "@reviewrouter/platform-db";
import { releaseAuthoritySchemaIsReady } from "../application/readiness";
import { observeReleaseAuthorityDatabaseReadiness } from "./postgres-readiness";

const adminUrl = process.env.REVIEW_ROUTER_RELEASE_AUTHORITY_ADMIN_TEST_URL;
const controlUrl = process.env.REVIEW_ROUTER_RELEASE_AUTHORITY_CONTROL_TEST_URL;
const legacyControlUrl =
  process.env.REVIEW_ROUTER_RELEASE_AUTHORITY_LEGACY_CONTROL_TEST_URL;
const realDescribe =
  adminUrl && controlUrl ? describe.sequential : describe.skip;

realDescribe("release authority exact catalog readiness", () => {
  const admin = adminUrl ? createPrismaClient({ databaseUrl: adminUrl }) : null;
  const control = controlUrl
    ? createPrismaClient({ databaseUrl: controlUrl })
    : null;
  const legacyControl = legacyControlUrl
    ? createPrismaClient({ databaseUrl: legacyControlUrl })
    : null;
  let owner = "";
  let quotedOwner = "";
  let crossDatabaseControl: ReturnType<typeof createPrismaClient> | null = null;

  beforeAll(async () => {
    if (!admin) throw new Error("real_postgres_test_unconfigured");
    await admin.$executeRawUnsafe(
      "CREATE ROLE reviewrouter_unexpected_acl_probe NOLOGIN",
    );
    await admin.$executeRawUnsafe(
      "CREATE ROLE reviewrouter_owner_membership_probe NOLOGIN",
    );
    await admin.$executeRawUnsafe(
      "CREATE ROLE reviewrouter_inbound_membership_probe LOGIN",
    );
    await admin.$executeRawUnsafe(
      `DO $role$
       BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='reviewrouter quoted acl probe')
         THEN CREATE ROLE "reviewrouter quoted acl probe" NOLOGIN;
         END IF;
       END $role$`,
    );
    const owners = await admin.$queryRawUnsafe<{ owner: string }[]>(
      "SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname='release_authority'",
    );
    owner = owners[0]?.owner ?? "";
    if (!/^[A-Za-z_][A-Za-z0-9_$]*$/u.test(owner))
      throw new Error("real_postgres_authority_owner_invalid");
    quotedOwner = `"${owner.replaceAll('"', '""')}"`;
    await admin.$executeRawUnsafe(
      "DROP DATABASE IF EXISTS reviewrouter_identity_cross_database_probe WITH (FORCE)",
    );
    await admin.$executeRawUnsafe(
      "CREATE DATABASE reviewrouter_identity_cross_database_probe",
    );
    await admin.$executeRawUnsafe(
      "GRANT CONNECT ON DATABASE reviewrouter_identity_cross_database_probe TO reviewrouter_release_control",
    );
    const crossDatabaseUrl = new URL(controlUrl!);
    crossDatabaseUrl.pathname = "/reviewrouter_identity_cross_database_probe";
    crossDatabaseControl = createPrismaClient({
      databaseUrl: crossDatabaseUrl.toString(),
    });
  });

  afterAll(async () => {
    await crossDatabaseControl?.$disconnect();
    if (admin) {
      await admin.$executeRawUnsafe(
        "DROP DATABASE IF EXISTS reviewrouter_identity_cross_database_probe WITH (FORCE)",
      );
      await admin.$executeRawUnsafe(
        `REASSIGN OWNED BY reviewrouter_unexpected_acl_probe TO ${quotedOwner || "postgres"}`,
      );
      await admin.$executeRawUnsafe(
        "DROP OWNED BY reviewrouter_unexpected_acl_probe",
      );
      await admin.$executeRawUnsafe(
        "DROP ROLE IF EXISTS reviewrouter_unexpected_acl_probe",
      );
      await admin.$executeRawUnsafe(
        "DROP OWNED BY reviewrouter_owner_membership_probe",
      );
      await admin.$executeRawUnsafe(
        "DROP ROLE IF EXISTS reviewrouter_owner_membership_probe",
      );
      await admin.$executeRawUnsafe(
        "DROP OWNED BY reviewrouter_inbound_membership_probe",
      );
      await admin.$executeRawUnsafe(
        "DROP ROLE IF EXISTS reviewrouter_inbound_membership_probe",
      );
      await admin.$executeRawUnsafe(
        'DROP OWNED BY "reviewrouter quoted acl probe"',
      );
      await admin.$executeRawUnsafe(
        'DROP ROLE IF EXISTS "reviewrouter quoted acl probe"',
      );
    }
    await Promise.all(
      [admin, control, legacyControl]
        .filter((client) => client !== null)
        .map((client) => client.$disconnect()),
    );
  });

  const readiness = async () => {
    if (!control) throw new Error("real_postgres_test_unconfigured");
    return observeReleaseAuthorityDatabaseReadiness(control);
  };
  const expectCatalogRejected = async () => {
    const observed = await readiness();
    expect(observed.catalogExact).toBe(false);
    expect(releaseAuthoritySchemaIsReady(observed)).toBe(false);
  };

  const expectAclRejected = async () => {
    const observed = await readiness();
    expect(observed.defaultAclExact && observed.finalAclExact).toBe(false);
    expect(releaseAuthoritySchemaIsReady(observed)).toBe(false);
  };
  const expectFinalAclRejected = async () => {
    const observed = await readiness();
    expect(observed.finalAclExact).toBe(false);
    expect(releaseAuthoritySchemaIsReady(observed)).toBe(false);
  };

  it("accepts the canonical PostgreSQL 17 catalog", async () => {
    const observed = await readiness();
    expect(observed).toMatchObject({
      postgresMajor: 17,
      schemaVersion: 11,
      catalogVerifier: "complete_catalog_v3_acl_exact",
      defaultAclExact: true,
      finalAclExact: true,
      catalogExact: true,
      databaseIdentity: {
        serverIdentity: observed.systemIdentifier,
        databaseName: expect.any(String),
        databaseIdentity: expect.stringMatching(/^[0-9]+$/u),
      },
    });
    expect(observed.catalogFingerprint).toBe(
      observed.expectedCatalogFingerprint,
    );
    expect(releaseAuthoritySchemaIsReady(observed)).toBe(true);
  });

  it("distinguishes two databases on the same PostgreSQL 17 cluster", async () => {
    if (!crossDatabaseControl)
      throw new Error("real_postgres_cross_database_test_unconfigured");
    const [authorityDatabase, otherDatabase] = await Promise.all([
      readiness(),
      observeReleaseAuthorityDatabaseReadiness(crossDatabaseControl),
    ]);
    expect(otherDatabase.databaseIdentity.serverIdentity).toBe(
      authorityDatabase.databaseIdentity.serverIdentity,
    );
    expect(otherDatabase.databaseIdentity.databaseIdentity).not.toBe(
      authorityDatabase.databaseIdentity.databaseIdentity,
    );
    expect(otherDatabase.databaseIdentity.databaseName).not.toBe(
      authorityDatabase.databaseIdentity.databaseName,
    );
  });

  it("accepts the documented exact legacy-equivalent catalog history", async () => {
    if (!legacyControl) return;
    const observed =
      await observeReleaseAuthorityDatabaseReadiness(legacyControl);
    expect(observed.catalogExact).toBe(true);
    expect(observed.migrationManifest.slice(0, 2)).toMatchObject([
      { byteVariant: "legacy_equivalent" },
      { byteVariant: "legacy_equivalent" },
    ]);
    expect(releaseAuthoritySchemaIsReady(observed)).toBe(true);
  });

  it.each([
    ["TABLES", "", "SELECT"],
    ["SEQUENCES", "", "USAGE"],
    ["FUNCTIONS", "", "EXECUTE"],
    ["TYPES", "", "USAGE"],
    ["TABLES", "IN SCHEMA release_authority ", "SELECT"],
    ["SEQUENCES", "IN SCHEMA release_authority ", "USAGE"],
    ["FUNCTIONS", "IN SCHEMA release_authority ", "EXECUTE"],
    ["TYPES", "IN SCHEMA release_authority ", "USAGE"],
  ] as const)(
    "rejects malicious %s creating-owner defaults at global/schema scope",
    async (objects, scope, privilege) => {
      if (!admin) throw new Error("real_postgres_test_unconfigured");
      const prefix = `ALTER DEFAULT PRIVILEGES FOR ROLE ${quotedOwner} ${scope}`;
      await admin.$executeRawUnsafe(
        `${prefix}GRANT ${privilege} ON ${objects} TO "reviewrouter quoted acl probe"`,
      );
      try {
        await expectAclRejected();
      } finally {
        await admin.$executeRawUnsafe(
          `${prefix}REVOKE ${privilege} ON ${objects} FROM "reviewrouter quoted acl probe"`,
        );
      }
    },
  );

  it("rejects a replaced function body", async () => {
    if (!admin) throw new Error("real_postgres_test_unconfigured");
    const rows = await admin.$queryRawUnsafe<{ definition: string }[]>(
      "SELECT pg_get_functiondef('release_authority.release_compensation_effects_are_safe(text)'::regprocedure) AS definition",
    );
    const definition = rows[0]?.definition;
    if (!definition)
      throw new Error("real_postgres_function_definition_missing");
    await admin.$executeRawUnsafe(
      "CREATE OR REPLACE FUNCTION release_authority.release_compensation_effects_are_safe(p_rollout_id text) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS 'SELECT true'",
    );
    try {
      await expectCatalogRejected();
    } finally {
      await admin.$executeRawUnsafe(definition);
    }
  });

  it.each([
    [
      "schema",
      "ALTER SCHEMA release_authority OWNER TO reviewrouter_unexpected_acl_probe",
      () => `ALTER SCHEMA release_authority OWNER TO ${quotedOwner}`,
    ],
    [
      "table",
      "ALTER TABLE release_authority.rollout OWNER TO reviewrouter_unexpected_acl_probe",
      () => `ALTER TABLE release_authority.rollout OWNER TO ${quotedOwner}`,
    ],
    [
      "type",
      "ALTER TYPE release_authority.aggregate_state OWNER TO reviewrouter_unexpected_acl_probe",
      () =>
        `ALTER TYPE release_authority.aggregate_state OWNER TO ${quotedOwner}`,
    ],
    [
      "function",
      "ALTER FUNCTION release_authority.observe_state(text,text,text) OWNER TO reviewrouter_unexpected_acl_probe",
      () =>
        `ALTER FUNCTION release_authority.observe_state(text,text,text) OWNER TO ${quotedOwner}`,
    ],
  ] as const)("rejects a wrong %s owner", async (_kind, mutate, restore) => {
    if (!admin) throw new Error("real_postgres_test_unconfigured");
    await admin.$executeRawUnsafe(mutate);
    try {
      await expectFinalAclRejected();
    } finally {
      await admin.$executeRawUnsafe(restore());
    }
  });

  it("rejects wrong trigger authority through its table and guard-routine owners", async () => {
    if (!admin) throw new Error("real_postgres_test_unconfigured");
    await admin.$executeRawUnsafe(
      "ALTER FUNCTION release_authority.release_source_resume_is_rollout_owned() OWNER TO reviewrouter_unexpected_acl_probe",
    );
    try {
      await expectFinalAclRejected();
    } finally {
      await admin.$executeRawUnsafe(
        `ALTER FUNCTION release_authority.release_source_resume_is_rollout_owned() OWNER TO ${quotedOwner}`,
      );
    }
  });

  it.each([
    [
      "an unexpected function grantee",
      "GRANT EXECUTE ON FUNCTION release_authority.observe_state(text,text,text) TO reviewrouter_unexpected_acl_probe",
      "REVOKE ALL ON FUNCTION release_authority.observe_state(text,text,text) FROM reviewrouter_unexpected_acl_probe",
    ],
    [
      "an unexpected table grantee",
      "GRANT SELECT ON TABLE release_authority.rollout TO reviewrouter_unexpected_acl_probe",
      "REVOKE ALL ON TABLE release_authority.rollout FROM reviewrouter_unexpected_acl_probe",
    ],
    [
      "an unexpected sequence grantee",
      "GRANT SELECT ON SEQUENCE release_authority.source_freeze_observation_observation_id_seq TO reviewrouter_unexpected_acl_probe",
      "REVOKE ALL ON SEQUENCE release_authority.source_freeze_observation_observation_id_seq FROM reviewrouter_unexpected_acl_probe",
    ],
    [
      "an unexpected type grantee",
      "GRANT USAGE ON TYPE release_authority.aggregate_state TO reviewrouter_unexpected_acl_probe",
      "REVOKE ALL ON TYPE release_authority.aggregate_state FROM reviewrouter_unexpected_acl_probe",
    ],
    [
      "PUBLIC schema CREATE",
      "GRANT CREATE ON SCHEMA release_authority TO PUBLIC",
      "REVOKE CREATE ON SCHEMA release_authority FROM PUBLIC",
    ],
    [
      "PUBLIC function EXECUTE",
      "GRANT EXECUTE ON FUNCTION release_authority.observe_state(text,text,text) TO PUBLIC",
      "REVOKE EXECUTE ON FUNCTION release_authority.observe_state(text,text,text) FROM PUBLIC",
    ],
    [
      "a function grant option",
      "GRANT EXECUTE ON FUNCTION release_authority.observe_state(text,text,text) TO reviewrouter_release_control WITH GRANT OPTION",
      "REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION release_authority.observe_state(text,text,text) FROM reviewrouter_release_control",
    ],
    [
      "a missing required function grant",
      "REVOKE EXECUTE ON FUNCTION release_authority.observe_state(text,text,text) FROM reviewrouter_release_control",
      "GRANT EXECUTE ON FUNCTION release_authority.observe_state(text,text,text) TO reviewrouter_release_control",
    ],
  ] as const)("rejects %s", async (_case, mutate, restore) => {
    if (!admin) throw new Error("real_postgres_test_unconfigured");
    await admin.$executeRawUnsafe(mutate);
    try {
      await expectFinalAclRejected();
    } finally {
      await admin.$executeRawUnsafe(restore);
    }
  });

  it("independently rejects an extra ACL-bearing authority object", async () => {
    if (!admin) throw new Error("real_postgres_test_unconfigured");
    await admin.$executeRawUnsafe(
      "CREATE TABLE release_authority.readiness_acl_object_probe(id integer)",
    );
    await admin.$executeRawUnsafe(
      "GRANT SELECT ON release_authority.readiness_acl_object_probe TO reviewrouter_unexpected_acl_probe",
    );
    try {
      const observed = await readiness();
      expect(observed.finalAclExact).toBe(false);
      expect(releaseAuthoritySchemaIsReady(observed)).toBe(false);
    } finally {
      await admin.$executeRawUnsafe(
        "DROP TABLE release_authority.readiness_acl_object_probe",
      );
    }
  });

  it("rejects an inherited authority ACL through stale role membership", async () => {
    if (!admin) throw new Error("real_postgres_test_unconfigured");
    await admin.$executeRawUnsafe(
      "GRANT reviewrouter_release_control TO reviewrouter_unexpected_acl_probe",
    );
    try {
      await expectFinalAclRejected();
    } finally {
      await admin.$executeRawUnsafe(
        "REVOKE reviewrouter_release_control FROM reviewrouter_unexpected_acl_probe",
      );
    }
  });

  it("rejects direct and inherited effective owner-role membership", async () => {
    if (!admin) throw new Error("real_postgres_test_unconfigured");
    await admin.$executeRawUnsafe(
      `GRANT ${quotedOwner} TO reviewrouter_release_control`,
    );
    try {
      await expectCatalogRejected();
    } finally {
      await admin.$executeRawUnsafe(
        `REVOKE ${quotedOwner} FROM reviewrouter_release_control`,
      );
    }
    await admin.$executeRawUnsafe(
      `GRANT ${quotedOwner} TO reviewrouter_owner_membership_probe`,
    );
    await admin.$executeRawUnsafe(
      "GRANT reviewrouter_owner_membership_probe TO reviewrouter_release_control",
    );
    try {
      await expectCatalogRejected();
    } finally {
      await admin.$executeRawUnsafe(
        "REVOKE reviewrouter_owner_membership_probe FROM reviewrouter_release_control",
      );
      await admin.$executeRawUnsafe(
        `REVOKE ${quotedOwner} FROM reviewrouter_owner_membership_probe`,
      );
    }
  });

  it("rejects elevated runtime attributes and inbound or cross-role membership", async () => {
    if (!admin) throw new Error("real_postgres_test_unconfigured");
    const cases = [
      [
        "ALTER ROLE reviewrouter_release_control CREATEDB",
        "ALTER ROLE reviewrouter_release_control NOCREATEDB",
      ],
      [
        "GRANT reviewrouter_release_control TO reviewrouter_inbound_membership_probe",
        "REVOKE reviewrouter_release_control FROM reviewrouter_inbound_membership_probe",
      ],
      [
        "GRANT reviewrouter_provider_authority TO reviewrouter_release_control",
        "REVOKE reviewrouter_provider_authority FROM reviewrouter_release_control",
      ],
      [
        "GRANT reviewrouter_owner_membership_probe TO reviewrouter_release_control",
        "REVOKE reviewrouter_owner_membership_probe FROM reviewrouter_release_control",
      ],
    ] as const;
    for (const [mutate, restore] of cases) {
      await admin.$executeRawUnsafe(mutate);
      try {
        await expectCatalogRejected();
      } finally {
        await admin.$executeRawUnsafe(restore);
      }
    }
  });

  it("rejects missing and disabled triggers and a missing guard routine", async () => {
    if (!admin) throw new Error("real_postgres_test_unconfigured");
    const triggerRows = await admin.$queryRawUnsafe<{ definition: string }[]>(
      "SELECT pg_get_triggerdef(oid,true) AS definition FROM pg_trigger WHERE tgname='release_source_resume_rollout_ownership_guard' AND NOT tgisinternal",
    );
    const functionRows = await admin.$queryRawUnsafe<{ definition: string }[]>(
      "SELECT pg_get_functiondef('release_authority.release_source_resume_is_rollout_owned()'::regprocedure) AS definition",
    );
    const triggerDefinition = triggerRows[0]?.definition;
    const functionDefinition = functionRows[0]?.definition;
    if (!triggerDefinition || !functionDefinition)
      throw new Error("real_postgres_guard_definition_missing");

    await admin.$executeRawUnsafe(
      "ALTER TABLE release_authority.service_transition_checkpoint DISABLE TRIGGER release_source_resume_rollout_ownership_guard",
    );
    try {
      await expectCatalogRejected();
    } finally {
      await admin.$executeRawUnsafe(
        "ALTER TABLE release_authority.service_transition_checkpoint ENABLE TRIGGER release_source_resume_rollout_ownership_guard",
      );
    }
    await admin.$executeRawUnsafe(
      "DROP TRIGGER release_source_resume_rollout_ownership_guard ON release_authority.service_transition_checkpoint",
    );
    try {
      await expectCatalogRejected();
    } finally {
      await admin.$executeRawUnsafe(triggerDefinition);
    }
    await admin.$executeRawUnsafe(
      "DROP TRIGGER release_source_resume_rollout_ownership_guard ON release_authority.service_transition_checkpoint",
    );
    await admin.$executeRawUnsafe(
      "DROP FUNCTION release_authority.release_source_resume_is_rollout_owned()",
    );
    try {
      await expectCatalogRejected();
    } finally {
      await admin.$executeRawUnsafe(functionDefinition);
      await admin.$executeRawUnsafe(triggerDefinition);
    }
  });

  it.each([
    [
      "table/catalog",
      "CREATE TABLE release_authority.readiness_catalog_probe(id integer)",
      "DROP TABLE release_authority.readiness_catalog_probe",
    ],
    [
      "column",
      "ALTER TABLE release_authority.rollout ADD COLUMN readiness_probe text",
      "ALTER TABLE release_authority.rollout DROP COLUMN readiness_probe",
    ],
    [
      "constraint",
      "ALTER TABLE release_authority.rollout ADD CONSTRAINT readiness_probe_check CHECK (claim_version < 2147483647)",
      "ALTER TABLE release_authority.rollout DROP CONSTRAINT readiness_probe_check",
    ],
    [
      "index",
      "CREATE INDEX readiness_probe_index ON release_authority.rollout(updated_at)",
      "DROP INDEX release_authority.readiness_probe_index",
    ],
  ] as const)("rejects %s drift", async (_kind, mutate, restore) => {
    if (!admin) throw new Error("real_postgres_test_unconfigured");
    await admin.$executeRawUnsafe(mutate);
    try {
      await expectCatalogRejected();
    } finally {
      await admin.$executeRawUnsafe(restore);
    }
  });

  it.each([
    [
      "inheritance",
      "CREATE TABLE release_authority.readiness_parent_probe (LIKE release_authority.rollout INCLUDING ALL); ALTER TABLE release_authority.rollout INHERIT release_authority.readiness_parent_probe",
      "ALTER TABLE release_authority.rollout NO INHERIT release_authority.readiness_parent_probe; DROP TABLE release_authority.readiness_parent_probe",
    ],
    [
      "rewrite rule",
      "CREATE RULE readiness_rewrite_probe AS ON DELETE TO release_authority.rollout DO ALSO NOTHING",
      "DROP RULE readiness_rewrite_probe ON release_authority.rollout",
    ],
    [
      "row-level security policy",
      "ALTER TABLE release_authority.rollout ENABLE ROW LEVEL SECURITY; CREATE POLICY readiness_policy_probe ON release_authority.rollout USING (true)",
      "DROP POLICY readiness_policy_probe ON release_authority.rollout; ALTER TABLE release_authority.rollout DISABLE ROW LEVEL SECURITY",
    ],
  ] as const)(
    "rejects adversarial %s semantics",
    async (_kind, mutate, restore) => {
      if (!admin) throw new Error("real_postgres_test_unconfigured");
      for (const statement of mutate.split("; "))
        await admin.$executeRawUnsafe(statement);
      try {
        await expectCatalogRejected();
      } finally {
        for (const statement of restore.split("; "))
          await admin.$executeRawUnsafe(statement);
      }
    },
  );

  it("rejects mixed, partial, and mismatched migration history", async () => {
    if (!admin) throw new Error("real_postgres_test_unconfigured");
    const cases = [
      "UPDATE release_authority.schema_migration SET checksum_sha256='sha256:e88a7cc8f29e91a86434bf14b4051f1fb17b5df02f8fc2dae6ec63d5792b398b', byte_variant='legacy_equivalent' WHERE position=1",
      "DELETE FROM release_authority.schema_migration WHERE position=11",
      "UPDATE release_authority.schema_migration SET checksum_sha256='sha256:'||repeat('0',64) WHERE position=11",
      "DELETE FROM release_authority.schema_migration WHERE position=12",
      "UPDATE release_authority.schema_migration SET checksum_sha256='sha256:'||repeat('0',64) WHERE position=12",
    ];
    for (const mutate of cases) {
      await admin.$executeRawUnsafe(
        "CREATE TABLE public.readiness_history_backup AS TABLE release_authority.schema_migration",
      );
      await admin.$executeRawUnsafe(mutate);
      try {
        const observed = await readiness();
        expect(releaseAuthoritySchemaIsReady(observed)).toBe(false);
      } finally {
        await admin.$executeRawUnsafe(
          "TRUNCATE release_authority.schema_migration",
        );
        await admin.$executeRawUnsafe(
          "INSERT INTO release_authority.schema_migration SELECT * FROM public.readiness_history_backup",
        );
        await admin.$executeRawUnsafe(
          "DROP TABLE public.readiness_history_backup",
        );
      }
    }
  });

  it("rejects migration attestation mismatch", async () => {
    if (!admin) throw new Error("real_postgres_test_unconfigured");
    const comments = await admin.$queryRawUnsafe<{ comment: string }[]>(
      "SELECT obj_description('release_authority'::regnamespace,'pg_namespace') AS comment",
    );
    const comment = comments[0]?.comment;
    if (!comment) throw new Error("real_postgres_catalog_attestation_missing");
    await admin.$executeRawUnsafe(
      'COMMENT ON SCHEMA release_authority IS \'{"verifier":"complete_catalog_v3_acl_exact","catalogFingerprint":"sha256:0000"}\'',
    );
    try {
      await expectCatalogRejected();
    } finally {
      await admin.$executeRawUnsafe(
        `COMMENT ON SCHEMA release_authority IS '${comment.replaceAll("'", "''")}'`,
      );
    }
  });
});

const activationAdminUrl =
  process.env.REVIEW_ROUTER_ACTIVATION_TARGET_ADMIN_TEST_URL;
const activationInstallerUrl =
  process.env.REVIEW_ROUTER_ACTIVATION_PERMIT_INSTALLER_TEST_URL;
const activationReaderUrl =
  process.env.REVIEW_ROUTER_ACTIVATION_RECEIPT_READER_TEST_URL;
const activationDescribe =
  activationAdminUrl && activationInstallerUrl && activationReaderUrl
    ? describe.sequential
    : describe.skip;

activationDescribe("activation target semantic readiness", () => {
  const admin = activationAdminUrl
    ? createPrismaClient({ databaseUrl: activationAdminUrl })
    : null;
  const installer = activationInstallerUrl
    ? createPrismaClient({ databaseUrl: activationInstallerUrl })
    : null;
  const reader = activationReaderUrl
    ? createPrismaClient({ databaseUrl: activationReaderUrl })
    : null;
  let installerDefinition = "";
  let readerDefinition = "";
  let installerBodySha256 = "";
  let readerBodySha256 = "";
  let activationNamespaceFingerprint = "";
  let applicationMigrationManifestIdentity = "";

  beforeAll(async () => {
    if (!admin || !installer || !reader)
      throw new Error("real_postgres_activation_test_unconfigured");
    await admin.$executeRawUnsafe(
      "CREATE ROLE reviewrouter_activation_readiness_probe LOGIN",
    );
    const definitions = await admin.$queryRawUnsafe<
      { installer: string; reader: string }[]
    >(`SELECT
      pg_get_functiondef(
        'reviewrouter_activation.install_activation_permit(text,text,text,integer,text,text,jsonb,bigint,text)'::regprocedure
      ) AS installer,
      pg_get_functiondef(
        'reviewrouter_activation.read_activation_receipt(text)'::regprocedure
      ) AS reader`);
    installerDefinition = definitions[0]?.installer ?? "";
    readerDefinition = definitions[0]?.reader ?? "";
    if (!installerDefinition || !readerDefinition)
      throw new Error("real_postgres_activation_definition_missing");
    const installerReadiness =
      await observeReleaseAuthorityDatabaseReadiness(installer);
    const readerReadiness =
      await observeReleaseAuthorityDatabaseReadiness(reader);
    installerBodySha256 = installerReadiness.installerRoutineBodySha256;
    readerBodySha256 = readerReadiness.readerRoutineBodySha256;
    activationNamespaceFingerprint =
      installerReadiness.activationNamespaceFingerprint;
    applicationMigrationManifestIdentity =
      installerReadiness.applicationMigrationManifestIdentity;
  });

  afterAll(async () => {
    if (admin) {
      await admin.$executeRawUnsafe(
        "DROP OWNED BY reviewrouter_activation_readiness_probe",
      );
      await admin.$executeRawUnsafe(
        "DROP ROLE IF EXISTS reviewrouter_activation_readiness_probe",
      );
    }
    await Promise.all(
      [admin, installer, reader]
        .filter((client) => client !== null)
        .map((client) => client.$disconnect()),
    );
  });

  const installerReadiness = async () => {
    if (!installer)
      throw new Error("real_postgres_activation_test_unconfigured");
    return observeReleaseAuthorityDatabaseReadiness(installer);
  };
  const readerReadiness = async () => {
    if (!reader) throw new Error("real_postgres_activation_test_unconfigured");
    return observeReleaseAuthorityDatabaseReadiness(reader);
  };

  it("accepts exact installer, reader, guard, and runtime privilege semantics", async () => {
    const observedInstaller = await installerReadiness();
    const observedReader = await readerReadiness();
    expect(observedInstaller).toMatchObject({
      installerRoutine: true,
      activationGuardExact: true,
      activationRuntimePrivilegesExact: true,
    });
    expect(observedReader).toMatchObject({
      readerRoutine: true,
      activationGuardExact: true,
      activationRuntimePrivilegesExact: true,
    });
    expect(installerBodySha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(readerBodySha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(installerBodySha256).not.toBe(readerBodySha256);
  });

  it("rejects installer body, config, owner, and EXECUTE ACL drift", async () => {
    if (!admin) throw new Error("real_postgres_activation_test_unconfigured");
    const cases = [
      {
        mutate:
          "CREATE OR REPLACE FUNCTION reviewrouter_activation.install_activation_permit(requested_rollout_id text,requested_source_system_identifier text,requested_target_system_identifier text,requested_postgres_major integer,requested_expected_commit_sha text,requested_migration_checksum text,requested_target_deploy_ids jsonb,requested_permit_epoch bigint,requested_permit_nonce text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS 'BEGIN RETURN true; END'",
        rejected: async () => {
          const observed = await installerReadiness();
          expect(observed.installerRoutineBodySha256).not.toBe(
            installerBodySha256,
          );
          expect(observed.activationNamespaceFingerprint).not.toBe(
            activationNamespaceFingerprint,
          );
        },
        restore: () => admin.$executeRawUnsafe(installerDefinition),
      },
      {
        mutate:
          "ALTER FUNCTION reviewrouter_activation.install_activation_permit(text,text,text,integer,text,text,jsonb,bigint,text) RESET ALL",
        rejected: async () => {
          expect((await installerReadiness()).installerRoutine).toBe(false);
        },
        restore: () =>
          admin.$executeRawUnsafe(
            "ALTER FUNCTION reviewrouter_activation.install_activation_permit(text,text,text,integer,text,text,jsonb,bigint,text) SET search_path=pg_catalog,pg_temp",
          ),
      },
      {
        mutate:
          "ALTER FUNCTION reviewrouter_activation.install_activation_permit(text,text,text,integer,text,text,jsonb,bigint,text) OWNER TO reviewrouter_activation_readiness_probe",
        rejected: async () => {
          expect((await installerReadiness()).installerRoutine).toBe(false);
        },
        restore: () =>
          admin.$executeRawUnsafe(
            "ALTER FUNCTION reviewrouter_activation.install_activation_permit(text,text,text,integer,text,text,jsonb,bigint,text) OWNER TO reviewrouter_activation_receipt_guard",
          ),
      },
      {
        mutate:
          "GRANT EXECUTE ON FUNCTION reviewrouter_activation.install_activation_permit(text,text,text,integer,text,text,jsonb,bigint,text) TO reviewrouter_activation_readiness_probe",
        rejected: async () => {
          expect((await installerReadiness()).installerRoutine).toBe(false);
        },
        restore: () =>
          admin.$executeRawUnsafe(
            "REVOKE EXECUTE ON FUNCTION reviewrouter_activation.install_activation_permit(text,text,text,integer,text,text,jsonb,bigint,text) FROM reviewrouter_activation_readiness_probe",
          ),
      },
    ];
    for (const { mutate, rejected, restore } of cases) {
      await admin.$executeRawUnsafe(mutate);
      try {
        await rejected();
      } finally {
        await restore();
      }
    }
  });

  it("rejects a changed application migration manifest identity", async () => {
    if (!admin) throw new Error("real_postgres_activation_test_unconfigured");
    await admin.$executeRawUnsafe(`UPDATE public._prisma_migrations
      SET checksum=checksum || '-readiness-probe'
      WHERE migration_name=(SELECT min(migration_name) FROM public._prisma_migrations)`);
    try {
      const observed = await installerReadiness();
      expect(observed.applicationMigrationManifestIdentity).not.toBe(
        applicationMigrationManifestIdentity,
      );
    } finally {
      await admin.$executeRawUnsafe(`UPDATE public._prisma_migrations
        SET checksum=left(checksum, length(checksum)-length('-readiness-probe'))
        WHERE checksum LIKE '%-readiness-probe'`);
    }
    expect(
      (await installerReadiness()).applicationMigrationManifestIdentity,
    ).toBe(applicationMigrationManifestIdentity);
  });

  it("rejects reader body drift", async () => {
    if (!admin) throw new Error("real_postgres_activation_test_unconfigured");
    await admin.$executeRawUnsafe(
      "CREATE OR REPLACE FUNCTION reviewrouter_activation.read_activation_receipt(requested_rollout_id text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS 'BEGIN RETURN NULL; END'",
    );
    try {
      expect((await readerReadiness()).readerRoutineBodySha256).not.toBe(
        readerBodySha256,
      );
    } finally {
      await admin.$executeRawUnsafe(readerDefinition);
    }
  });

  it("rejects guard shape, guard ACL, inbound membership, and runtime elevation", async () => {
    if (!admin) throw new Error("real_postgres_activation_test_unconfigured");
    const cases = [
      [
        "ALTER TABLE reviewrouter_activation.activation_permit ADD COLUMN readiness_probe text",
        "ALTER TABLE reviewrouter_activation.activation_permit DROP COLUMN readiness_probe",
        "activationGuardExact",
      ],
      [
        "GRANT SELECT ON TABLE reviewrouter_activation.activation_permit TO reviewrouter_activation_readiness_probe",
        "REVOKE SELECT ON TABLE reviewrouter_activation.activation_permit FROM reviewrouter_activation_readiness_probe",
        "activationGuardExact",
      ],
      [
        'GRANT UPDATE ON TABLE public."_prisma_migrations" TO reviewrouter_activation_receipt_guard',
        'REVOKE UPDATE ON TABLE public."_prisma_migrations" FROM reviewrouter_activation_receipt_guard',
        "activationGuardExact",
      ],
      [
        'GRANT SELECT ON TABLE public."_prisma_migrations" TO reviewrouter_activation_permit_installer',
        'REVOKE SELECT ON TABLE public."_prisma_migrations" FROM reviewrouter_activation_permit_installer',
        "activationRuntimePrivilegesExact",
      ],
      [
        "GRANT reviewrouter_activation_permit_installer TO reviewrouter_activation_readiness_probe",
        "REVOKE reviewrouter_activation_permit_installer FROM reviewrouter_activation_readiness_probe",
        "activationRuntimePrivilegesExact",
      ],
      [
        "ALTER ROLE reviewrouter_api CREATEDB",
        "ALTER ROLE reviewrouter_api NOCREATEDB",
        "activationRuntimePrivilegesExact",
      ],
    ] as const;
    for (const [mutate, restore, field] of cases) {
      await admin.$executeRawUnsafe(mutate);
      try {
        expect((await installerReadiness())[field]).toBe(false);
      } finally {
        await admin.$executeRawUnsafe(restore);
      }
    }
  });
});
