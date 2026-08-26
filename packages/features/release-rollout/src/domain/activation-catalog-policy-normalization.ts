import { canonicalJson } from "./canonical-json";
import {
  PrincipalCapability,
  canonicalActivationPrincipalNames,
  canonicalBootstrapMembershipRoleNames,
  type ActivationCatalogPolicy,
} from "./effective-principal-inventory";

export type ActivationCatalogPolicyPhase = "preactivation" | "activated";

export type ActivationCatalogPolicyNormalizationProfile = Readonly<{
  principalNames: readonly string[];
  bootstrapMembershipRoleNames: readonly string[];
  noLoginPrincipalNames: readonly string[];
  createRolePrincipalNames: readonly string[];
}>;

const policyFields = [
  "kind",
  "version",
  "phase",
  "database",
  "roles",
  "memberships",
  "roleReachability",
  "rowSecurity",
  "extensions",
  "grants",
  "effectivePermissions",
] as const;
const roleFields = [
  "name",
  "canLogin",
  "inherit",
  "superuser",
  "bypassRls",
  "replication",
  "createDatabase",
  "createRole",
  "connectionLimit",
  "validUntil",
] as const;
const membershipFields = [
  "member",
  "role",
  "setOption",
  "inheritOption",
  "adminOption",
  "grantor",
] as const;
const rowSecurityFields = [
  "relation",
  "owner",
  "enabled",
  "forced",
  "policies",
] as const;
const rowSecurityPolicyFields = [
  "name",
  "command",
  "permissive",
  "using",
  "withCheck",
  "roles",
] as const;
const grantFields = [
  "principal",
  "capability",
  "resource",
  "source",
  "grantable",
  "grantor",
] as const;
const canonicalCapabilities = new Set<string>(
  Object.values(PrincipalCapability),
);
const grantSources = new Set(["attribute", "ownership", "privilege", "public"]);
const rehearsalIdentifier =
  /(?:rehearsal(?:_|items)|app_private|rr_(?:direct|parent|inherited|set_|owner|super|bypass|column|sequence|routine))/u;

export const productionActivationCatalogPolicyNormalizationProfile =
  Object.freeze({
    principalNames: canonicalActivationPrincipalNames,
    bootstrapMembershipRoleNames: canonicalBootstrapMembershipRoleNames,
    noLoginPrincipalNames: Object.freeze([
      "reviewrouter_activation_receipt_guard",
      "reviewrouter_release_schema_owner",
    ]),
    createRolePrincipalNames: Object.freeze([]),
  });

/**
 * Candidate topology is deliberately private to this normalization module.
 * Only the explicitly capture-scoped assertion below can consume it; package
 * exports and production activation paths retain the reviewed canonical root.
 */
const pendingActivationCatalogPolicyNormalizationProfile = Object.freeze({
  principalNames: Object.freeze([
    "reviewrouter_activation_permit_installer",
    "reviewrouter_activation_receipt_guard",
    "reviewrouter_activation_receipt_reader",
    "reviewrouter_api",
    "reviewrouter_comment_token_custody",
    "reviewrouter_codex_effect_authority",
    "reviewrouter_release_migration",
    "reviewrouter_release_schema_owner",
    "reviewrouter_role_bootstrap",
    "reviewrouter_web",
    "reviewrouter_worker",
  ]),
  bootstrapMembershipRoleNames: Object.freeze([
    "reviewrouter_api",
    "reviewrouter_comment_token_custody",
    "reviewrouter_codex_effect_authority",
    "reviewrouter_release_migration",
    "reviewrouter_web",
    "reviewrouter_worker",
  ]),
  noLoginPrincipalNames: Object.freeze([
    "reviewrouter_activation_receipt_guard",
    "reviewrouter_release_schema_owner",
  ]),
  createRolePrincipalNames: Object.freeze([]),
});

export function assertPendingActivationCatalogPolicyCaptureNormalization(
  value: unknown,
  phase: ActivationCatalogPolicyPhase,
): asserts value is ActivationCatalogPolicy {
  assertActivationCatalogPolicyNormalizationForProfile(
    value,
    phase,
    pendingActivationCatalogPolicyNormalizationProfile,
  );
}

