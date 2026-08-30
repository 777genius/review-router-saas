import { describe, expect, it } from "vitest";
import { parsePrivatePg17ActivationCatalogPolicyCandidate } from "./capture-private-pg17-activation-catalog-policy.mjs";
import { canonicalActivationPrincipalNames } from "../packages/features/release-rollout/src/domain/effective-principal-inventory.ts";
import { assertActivationCatalogPolicyNormalization } from "../packages/features/release-rollout/src/domain/activation-catalog-policy-contract.ts";
import { canonicalActivationCatalogArtifactSource } from "./promote-private-pg17-activation-catalog-policy.mjs";

const pendingActivationCatalogPrincipalNames = [
  "reviewrouter_activation_permit_installer",
  "reviewrouter_activation_receipt_guard",
  "reviewrouter_activation_receipt_reader",
  "reviewrouter_api",
  "reviewrouter_codex_effect_authority",
  "reviewrouter_comment_token_custody",
  "reviewrouter_release_migration",
  "reviewrouter_release_schema_owner",
  "reviewrouter_role_bootstrap",
  "reviewrouter_web",
  "reviewrouter_worker",
] as const;

const pendingActivationCatalogBootstrapMembershipRoleNames = [
  "reviewrouter_api",
  "reviewrouter_codex_effect_authority",
  "reviewrouter_comment_token_custody",
  "reviewrouter_release_migration",
  "reviewrouter_web",
  "reviewrouter_worker",
] as const;

const policy = (phase: "preactivation" | "activated") => ({
  kind: "reviewrouter-activation-catalog-policy",
  version: 1,
  phase,
  database: "review_router",
  roles: pendingActivationCatalogPrincipalNames.map((name) => ({
    name,
    canLogin: ![
      "reviewrouter_activation_receipt_guard",
      "reviewrouter_release_schema_owner",
    ].includes(name),
    inherit: true,
    superuser: false,
    bypassRls: false,
    replication: false,
    createDatabase: false,
    createRole: false,
    connectionLimit: -1,
    validUntil: null,
  })),
  memberships: pendingActivationCatalogBootstrapMembershipRoleNames.map(
    (role) => ({
      member: "reviewrouter_role_bootstrap",
      role,
      setOption: false,
      inheritOption: false,
      adminOption: true,
      grantor: { kind: "external-bootstrap-authority" },
    }),
  ),
  roleReachability: pendingActivationCatalogPrincipalNames
    .filter(
      (name) =>
        ![
          "reviewrouter_activation_receipt_guard",
          "reviewrouter_release_schema_owner",
        ].includes(name),
    )
    .map((principal) => ({
      principal,
      role: principal,
      usage: true,
      set: true,
    })),
  rowSecurity: [] as Array<Record<string, unknown>>,
  extensions: [],
  grants: [],
  effectivePermissions: pendingActivationCatalogPrincipalNames.map(
    (principal) => ({
      principal,
      permissions: [] as Array<Record<string, unknown>>,
    }),
  ),
});

const envelope = (preactivation: unknown, activated: unknown) =>
  `${JSON.stringify({ preactivation, activated })}\n`;

