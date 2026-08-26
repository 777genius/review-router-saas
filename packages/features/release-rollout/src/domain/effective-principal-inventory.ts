import { canonicalJson, sha256Canonical } from "./canonical-json";

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
  TableMaintain: "table:maintain",
  ColumnRead: "column:read",
  ColumnInsert: "column:insert",
  ColumnUpdate: "column:update",
  ColumnReferences: "column:references",
  SequenceUsage: "sequence:usage",
  SequenceRead: "sequence:read",
  SequenceUpdate: "sequence:update",
  RoutineExecute: "routine:execute",
  TypeUsage: "type:usage",
  LargeObjectRead: "large-object:read",
  LargeObjectWrite: "large-object:write",
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
  /** PostgreSQL delegation path; absent only in legacy version-1 observations. */
  readonly grantable?: boolean;
  /** Catalog-derived grantor; absent only in legacy version-1 observations. */
  readonly grantor?: string;
}
export interface EffectivePrincipalRoleReachability {
  readonly principal: string;
  readonly role: string;
  /** Native pg_has_role(..., 'USAGE') result, including nested membership. */
  readonly usage: boolean;
  /** Native pg_has_role(..., 'SET') result, including nested membership. */
  readonly set: boolean;
}
export interface EffectivePrincipalRowSecurity {
  readonly relation: string;
  readonly owner: string;
  readonly enabled: boolean;
  readonly forced: boolean;
  readonly policies: readonly Readonly<{
    name: string;
    command: string;
    permissive: boolean;
    using: string | null;
    withCheck: string | null;
    roles: readonly string[];
  }>[];
}
/**
 * Provider-neutral extension authority. Extension versions are deliberately
 * excluded: installed versions vary by provider patch cadence and do not
 * change who can ALTER, UPDATE, or DROP the extension.
 */
export interface EffectivePrincipalExtensionAuthority {
  readonly name: string;
  readonly owner: string;
}

export type ActivationCatalogAuthorityIdentity =
  | Readonly<{
      kind: "principal";
      name: string;
    }>
  | Readonly<{
      /** Provider-owned built-in extension authority, proven otherwise inert. */
      kind: "external-provider-authority";
    }>;

