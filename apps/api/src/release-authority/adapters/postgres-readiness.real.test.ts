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

  beforeAll(async () => {
    if (!admin) throw new Error("real_postgres_test_unconfigured");
    await admin.$executeRawUnsafe(
      "CREATE ROLE reviewrouter_unexpected_acl_probe NOLOGIN",
    );
    await admin.$executeRawUnsafe(
      "CREATE ROLE reviewrouter_owner_membership_probe NOLOGIN",
    );
    const owners = await admin.$queryRawUnsafe<{ owner: string }[]>(
      "SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname='release_authority'",
    );
    owner = owners[0]?.owner ?? "";
    if (!/^[A-Za-z_][A-Za-z0-9_$]*$/u.test(owner))
      throw new Error("real_postgres_authority_owner_invalid");
    quotedOwner = `"${owner.replaceAll('"', '""')}"`;
  });

  afterAll(async () => {
    if (admin) {
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

  it("accepts the canonical PostgreSQL 17 catalog", async () => {
    const observed = await readiness();
    expect(observed).toMatchObject({
      postgresMajor: 17,
      schemaVersion: 10,
      catalogVerifier: "complete_catalog_v1",
      catalogExact: true,
    });
    expect(observed.catalogFingerprint).toBe(
      observed.expectedCatalogFingerprint,
    );
    expect(releaseAuthoritySchemaIsReady(observed)).toBe(true);
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

  it("rejects a replaced function body", async () => {
    if (!admin) throw new Error("real_postgres_test_unconfigured");
    const rows = await admin.$queryRawUnsafe<{ definition: string }[]>(
      "SELECT pg_get_functiondef('release_authority.release_compensation_effects_are_safe(text)'::regprocedure) AS definition",
    );
    const definition = rows[0]?.definition;
    if (!definition)
      throw new Error("real_postgres_function_definition_missing");
    await admin.$executeRawUnsafe(
      "CREATE OR REPLACE FUNCTION release_authority.release_compensation_effects_are_safe(text) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS 'SELECT true'",
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
      await expectCatalogRejected();
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
      await expectCatalogRejected();
    } finally {
      await admin.$executeRawUnsafe(
        `ALTER FUNCTION release_authority.release_source_resume_is_rollout_owned() OWNER TO ${quotedOwner}`,
      );
    }
  });

  it("rejects excessive, PUBLIC, grant-option, and missing grants", async () => {
    if (!admin) throw new Error("real_postgres_test_unconfigured");
    const cases = [
      [
        "GRANT EXECUTE ON FUNCTION release_authority.observe_state(text,text,text) TO reviewrouter_unexpected_acl_probe",
        "REVOKE ALL ON FUNCTION release_authority.observe_state(text,text,text) FROM reviewrouter_unexpected_acl_probe",
      ],
      [
        "GRANT CREATE ON SCHEMA release_authority TO PUBLIC",
        "REVOKE CREATE ON SCHEMA release_authority FROM PUBLIC",
      ],
      [
        "GRANT EXECUTE ON FUNCTION release_authority.observe_state(text,text,text) TO PUBLIC",
        "REVOKE EXECUTE ON FUNCTION release_authority.observe_state(text,text,text) FROM PUBLIC",
      ],
      [
        "GRANT EXECUTE ON FUNCTION release_authority.observe_state(text,text,text) TO reviewrouter_release_control WITH GRANT OPTION",
        "REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION release_authority.observe_state(text,text,text) FROM reviewrouter_release_control",
      ],
      [
        "REVOKE EXECUTE ON FUNCTION release_authority.observe_state(text,text,text) FROM reviewrouter_release_control",
        "GRANT EXECUTE ON FUNCTION release_authority.observe_state(text,text,text) TO reviewrouter_release_control",
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

  it("rejects mixed, partial, and mismatched migration history", async () => {
    if (!admin) throw new Error("real_postgres_test_unconfigured");
    const cases = [
      "UPDATE release_authority.schema_migration SET checksum_sha256='sha256:e88a7cc8f29e91a86434bf14b4051f1fb17b5df02f8fc2dae6ec63d5792b398b', byte_variant='legacy_equivalent' WHERE position=1",
      "DELETE FROM release_authority.schema_migration WHERE position=11",
      "UPDATE release_authority.schema_migration SET checksum_sha256='sha256:'||repeat('0',64) WHERE position=11",
    ];
    for (const mutate of cases) {
      await admin.$executeRawUnsafe(
        "CREATE TABLE public.readiness_history_backup AS TABLE release_authority.schema_migration",
      );
      await admin.$executeRawUnsafe(mutate);
      try {
        const observed = await readiness();
        expect(observed.catalogExact).toBe(true);
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
      'COMMENT ON SCHEMA release_authority IS \'{"verifier":"complete_catalog_v1","catalogFingerprint":"sha256:0000"}\'',
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
