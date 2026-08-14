import { canonicalJson, sha256Canonical } from "./release-rollout";

export const PrincipalCapability = Object.freeze({
  Connect: "database:connect",
  CreateDatabaseObject: "database:create",
  Temporary: "database:temporary",
  SchemaUsage: "schema:usage",
  CreateSchemaObject: "schema:create",
  TableRead: "table:read",
  TableInsert: "table:insert",
  TableUpdate: "table:update",
  TableDelete: "table:delete",
  TableTruncate: "table:truncate",
  TableTrigger: "table:trigger",
  TableReferences: "table:references",
  ColumnRead: "column:read",
  ColumnInsert: "column:insert",
  ColumnUpdate: "column:update",
  ColumnReferences: "column:references",
  SequenceUsage: "sequence:usage",
  SequenceRead: "sequence:read",
  SequenceUpdate: "sequence:update",
  RoutineExecute: "routine:execute",
  TypeUsage: "type:usage",
  OwnDatabase: "owner:database",
  OwnSchema: "owner:schema",
  OwnObject: "owner:object",
  Superuser: "admin:superuser",
  BypassRls: "admin:bypassrls",
  Replication: "admin:replication",
  CreateDatabase: "admin:createdb",
  CreateRole: "admin:createrole",
  AdministerMembership: "admin:role-membership",
} as const);
export type PrincipalCapability =
  (typeof PrincipalCapability)[keyof typeof PrincipalCapability];

export interface EffectivePrincipalRole {
  readonly name: string;
  readonly canLogin: boolean;
  readonly inherit: boolean;
  readonly superuser: boolean;
  readonly bypassRls: boolean;
  readonly replication: boolean;
  readonly createDatabase: boolean;
  readonly createRole: boolean;
  readonly connectionLimit: number;
  readonly validUntil: string | null;
}
export interface EffectivePrincipalMembership {
  readonly member: string;
  readonly role: string;
  /** PostgreSQL 16+ membership option controlling SET ROLE. */
  readonly setOption: boolean;
  readonly inheritOption: boolean;
  readonly adminOption: boolean;
  readonly grantor: string;
}
export interface EffectivePrincipalGrant {
  readonly principal: string;
  readonly capability: PrincipalCapability;
  /** Provider-neutral stable identity, e.g. database, schema, table, column or routine. */
  readonly resource: string;
  readonly source: "attribute" | "ownership" | "privilege" | "public";
}
export interface EffectivePrincipalInventory {
  readonly version: 1;
  readonly database: string;
  readonly sessionPrincipal: string;
  readonly roles: readonly EffectivePrincipalRole[];
  readonly memberships: readonly EffectivePrincipalMembership[];
  readonly grants: readonly EffectivePrincipalGrant[];
}
export interface EffectivePrincipalPermission {
  readonly capability: PrincipalCapability;
  readonly resource: string;
}
export interface EffectivePrincipalRule {
  readonly principal: string;
  readonly mayLogin: boolean;
  readonly inherit: boolean;
  readonly connectionLimit: number;
  readonly validUntil: string | null;
  readonly permissions: readonly EffectivePrincipalPermission[];
}
export interface EffectivePrincipalPolicy {
  readonly version: 1;
  readonly publicPermissions: readonly EffectivePrincipalPermission[];
  readonly principals: readonly EffectivePrincipalRule[];
}
export interface EffectivePrincipalDecision {
  readonly accepted: boolean;
  readonly inventorySha256: string;
  readonly policySha256: string;
  readonly violations: readonly string[];
  readonly effectivePermissions: Readonly<
    Record<string, readonly EffectivePrincipalPermission[]>
  >;
}

const capabilities = new Set<string>(Object.values(PrincipalCapability));
const safeText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && !value.includes("\0");
const permissionKey = (value: EffectivePrincipalPermission): string =>
  `${value.capability}\0${value.resource}`;
const sortedUnique = <T>(items: readonly T[], key: (value: T) => string): T[] =>
  [...new Map(items.map((item) => [key(item), item])).values()].sort((a, b) =>
    key(a).localeCompare(key(b)),
  );

export function canonicalEffectivePrincipalPolicy(
  policy: EffectivePrincipalPolicy,
): EffectivePrincipalPolicy {
  return Object.freeze({
    version: policy.version,
    publicPermissions: Object.freeze(
      sortedUnique(policy.publicPermissions, permissionKey),
    ),
    principals: Object.freeze(
      policy.principals
        .map((rule) =>
          Object.freeze({
            ...rule,
            permissions: Object.freeze(
              sortedUnique(rule.permissions, permissionKey),
            ),
          }),
        )
        .sort((left, right) => left.principal.localeCompare(right.principal)),
    ),
  });
}