export interface ActivationCatalogExtensionAuthority {
  readonly name: string;
  readonly owner: ActivationCatalogAuthorityIdentity;
}
export interface EffectivePrincipalInventory {
  readonly version: 1;
  readonly database: string;
  readonly sessionPrincipal: string;
  readonly roles: readonly EffectivePrincipalRole[];
  readonly memberships: readonly EffectivePrincipalMembership[];
  /** Present in the server-derived activation projection contract. */
  readonly roleReachability?: readonly EffectivePrincipalRoleReachability[];
  /** Present in the server-derived activation projection contract. */
  readonly rowSecurity?: readonly EffectivePrincipalRowSecurity[];
  /** Present in the server-derived activation projection contract. */
  readonly extensions?: readonly EffectivePrincipalExtensionAuthority[];
  /** Stable family names whose authority is intentionally not projected. */
  readonly unsupportedAuthorityFamilies?: readonly string[];
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

/**
 * Stable identity used only for the provider-issued bootstrap memberships.
 * The raw inventory always retains the actual PostgreSQL grantor name.
 */
export const ActivationCatalogMembershipGrantorKind = Object.freeze({
  ExternalBootstrapAuthority: "external-bootstrap-authority",
} as const);

export type ActivationCatalogMembershipGrantor =
  | Readonly<{
      kind: typeof ActivationCatalogMembershipGrantorKind.ExternalBootstrapAuthority;
    }>
  | Readonly<{ kind: "principal"; name: string }>;

export interface ActivationCatalogMembership extends Omit<
  EffectivePrincipalMembership,
  "grantor"
> {
  readonly grantor: ActivationCatalogMembershipGrantor;
}

/** Domain-owned principal boundary shared by policy validation and adapters. */
export const canonicalActivationPrincipalNames = Object.freeze([
  "reviewrouter_activation_permit_installer",
  "reviewrouter_activation_receipt_guard",
  "reviewrouter_activation_receipt_reader",
  "reviewrouter_api",
  "reviewrouter_codex_effect_authority",
  "reviewrouter_release_migration",
  "reviewrouter_release_schema_owner",
  "reviewrouter_role_bootstrap",
  "reviewrouter_web",
  "reviewrouter_worker",
] as const);

/** Exact final provider-issued topology after the schema-owner handoff is revoked. */
export const canonicalBootstrapMembershipRoleNames = Object.freeze([
  "reviewrouter_api",
  "reviewrouter_codex_effect_authority",
  "reviewrouter_release_migration",
  "reviewrouter_web",
  "reviewrouter_worker",
] as const);
/**
 * Reviewed, phase-specific exact catalog contract consumed by target-local
 * activation. Array ordering is canonical and is part of the digest.
 */
export interface ActivationCatalogPolicy {
  readonly kind: "reviewrouter-activation-catalog-policy";
  readonly version: 1;
  readonly phase: "preactivation" | "activated";
  readonly database: string;
  readonly roles: readonly EffectivePrincipalRole[];
  readonly memberships: readonly ActivationCatalogMembership[];
  readonly roleReachability: readonly EffectivePrincipalRoleReachability[];
  readonly rowSecurity: readonly EffectivePrincipalRowSecurity[];
  readonly extensions: readonly ActivationCatalogExtensionAuthority[];
  readonly grants: readonly EffectivePrincipalGrant[];
  readonly effectivePermissions: readonly Readonly<{
    principal: string;
    permissions: readonly EffectivePrincipalPermission[];
  }>[];
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

export const ActivationPrincipalProjectionKind = Object.freeze({
  Projection: "reviewrouter-effective-principal-projection",
  Policy: "reviewrouter-effective-principal-policy",
} as const);
export const ActivationPrincipalPolicyPhase = Object.freeze({
  Preactivation: "preactivation",
  Activated: "activated",
} as const);
export const ActivationPrincipalViolationKind = Object.freeze({
  UnexpectedLogin: "unexpected_login",
  UnexpectedEffectiveRole: "unexpected_effective_role",
  UnexpectedPublicPermission: "unexpected_public_permission",
  UnexpectedAdministrativeCapability: "unexpected_administrative_capability",
  UnexpectedEffectivePermission: "unexpected_effective_permission",
  UnexpectedOwnership: "unexpected_ownership",
  UnexpectedRowSecurityPrincipal: "unexpected_row_security_principal",
  PrincipalLoginContractMismatch: "principal_login_contract_mismatch",
} as const);
export type ActivationPrincipalViolationKind =
  (typeof ActivationPrincipalViolationKind)[keyof typeof ActivationPrincipalViolationKind];

/** Guard-private catalog evidence. Only its canonical digests cross the adapter boundary. */
export interface ServerDerivedActivationPrincipalProjection {
  readonly kind: typeof ActivationPrincipalProjectionKind.Projection;
  readonly version: 2;
  readonly inventory: EffectivePrincipalInventory;
  readonly catalogPolicy: ActivationCatalogPolicy;
  readonly policy: Readonly<{
    kind: typeof ActivationPrincipalProjectionKind.Policy;
    version: 2;
    phase: (typeof ActivationPrincipalPolicyPhase)[keyof typeof ActivationPrincipalPolicyPhase];
    allowedPrincipals: readonly string[];
    publicPermissionKinds: readonly PrincipalCapability[];
    rowSecurity: readonly EffectivePrincipalRowSecurity[];
    violations: readonly Readonly<{
      kind: ActivationPrincipalViolationKind;
      principal: string;
      capability?: PrincipalCapability;
      resource?: string;
    }>[];
  }>;
}

const capabilities = new Set<string>(Object.values(PrincipalCapability));
const safeText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && !value.includes("\0");
const permissionKey = (value: EffectivePrincipalPermission): string =>
  `${value.capability}\0${value.resource}`;
const grantIdentityKey = (value: EffectivePrincipalGrant): string =>
  canonicalJson([
    value.principal,
    value.capability,
    value.resource,
    value.source,
    value.grantable,
    value.grantor,
  ]);
const compareCanonicalText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const sortedUnique = <T>(items: readonly T[], key: (value: T) => string): T[] =>
  [...new Map(items.map((item) => [key(item), item])).values()].sort((a, b) =>
    compareCanonicalText(key(a), key(b)),
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
        .sort((left, right) =>
          compareCanonicalText(left.principal, right.principal),
        ),
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
  if (
    new Set(inventory.grants.map(grantIdentityKey)).size !==
    inventory.grants.length
  )
    violations.push("grant_inventory_duplicate_identity");
  if (inventory.unsupportedAuthorityFamilies?.length)
    violations.push("unsupported_catalog_authority");
  for (const extension of inventory.extensions ?? [])
    if (!safeText(extension.name) || !safeText(extension.owner))
      violations.push("extension_authority_invalid");
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