describe("activation catalog policy candidate capture", () => {
  it("accepts the exact pending topology while production rejects it", () => {
    expect(pendingActivationCatalogPrincipalNames).toContain(
      "reviewrouter_comment_token_custody",
    );
    expect(canonicalActivationPrincipalNames).not.toContain(
      "reviewrouter_comment_token_custody",
    );
    const candidate = parsePrivatePg17ActivationCatalogPolicyCandidate(
      envelope(policy("preactivation"), policy("activated")),
    );
    expect(
      candidate.policies.preactivation.roles.map(({ name }) => name),
    ).toEqual(pendingActivationCatalogPrincipalNames);
    expect(() =>
      assertActivationCatalogPolicyNormalization(
        candidate.policies.preactivation,
        "preactivation",
      ),
    ).toThrow("activation_catalog_policy_normalization_invalid:preactivation");
  });

  it("cannot route captured candidate bytes directly into promotion", () => {
    const candidate = parsePrivatePg17ActivationCatalogPolicyCandidate(
      envelope(policy("preactivation"), policy("activated")),
    );
    expect(() =>
      canonicalActivationCatalogArtifactSource(
        Buffer.from(JSON.stringify(candidate), "utf8"),
      ),
    ).toThrow(
      /activation_catalog_policy_promotion_candidate_(?:size|hash)_drift/u,
    );
  });

  it("rejects phase substitution", () => {
    expect(() =>
      parsePrivatePg17ActivationCatalogPolicyCandidate(
        envelope(policy("activated"), policy("preactivation")),
      ),
    ).toThrow("activation_catalog_policy_candidate_invalid:preactivation");
  });

  it.each([
    [
      "missing principal",
      (value: ReturnType<typeof policy>) => {
        value.roles.splice(4, 1);
      },
    ],
    [
      "extra principal",
      (value: ReturnType<typeof policy>) => {
        value.roles.push({
          ...value.roles.at(-1)!,
          name: "reviewrouter_unreviewed_extra",
        });
      },
    ],
    [
      "missing membership",
      (value: ReturnType<typeof policy>) => {
        value.memberships.splice(1, 1);
      },
    ],
    [
      "extra membership",
      (value: ReturnType<typeof policy>) => {
        value.memberships.push({
          ...value.memberships.at(-1)!,
          role: "reviewrouter_unreviewed_extra",
        });
      },
    ],
    [
      "missing role reachability",
      (value: ReturnType<typeof policy>) => {
        value.roleReachability.splice(4, 1);
      },
    ],
    [
      "extra role reachability",
      (value: ReturnType<typeof policy>) => {
        value.roleReachability.push({
          principal: "reviewrouter_unreviewed_extra",
          role: "reviewrouter_unreviewed_extra",
          usage: true,
          set: true,
        });
      },
    ],
  ])("rejects %s", (_name, mutate) => {
    const malformed = policy("preactivation");
    mutate(malformed);
    expect(() =>
      parsePrivatePg17ActivationCatalogPolicyCandidate(
        envelope(malformed, policy("activated")),
      ),
    ).toThrow("activation_catalog_policy_candidate_invalid:preactivation");
  });

  it("preserves the sanitized validation error as the cause", () => {
    const malformed = policy("preactivation");
    malformed.roles[0]!.name = "secret-canary";

    let caught: unknown;
    try {
      parsePrivatePg17ActivationCatalogPolicyCandidate(
        envelope(malformed, policy("activated")),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error;
    expect(error.message).toBe(
      "activation_catalog_policy_candidate_invalid:preactivation:role-name",
    );
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).message).toBe("role-name");
    expect(String(error)).not.toContain("secret-canary");
  });

  it("exports the same pure, secret-safe parser used by the CLI adapter", () => {
    const stdout = envelope(policy("preactivation"), policy("activated"));

    expect(parsePrivatePg17ActivationCatalogPolicyCandidate(stdout)).toEqual({
      kind: "reviewrouter-activation-catalog-policy-artifact-candidate",
      version: 1,
      policies: {
        preactivation: policy("preactivation"),
        activated: policy("activated"),
      },
    });
    expect(() =>
      parsePrivatePg17ActivationCatalogPolicyCandidate(
        '{"password":"secret-canary"',
      ),
    ).toThrow("activation_catalog_policy_candidate_output_invalid");
    try {
      parsePrivatePg17ActivationCatalogPolicyCandidate(
        '{"password":"secret-canary"',
      );
    } catch (error) {
      expect(String(error)).not.toContain("secret-canary");
    }
  });

  it("requires one exact atomic pair envelope", () => {
    const split = `${JSON.stringify({ preactivation: policy("preactivation") })}\n${JSON.stringify({ activated: policy("activated") })}\n`;
    expect(() =>
      parsePrivatePg17ActivationCatalogPolicyCandidate(split),
    ).toThrow("activation_catalog_policy_candidate_envelope_invalid");
    expect(() =>
      parsePrivatePg17ActivationCatalogPolicyCandidate(
        `${envelope(policy("preactivation"), policy("activated"))}${JSON.stringify({ extra: true })}\n`,
      ),
    ).toThrow("activation_catalog_policy_candidate_envelope_invalid");
    expect(() =>
      parsePrivatePg17ActivationCatalogPolicyCandidate(
        `${JSON.stringify({
          preactivation: policy("preactivation"),
          activated: policy("activated"),
          duplicate: policy("activated"),
        })}\n`,
      ),
    ).toThrow("activation_catalog_policy_candidate_envelope_invalid");
  });

  it("rejects rehearsal resources and duplicate normalized grant identities", () => {
    const rehearsal = {
      ...policy("preactivation"),
      rowSecurity: [
        {
          relation: "public.rehearsal_items",
          owner: "reviewrouter_role_bootstrap",
          policies: [],
        },
      ],
    };
    expect(() =>
      parsePrivatePg17ActivationCatalogPolicyCandidate(
        envelope(rehearsal, policy("activated")),
      ),
    ).toThrow("activation_catalog_policy_candidate_invalid:preactivation");

    const grant = {
      principal: "reviewrouter_api",
      capability: "table:read",
      resource: "relation:public.items",
      source: "privilege",
      grantable: false,
      grantor: "reviewrouter_release_migration",
    };
    const duplicate = {
      ...policy("activated"),
      grants: [grant, { ...grant }],
    };
    expect(() =>
      parsePrivatePg17ActivationCatalogPolicyCandidate(
        envelope(policy("preactivation"), duplicate),
      ),
    ).toThrow("activation_catalog_policy_candidate_invalid:activated");
  });

  it("accepts only provider-neutral, uniquely named extension authority", () => {
    const extension = {
      ...policy("preactivation"),
      extensions: [
        {
          name: "pgcrypto",
          owner: { kind: "principal", name: "reviewrouter_role_bootstrap" },
        },
        {
          name: "plpgsql",
          owner: { kind: "external-provider-authority" },
        },
      ],
    };
    expect(
      parsePrivatePg17ActivationCatalogPolicyCandidate(
        envelope(extension, policy("activated")),
      ).policies.preactivation.extensions,
    ).toHaveLength(2);
    expect(() =>
      parsePrivatePg17ActivationCatalogPolicyCandidate(
        envelope(
          {
            ...extension,
            extensions: [{ name: "pgcrypto", owner: "provider-role" }],
          },
          policy("activated"),
        ),
      ),
    ).toThrow("activation_catalog_policy_candidate_invalid:preactivation");
  });

  it("rejects a provider-local role even when it is otherwise harmless", () => {
    const providerNamed = {
      ...policy("preactivation"),
      roles: [
        ...policy("preactivation").roles,
        { name: "managed_provider_administrator" },
      ],
    };
    expect(() =>
      parsePrivatePg17ActivationCatalogPolicyCandidate(
        envelope(providerNamed, policy("activated")),
      ),
    ).toThrow("activation_catalog_policy_candidate_invalid:preactivation");
  });

  it.each([
    [
      "role flags",
      (value: ReturnType<typeof policy>) => {
        value.roles[0]!.superuser = true;
      },
    ],
    [
      "schema-owner final membership",
      (value: ReturnType<typeof policy>) => {
        (value.memberships as Array<Record<string, unknown>>).splice(3, 0, {
          ...value.memberships[0]!,
          role: "reviewrouter_release_schema_owner",
        });
      },
    ],
    [
      "non-self reachability",
      (value: ReturnType<typeof policy>) => {
        value.roleReachability[0]!.role = "reviewrouter_api";
      },
    ],
    [
      "nested row-security shape",
      (value: ReturnType<typeof policy>) => {
        value.rowSecurity.push({
          relation: "public.items",
          owner: "reviewrouter_release_schema_owner",
          enabled: false,
          forced: false,
          policies: [{ name: "read", command: "r", permissive: true }],
        });
      },
    ],
    [
      "nested permission shape",
      (value: ReturnType<typeof policy>) => {
        value.effectivePermissions[0]!.permissions.push({
          capability: "database:connect",
          resource: "database:review_router",
          unexpected: true,
        });
      },
    ],
  ])("rejects malformed %s", (_name, mutate) => {
    const malformed = policy("preactivation");
    mutate(malformed);
    expect(() =>
      parsePrivatePg17ActivationCatalogPolicyCandidate(
        envelope(malformed, policy("activated")),
      ),
    ).toThrow("activation_catalog_policy_candidate_invalid:preactivation");
  });
});