export function assertActivationCatalogPolicyNormalizationForProfile(
  value: unknown,
  phase: ActivationCatalogPolicyPhase,
  profile: ActivationCatalogPolicyNormalizationProfile,
): asserts value is ActivationCatalogPolicy {
  const principals = new Set(profile.principalNames);
  const noLogin = new Set(profile.noLoginPrincipalNames);
  const createRole = new Set(profile.createRolePrincipalNames);
  if (
    !isExactRecord(value, policyFields) ||
    value.kind !== "reviewrouter-activation-catalog-policy" ||
    value.version !== 1 ||
    value.phase !== phase ||
    value.database !== "review_router" ||
    !policyFields.slice(4).every((field) => Array.isArray(value[field]))
  )
    throw new Error("policy");

  const roles = value.roles as unknown[];
  if (roles.length !== profile.principalNames.length) throw new Error("roles");
  roles.forEach((role, index) => {
    const expectedName = profile.principalNames[index];
    if (
      !isExactRecord(role, roleFields) ||
      role.name !== expectedName ||
      role.canLogin !== !noLogin.has(expectedName!) ||
      role.inherit !== true ||
      role.superuser !== false ||
      role.bypassRls !== false ||
      role.replication !== false ||
      role.createDatabase !== false ||
      role.createRole !== createRole.has(expectedName!) ||
      role.connectionLimit !== -1 ||
      role.validUntil !== null
    )
      throw new Error("role");
  });

  const memberships = value.memberships as unknown[];
  if (memberships.length !== profile.bootstrapMembershipRoleNames.length)
    throw new Error("memberships");
  memberships.forEach((membership, index) => {
    if (
      !isExactRecord(membership, membershipFields) ||
      membership.member !== "reviewrouter_role_bootstrap" ||
      membership.role !== profile.bootstrapMembershipRoleNames[index] ||
      membership.setOption !== false ||
      membership.inheritOption !== false ||
      membership.adminOption !== true ||
      !isExactRecord(membership.grantor, ["kind"]) ||
      membership.grantor.kind !== "external-bootstrap-authority"
    )
      throw new Error("membership");
  });

  const expectedReachability = profile.principalNames.filter(
    (name) => !noLogin.has(name),
  );
  const reachability = value.roleReachability as unknown[];
  if (reachability.length !== expectedReachability.length)
    throw new Error("reachability");
  reachability.forEach((edge, index) => {
    const expectedName = expectedReachability[index];
    if (
      !isExactRecord(edge, ["principal", "role", "usage", "set"]) ||
      edge.principal !== expectedName ||
      edge.role !== expectedName ||
      edge.usage !== true ||
      edge.set !== true
    )
      throw new Error("reachability");
  });

  const rowSecurity = value.rowSecurity as Record<string, unknown>[];
  rowSecurity.forEach((relation) => {
    if (
      !isExactRecord(relation, rowSecurityFields) ||
      !isSafeText(relation.relation) ||
      !principals.has(String(relation.owner)) ||
      typeof relation.enabled !== "boolean" ||
      typeof relation.forced !== "boolean" ||
      !Array.isArray(relation.policies)
    )
      throw new Error("row-security");
    relation.policies.forEach((policy) => {
      if (
        !isExactRecord(policy, rowSecurityPolicyFields) ||
        !isSafeText(policy.name) ||
        !isSafeText(policy.command) ||
        typeof policy.permissive !== "boolean" ||
        !(policy.using === null || typeof policy.using === "string") ||
        !(policy.withCheck === null || typeof policy.withCheck === "string") ||
        !Array.isArray(policy.roles) ||
        !policy.roles.every(
          (role) => role === "PUBLIC" || principals.has(String(role)),
        ) ||
        !isOrderedUnique(policy.roles, (role) => String(role))
      )
        throw new Error("row-security-policy");
    });
    if (!isOrderedUnique(relation.policies, (policy) => String(policy.name)))
      throw new Error("row-security-policy-order");
  });
  if (!isOrderedUnique(rowSecurity, (relation) => String(relation.relation)))
    throw new Error("row-security-order");

  const extensions = value.extensions as Record<string, unknown>[];
  extensions.forEach((extension) => {
    if (
      !isExactRecord(extension, ["name", "owner"]) ||
      !isSafeText(extension.name) ||
      !isExactRecord(
        extension.owner,
        (extension.owner as Record<string, unknown>)?.kind === "principal"
          ? ["kind", "name"]
          : ["kind"],
      ) ||
      !(
        extension.owner.kind === "external-provider-authority" ||
        (extension.owner.kind === "principal" &&
          principals.has(String(extension.owner.name)))
      )
    )
      throw new Error("extension");
  });
  if (
    !isOrderedUnique(
      extensions,
      (extension) =>
        `${String(extension.name)}\0${canonicalJson(extension.owner)}`,
    )
  )
    throw new Error("extension-order");

  const grants = value.grants as Record<string, unknown>[];
  grants.forEach((grant) => {
    if (
      !isExactRecord(grant, grantFields) ||
      !(
        grant.principal === "PUBLIC" || principals.has(String(grant.principal))
      ) ||
      !canonicalCapabilities.has(String(grant.capability)) ||
      !isSafeText(grant.resource) ||
      !grantSources.has(String(grant.source)) ||
      typeof grant.grantable !== "boolean" ||
      !principals.has(String(grant.grantor))
    )
      throw new Error("grant");
  });
  if (!isOrderedUnique(grants, grantOrderKey)) throw new Error("grant-order");

  const effectivePermissions = value.effectivePermissions as Record<
    string,
    unknown
  >[];
  if (effectivePermissions.length !== profile.principalNames.length)
    throw new Error("effective-permissions");
  effectivePermissions.forEach((entry, index) => {
    if (
      !isExactRecord(entry, ["principal", "permissions"]) ||
      entry.principal !== profile.principalNames[index] ||
      !Array.isArray(entry.permissions)
    )
      throw new Error("effective-permissions");
    entry.permissions.forEach((permission) => {
      if (
        !isExactRecord(permission, ["capability", "resource"]) ||
        !canonicalCapabilities.has(String(permission.capability)) ||
        !isSafeText(permission.resource)
      )
        throw new Error("permission");
    });
    if (
      !isOrderedUnique(
        entry.permissions,
        (permission) =>
          `${String(permission.capability)}\0${String(permission.resource)}`,
      )
    )
      throw new Error("permission-order");
  });

  if (rehearsalIdentifier.test(canonicalJson(value)))
    throw new Error("rehearsal-resource");
}

function isExactRecord(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

function isSafeText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function isOrderedUnique<T>(
  values: readonly T[],
  key: (value: T) => string,
): boolean {
  let previous: string | undefined;
  for (const value of values) {
    const current = key(value);
    if (previous !== undefined && previous >= current) return false;
    previous = current;
  }
  return true;
}

function grantOrderKey(grant: Record<string, unknown>): string {
  return [
    grant.principal,
    grant.capability,
    grant.resource,
    grant.source,
    grant.grantable === true ? "1" : "0",
    grant.grantor,
  ]
    .map(String)
    .join("\0");
}