/** Produces a review candidate; production gates must consume a checked-in/operator-reviewed policy. */
export function draftEffectivePrincipalPolicy(
  inventory: EffectivePrincipalInventory,
): EffectivePrincipalPolicy {
  const roles = new Map(inventory.roles.map((role) => [role.name, role]));
  const parents = new Map<string, EffectivePrincipalMembership[]>();
  for (const edge of inventory.memberships)
    parents.set(edge.member, [...(parents.get(edge.member) ?? []), edge]);
  const direct = new Map<string, EffectivePrincipalPermission[]>();
  for (const grant of inventory.grants)
    direct.set(grant.principal, [
      ...(direct.get(grant.principal) ?? []),
      { capability: grant.capability, resource: grant.resource },
    ]);
  const publicPermissions = sortedUnique(
    direct.get("PUBLIC") ?? [],
    permissionKey,
  );
  const permissionsFor = (start: string): EffectivePrincipalPermission[] => {
    const found = new Set([start]);
    const pending = [start];
    while (pending.length) {
      const current = pending.pop()!;
      for (const edge of parents.get(current) ?? [])
        if (
          ((roles.get(current)?.inherit && edge.inheritOption) ||
            edge.setOption) &&
          !found.has(edge.role)
        ) {
          found.add(edge.role);
          pending.push(edge.role);
        }
    }
    return sortedUnique(
      [
        ...publicPermissions,
        ...[...found].flatMap((role) => direct.get(role) ?? []),
      ],
      permissionKey,
    );
  };
  return canonicalEffectivePrincipalPolicy({
    version: 1,
    publicPermissions,
    principals: inventory.roles.map((role) => ({
      principal: role.name,
      mayLogin: role.canLogin,
      inherit: role.inherit,
      connectionLimit: role.connectionLimit,
      validUntil: role.validUntil,
      permissions: permissionsFor(role.name),
    })),
  });
}

