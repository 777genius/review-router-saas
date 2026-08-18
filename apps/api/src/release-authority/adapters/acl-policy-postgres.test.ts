import { describe, expect, it } from "vitest";
import {
  releaseAuthorityDefaultAclExactExpression,
  releaseAuthorityDefaultAclPreflightSql,
  releaseAuthorityDefaultAclRowsExpression,
  releaseAuthorityFinalAclExactExpression,
  releaseAuthorityProviderTerminalTopologyExactExpression,
  releaseAuthorityRuntimeAclExactExpression,
} from "./acl-policy-postgres.mjs";

describe("release authority PostgreSQL ACL policy adapter", () => {
  it("enumerates every relevant owner, scope, and default object family", () => {
    const gate = releaseAuthorityDefaultAclPreflightSql("release_authority");
    expect(gate).toContain("WITH relevant_owners(owner_oid) AS");
    expect(gate).toContain("namespace.nspowner");
    expect(gate).toContain("relation.relowner");
    expect(gate).toContain("procedure.proowner");
    expect(gate).toContain("type_record.typowner");
    expect(gate).toContain("default_acl.defaclnamespace IN");
    for (const kind of ["r", "S", "f", "T"])
      expect(gate).toContain(`'${kind}'::"char"`);
    expect(
      releaseAuthorityDefaultAclExactExpression("release_authority"),
    ).toContain("= '[]'::jsonb");
  });

  it("serializes default ACL evidence and enforces the independent final matrix", () => {
    const rows = releaseAuthorityDefaultAclRowsExpression("release_authority");
    const finalAcl =
      releaseAuthorityFinalAclExactExpression("release_authority");
    expect(rows).toContain("pg_catalog.pg_default_acl");
    expect(rows).toContain("'scope'");
    expect(rows).toContain("'object_type'");
    expect(rows).toContain("'is_grantable'");
    expect(finalAcl).toContain("expected_execute(routine_name,role_name)");
    expect(finalAcl).toContain("relation.relowner=target.nspowner");
    expect(finalAcl).toContain("sequence.relowner=target.nspowner");
    expect(finalAcl).toContain("pg_catalog.acldefault('S'");
    expect(finalAcl).toContain("'MAINTAIN'");
    expect(finalAcl).toContain("AND NOT acl.is_grantable");
    expect(finalAcl).toContain("procedure.proowner=target.nspowner");
    expect(finalAcl).toContain("attribute.attacl IS NOT NULL");
    expect(finalAcl).toContain("type_record.typacl IS NOT NULL");
    expect(finalAcl).toContain("pg_catalog.pg_auth_members");
    expect(finalAcl).toContain("grantor.oid=target.provider_root_oid");
    expect(finalAcl).toContain("provider_root_pin");
    expect(finalAcl).toContain("acl.is_grantable");
    // Migration 000014 adds one immutable relation and retains the four v13
    // implementations as owner-only helpers behind the public entry points.
    // All five objects must be part of the exact matrix, not merely the
    // catalog fingerprint assembled in a verification schema.
    expect(finalAcl).toContain("release_migration_evidence");
    for (const helper of [
      "release_migration_begin_v13",
      "release_migration_checkpoint_v13",
      "release_migration_complete_v13",
      "release_migration_fail_v13",
    ])
      expect(finalAcl).toContain(helper);
    const providerTopology =
      releaseAuthorityProviderTerminalTopologyExactExpression();
    expect(providerTopology).toContain(
      "reviewrouter_migration_credential.provider_terminal_topology_is_exact()",
    );
    expect(providerTopology).not.toContain(
      "FROM reviewrouter_migration_credential",
    );
    expect(
      releaseAuthorityRuntimeAclExactExpression("release_authority"),
    ).toContain(providerTopology);
  });

  it("rejects untrusted schema interpolation", () => {
    expect(() =>
      releaseAuthorityDefaultAclRowsExpression('bad"schema'),
    ).toThrow("release_authority_acl_schema_invalid");
    expect(() => releaseAuthorityFinalAclExactExpression("BadSchema")).toThrow(
      "release_authority_acl_schema_invalid",
    );
  });
});
