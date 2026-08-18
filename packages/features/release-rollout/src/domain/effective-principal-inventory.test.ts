import { describe, expect, it } from "vitest";
import {
  draftEffectivePrincipalPolicy,
  evaluateEffectivePrincipalInventory,
  PrincipalCapability,
  type EffectivePrincipalInventory,
  type EffectivePrincipalPolicy,
} from "./effective-principal-inventory";

const role = (
  name: string,
  overrides: Partial<EffectivePrincipalInventory["roles"][number]> = {},
) => ({
  name,
  canLogin: true,
  inherit: true,
  superuser: false,
  bypassRls: false,
  replication: false,
  createDatabase: false,
  createRole: false,
  connectionLimit: -1,
  validUntil: null,
  ...overrides,
});
const permission = (
  capability: (typeof PrincipalCapability)[keyof typeof PrincipalCapability],
  resource: string,
) => ({ capability, resource });
const baseInventory = (): EffectivePrincipalInventory => ({
  version: 1,
  database: "review_router",
  sessionPrincipal: "fence_authority",
  roles: [role("runtime")],
  memberships: [],
  grants: [
    {
      principal: "runtime",
      ...permission(PrincipalCapability.Connect, "database:review_router"),
      source: "privilege",
    },
    {
      principal: "runtime",
      ...permission(PrincipalCapability.TableUpdate, 'relation:public."Item"'),
      source: "privilege",
    },
  ],
});
const basePolicy = (): EffectivePrincipalPolicy => ({
  version: 1,
  publicPermissions: [],
  principals: [
    {
      principal: "runtime",
      mayLogin: true,
      inherit: true,
      connectionLimit: -1,
      validUntil: null,
      permissions: [
        permission(PrincipalCapability.Connect, "database:review_router"),
        permission(PrincipalCapability.TableUpdate, 'relation:public."Item"'),
      ],
    },
  ],
});

describe("effective principal policy", () => {
  it("accepts the exact canonical principal and privilege matrix", () => {
    expect(
      evaluateEffectivePrincipalInventory(baseInventory(), basePolicy()),
    ).toMatchObject({ accepted: true, violations: [] });
  });

  it("drafts a canonical review candidate without weakening later drift checks", () => {
    const inventory = baseInventory();
    const drafted = draftEffectivePrincipalPolicy(inventory);
    expect(
      evaluateEffectivePrincipalInventory(inventory, drafted).accepted,
    ).toBe(true);
    expect(
      evaluateEffectivePrincipalInventory(
        {
          ...inventory,
          grants: [
            ...inventory.grants,
            {
              principal: "runtime",
              capability: PrincipalCapability.TableDelete,
              resource: 'relation:public."Item"',
              source: "privilege",
            },
          ],
        },
        drafted,
      ).accepted,
    ).toBe(false);
  });

  it("keeps PostgreSQL 17 SELECT and MAINTAIN distinct and rejects duplicate grant identities", () => {
    const inventory: EffectivePrincipalInventory = {
      ...baseInventory(),
      grants: [
        {
          principal: "runtime",
          capability: PrincipalCapability.TableRead,
          resource: "relation:public.items",
          source: "privilege",
          grantable: false,
          grantor: "owner",
        },
        {
          principal: "runtime",
          capability: PrincipalCapability.TableMaintain,
          resource: "relation:public.items",
          source: "privilege",
          grantable: false,
          grantor: "owner",
        },
      ],
    };
    const permissions =
      draftEffectivePrincipalPolicy(inventory).principals[0]!.permissions;
    expect(permissions).toEqual([
      permission(PrincipalCapability.TableMaintain, "relation:public.items"),
      permission(PrincipalCapability.TableRead, "relation:public.items"),
    ]);
    expect(
      evaluateEffectivePrincipalInventory(
        { ...inventory, grants: [...inventory.grants, inventory.grants[0]!] },
        draftEffectivePrincipalPolicy(inventory),
      ).violations,
    ).toContain("grant_inventory_duplicate_identity");
  });

  it("rejects a required principal whose complete permission set disappeared", () => {
    const decision = evaluateEffectivePrincipalInventory(
      { ...baseInventory(), grants: [] },
      basePolicy(),
    );

    expect(decision.accepted).toBe(false);
    expect(decision.violations).toContain(
      "required_permission_missing:runtime:database:connect:database:review_router",
    );
    expect(decision.violations).toContain(
      'required_permission_missing:runtime:table:update:relation:public."Item"',
    );
  });

  it.each([
    [PrincipalCapability.Superuser, "cluster"],
    [PrincipalCapability.BypassRls, "cluster"],
    [PrincipalCapability.ColumnUpdate, 'column:public."Item"."secret"'],
    [PrincipalCapability.SequenceUsage, 'sequence:public."Item_id_seq"'],
    [PrincipalCapability.RoutineExecute, "routine:public.write_item(text)"],
  ])("fails closed for adversarial %s capability", (capability, resource) => {
    const inventory = baseInventory();
    const attacked = {
      ...inventory,
      grants: [
        ...inventory.grants,
        {
          principal: "runtime",
          capability,
          resource,
          source: "privilege" as const,
        },
      ],
    };
    expect(
      evaluateEffectivePrincipalInventory(attacked, basePolicy()),
    ).toMatchObject({
      accepted: false,
    });
  });

  it("rejects PUBLIC, an unlisted direct login, and a quoted owner", () => {
    const inventory = baseInventory();
    const attacked: EffectivePrincipalInventory = {
      ...inventory,
      roles: [...inventory.roles, role('external "writer"')],
      grants: [
        ...inventory.grants,
        {
          principal: "PUBLIC",
          capability: PrincipalCapability.RoutineExecute,
          resource: "routine:public.write_anything()",
          source: "public",
        },
        {
          principal: 'external "writer"',
          capability: PrincipalCapability.OwnObject,
          resource: 'relation:public."Item"',
          source: "ownership",
        },
      ],
    };
    const violations = evaluateEffectivePrincipalInventory(
      attacked,
      basePolicy(),
    ).violations.join("\n");
    expect(violations).toContain('unexpected_login:external "writer"');
    expect(violations).toContain(
      "unexpected_public_permission:routine:execute",
    );
    expect(violations).toContain(
      'unexpected_effective_principal:external "writer"',
    );
  });

  it("follows inherited and SET ROLE chains and rejects membership cycles", () => {
    const inventory: EffectivePrincipalInventory = {
      ...baseInventory(),
      roles: [role("runtime"), role("writer_parent", { canLogin: false })],
      memberships: [
        {
          member: "runtime",
          role: "writer_parent",
          inheritOption: false,
          setOption: true,
          adminOption: false,
          grantor: "runtime",
        },
        {
          member: "writer_parent",
          role: "runtime",
          inheritOption: true,
          setOption: false,
          adminOption: false,
          grantor: "runtime",
        },
      ],
      grants: [
        ...baseInventory().grants,
        {
          principal: "writer_parent",
          capability: PrincipalCapability.TableDelete,
          resource: 'relation:public."Item"',
          source: "privilege",
        },
      ],
    };
    const violations = evaluateEffectivePrincipalInventory(
      inventory,
      basePolicy(),
    ).violations.join("\n");
    expect(violations).toContain("membership_cycle:");
    expect(violations).toContain("unexpected_permission:runtime:table:delete");
  });
});