/** Pure, provider-neutral fail-closed policy for PostgreSQL-derived facts. */
export function evaluateEffectivePrincipalInventory(
  inventory: EffectivePrincipalInventory,
  policy: EffectivePrincipalPolicy,
): EffectivePrincipalDecision {
  if (inventory.version !== 1 || policy.version !== 1)
    throw new Error("effective_principal_contract_version_invalid");
  const violations: string[] = [];
  if (!safeText(inventory.database) || !safeText(inventory.sessionPrincipal))
    violations.push("inventory_identity_invalid");
  for (const role of inventory.roles)
    if (
      !safeText(role.name) ||
      [
        role.canLogin,
        role.inherit,
        role.superuser,
        role.bypassRls,
        role.replication,
        role.createDatabase,
        role.createRole,
      ].some((value) => typeof value !== "boolean") ||
      !Number.isInteger(role.connectionLimit) ||
      (role.validUntil !== null && typeof role.validUntil !== "string")
    )
      violations.push("role_inventory_invalid");
  for (const grant of inventory.grants)
    if (
      !safeText(grant.principal) ||
      !safeText(grant.resource) ||
      !capabilities.has(grant.capability) ||
      !["attribute", "ownership", "privilege", "public"].includes(grant.source)
    )
      violations.push("grant_inventory_invalid");
  for (const edge of inventory.memberships)
    if (
      !safeText(edge.member) ||
      !safeText(edge.role) ||
      !safeText(edge.grantor) ||
      typeof edge.setOption !== "boolean" ||
      typeof edge.inheritOption !== "boolean" ||
      typeof edge.adminOption !== "boolean"
    )
      violations.push("membership_inventory_invalid");
  for (const rule of policy.principals)
    if (
      !safeText(rule.principal) ||
      typeof rule.mayLogin !== "boolean" ||
      typeof rule.inherit !== "boolean" ||
      !Number.isInteger(rule.connectionLimit) ||
      (rule.validUntil !== null && typeof rule.validUntil !== "string") ||
      !Array.isArray(rule.permissions) ||
      rule.permissions.some(
        (permission) =>
          !capabilities.has(permission.capability) ||
          !safeText(permission.resource),
      )
    )
      violations.push("principal_policy_invalid");
    else if (
      new Set(rule.permissions.map(permissionKey)).size !==
      rule.permissions.length
    )
      violations.push(
        `principal_policy_duplicate_permission:${rule.principal}`,
      );
  if (
    !Array.isArray(policy.publicPermissions) ||
    policy.publicPermissions.some(
      (permission) =>
        !capabilities.has(permission.capability) ||
        !safeText(permission.resource),
    )
  )
    violations.push("public_policy_invalid");
  const roles = new Map(inventory.roles.map((role) => [role.name, role]));
  if (roles.size !== inventory.roles.length || roles.has("PUBLIC"))
    violations.push("role_inventory_noncanonical");
  const rules = new Map(
    policy.principals.map((rule) => [rule.principal, rule]),
  );
  if (rules.size !== policy.principals.length || rules.has("PUBLIC"))
    violations.push("principal_policy_noncanonical");

  const parents = new Map<string, EffectivePrincipalMembership[]>();
  for (const edge of inventory.memberships) {
    if (!roles.has(edge.member) || !roles.has(edge.role)) {
      violations.push(`membership_unknown_role:${edge.member}:${edge.role}`);
      continue;
    }
    parents.set(edge.member, [...(parents.get(edge.member) ?? []), edge]);
  }
  const reachable = (start: string): Set<string> => {
    const found = new Set([start]);
    const active = new Set<string>();
    const visit = (current: string): void => {
      if (active.has(current)) {
        violations.push(`membership_cycle:${[...active, current].join("->")}`);
        return;
      }
      active.add(current);
      for (const edge of parents.get(current) ?? []) {
        // A login can acquire a parent through inheritance or an explicit SET ROLE.
        if (
          (roles.get(current)?.inherit && edge.inheritOption) ||
          edge.setOption
        ) {
          found.add(edge.role);
          visit(edge.role);
        }
      }
      active.delete(current);
    };
    visit(start);
    return found;
  };

  const direct = new Map<string, EffectivePrincipalPermission[]>();
  for (const grant of inventory.grants) {
    if (grant.principal !== "PUBLIC" && !roles.has(grant.principal))
      violations.push(`grant_unknown_principal:${grant.principal}`);
    direct.set(grant.principal, [
      ...(direct.get(grant.principal) ?? []),
      { capability: grant.capability, resource: grant.resource },
    ]);
  }
  const publicPermissions = sortedUnique(
    direct.get("PUBLIC") ?? [],
    permissionKey,
  );
  const effectivePermissions: Record<
    string,
    readonly EffectivePrincipalPermission[]
  > = {};
  for (const role of inventory.roles) {
    const permissions = [...publicPermissions];
    for (const reachableRole of reachable(role.name))
      permissions.push(...(direct.get(reachableRole) ?? []));
    effectivePermissions[role.name] = sortedUnique(permissions, permissionKey);
    const rule = rules.get(role.name);
    if (role.canLogin && (!rule || !rule.mayLogin))
      violations.push(`unexpected_login:${role.name}`);
    if (rule && rule.mayLogin !== role.canLogin)
      violations.push(`login_attribute_mismatch:${role.name}`);
    if (
      rule &&
      (rule.inherit !== role.inherit ||
        rule.connectionLimit !== role.connectionLimit ||
        rule.validUntil !== role.validUntil)
    )
      violations.push(`role_attribute_mismatch:${role.name}`);
    if (!rule && effectivePermissions[role.name]!.length)
      violations.push(`unexpected_effective_principal:${role.name}`);
    const allowed = new Set((rule?.permissions ?? []).map(permissionKey));
    const observed = new Set(
      effectivePermissions[role.name]!.map(permissionKey),
    );
    for (const permission of effectivePermissions[role.name]!) {
      if (!allowed.has(permissionKey(permission)))
        violations.push(
          `unexpected_permission:${role.name}:${permission.capability}:${permission.resource}`,
        );
    }
    for (const required of allowed)
      if (!observed.has(required))
        violations.push(
          `required_permission_missing:${role.name}:${required.replace("\0", ":")}`,
        );
  }
  const allowedPublic = new Set(policy.publicPermissions.map(permissionKey));
  const observedPublic = new Set(publicPermissions.map(permissionKey));
  for (const permission of publicPermissions)
    if (!allowedPublic.has(permissionKey(permission)))
      violations.push(
        `unexpected_public_permission:${permission.capability}:${permission.resource}`,
      );
  for (const required of allowedPublic)
    if (!observedPublic.has(required))
      violations.push(
        `required_public_permission_missing:${required.replace("\0", ":")}`,
      );
  for (const rule of policy.principals)
    if (!roles.has(rule.principal))
      violations.push(`approved_role_missing:${rule.principal}`);

  return Object.freeze({
    accepted: violations.length === 0,
    inventorySha256: `sha256:${sha256Canonical(inventory)}`,
    policySha256: `sha256:${sha256Canonical(canonicalEffectivePrincipalPolicy(policy))}`,
    violations: Object.freeze([...new Set(violations)].sort()),
    effectivePermissions: Object.freeze(effectivePermissions),
  });
}

export function assertEffectivePrincipalInventory(
  inventory: EffectivePrincipalInventory,
  policy: EffectivePrincipalPolicy,
): EffectivePrincipalDecision {
  const decision = evaluateEffectivePrincipalInventory(inventory, policy);
  if (!decision.accepted)
    throw new Error(
      `effective_principal_policy_rejected:${canonicalJson(decision.violations)}`,
    );
  return decision;
}
