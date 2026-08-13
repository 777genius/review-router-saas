import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "@reviewrouter/platform-db";
import { observeReleaseAuthorityDatabaseReadiness } from "./postgres-readiness";

const adminUrl = process.env.REVIEW_ROUTER_RELEASE_AUTHORITY_ADMIN_TEST_URL;
const controlUrl = process.env.REVIEW_ROUTER_RELEASE_AUTHORITY_CONTROL_TEST_URL;
const realDescribe =
  adminUrl && controlUrl ? describe.sequential : describe.skip;

realDescribe("release authority exact catalog readiness", () => {
  const admin = adminUrl ? createPrismaClient({ databaseUrl: adminUrl }) : null;
  const control = controlUrl
    ? createPrismaClient({ databaseUrl: controlUrl })
    : null;

  beforeAll(async () => {
    if (!admin) throw new Error("real_postgres_test_unconfigured");
    await admin.$executeRawUnsafe(
      "CREATE ROLE reviewrouter_unexpected_acl_probe NOLOGIN",
    );
  });

  afterAll(async () => {
    if (admin) {
      await admin.$executeRawUnsafe(
        "REASSIGN OWNED BY reviewrouter_unexpected_acl_probe TO postgres",
      );
      await admin.$executeRawUnsafe(
        "DROP OWNED BY reviewrouter_unexpected_acl_probe",
      );
      await admin.$executeRawUnsafe(
        "DROP ROLE IF EXISTS reviewrouter_unexpected_acl_probe",
      );
    }
    await Promise.all(
      [admin, control]
        .filter((client) => client !== null)
        .map((client) => client.$disconnect()),
    );
  });

  const readiness = async () => {
    if (!control) throw new Error("real_postgres_test_unconfigured");
    return observeReleaseAuthorityDatabaseReadiness(control);
  };

  it("rejects an arbitrary function grantee", async () => {
    if (!admin) throw new Error("real_postgres_test_unconfigured");
    await admin.$executeRawUnsafe(
      "GRANT EXECUTE ON FUNCTION release_authority.observe_state(text,text,text) TO reviewrouter_unexpected_acl_probe",
    );
    await expect(readiness()).resolves.toMatchObject({
      authorityAclExact: false,
    });
    await admin.$executeRawUnsafe(
      "REVOKE ALL ON FUNCTION release_authority.observe_state(text,text,text) FROM reviewrouter_unexpected_acl_probe",
    );
  });

  it("rejects every non-owner grant option", async () => {
    if (!admin) throw new Error("real_postgres_test_unconfigured");
    await admin.$executeRawUnsafe(
      "GRANT EXECUTE ON FUNCTION release_authority.observe_state(text,text,text) TO reviewrouter_release_control WITH GRANT OPTION",
    );
    await expect(readiness()).resolves.toMatchObject({
      authorityAclExact: false,
    });
    await admin.$executeRawUnsafe(
      "REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION release_authority.observe_state(text,text,text) FROM reviewrouter_release_control",
    );
  });

  it("rejects PUBLIC schema CREATE and arbitrary table or sequence grants", async () => {
    if (!admin) throw new Error("real_postgres_test_unconfigured");
    await admin.$executeRawUnsafe(
      "GRANT CREATE ON SCHEMA release_authority TO PUBLIC",
    );
    await expect(readiness()).resolves.toMatchObject({
      authorityAclExact: false,
    });
    await admin.$executeRawUnsafe(
      "REVOKE CREATE ON SCHEMA release_authority FROM PUBLIC",
    );
    await admin.$executeRawUnsafe(
      "GRANT SELECT ON TABLE release_authority.rollout TO reviewrouter_unexpected_acl_probe",
    );
    await expect(readiness()).resolves.toMatchObject({
      authorityAclExact: false,
    });
    await admin.$executeRawUnsafe(
      "REVOKE ALL ON TABLE release_authority.rollout FROM reviewrouter_unexpected_acl_probe",
    );
    await admin.$executeRawUnsafe(
      "CREATE SEQUENCE release_authority.readiness_acl_probe_sequence",
    );
    await admin.$executeRawUnsafe(
      "GRANT USAGE ON SEQUENCE release_authority.readiness_acl_probe_sequence TO reviewrouter_unexpected_acl_probe",
    );
    await expect(readiness()).resolves.toMatchObject({
      authorityAclExact: false,
    });
    await admin.$executeRawUnsafe(
      "DROP SEQUENCE release_authority.readiness_acl_probe_sequence",
    );
  });

  it("rejects a wrong enum/type owner", async () => {
    if (!admin) throw new Error("real_postgres_test_unconfigured");
    await admin.$executeRawUnsafe(
      "ALTER TYPE release_authority.aggregate_state OWNER TO reviewrouter_unexpected_acl_probe",
    );
    await expect(readiness()).resolves.toMatchObject({
      authorityOwnershipExact: false,
    });
    await admin.$executeRawUnsafe(
      "ALTER TYPE release_authority.aggregate_state OWNER TO postgres",
    );
  });
});
