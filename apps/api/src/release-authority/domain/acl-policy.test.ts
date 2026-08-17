import { describe, expect, it } from "vitest";
import {
  releaseAuthorityDefaultAclPolicy,
  releaseAuthorityFinalAclPolicy,
} from "./acl-policy.mjs";

describe("release authority ACL policy", () => {
  it("defines an empty default-ACL policy for every PostgreSQL object family and scope", () => {
    expect(releaseAuthorityDefaultAclPolicy).toEqual({
      creatingOwner: "authority_owner",
      scopes: ["global", "authority_schema"],
      objectKinds: ["tables", "sequences", "routines", "types"],
      grants: [],
    });
  });

  it("owns the explicit final object/role matrix outside the PostgreSQL adapter", () => {
    expect(releaseAuthorityFinalAclPolicy.schema.usageRoles).toEqual([
      "reviewrouter_provider_authority",
      "reviewrouter_release_control",
      "reviewrouter_release_witness",
    ]);
    expect(releaseAuthorityFinalAclPolicy.relations).toContain(
      "recovery_effect",
    );
    expect(releaseAuthorityFinalAclPolicy.relations).toContain(
      "provider_resource_lease",
    );
    expect(releaseAuthorityFinalAclPolicy.sequences).toEqual([
      "source_freeze_observation_observation_id_seq",
    ]);
    expect(releaseAuthorityFinalAclPolicy.relationOwnerPrivileges).toContain(
      "MAINTAIN",
    );
    expect(releaseAuthorityFinalAclPolicy.routineExecutePrivileges).toEqual([
      "EXECUTE",
    ]);
    expect(releaseAuthorityFinalAclPolicy.routines).toContain(
      "release_recovery_effect_intend",
    );
    expect(releaseAuthorityFinalAclPolicy.routines).toContain(
      "release_canonical_json",
    );
    expect(
      releaseAuthorityFinalAclPolicy.routineExecuteRoles
        .reviewrouter_release_control,
    ).toContain("release_recovery_effect_intend");
    expect(releaseAuthorityFinalAclPolicy.publicPrivileges).toEqual([]);
    expect(releaseAuthorityFinalAclPolicy.grantOptions).toEqual([]);
    expect(releaseAuthorityFinalAclPolicy.roleMemberships).toEqual([
      {
        grantedRole: "reviewrouter_authority_owner",
        memberRole: "reviewrouter_migration_broker",
        grantorRole: "provisioned_grantor",
        admin: true,
        inherit: false,
        set: false,
      },
    ]);
    expect(new Set(releaseAuthorityFinalAclPolicy.relations).size).toBe(15);
    expect(new Set(releaseAuthorityFinalAclPolicy.routines).size).toBe(85);
    expect(
      new Set(
        releaseAuthorityFinalAclPolicy.routineExecuteRoles
          .reviewrouter_release_control,
      ).size,
    ).toBe(52);
  });
});
