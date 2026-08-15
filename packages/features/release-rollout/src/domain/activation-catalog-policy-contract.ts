import { canonicalJson, sha256Canonical } from "./release-rollout";
import generatedActivationCatalogPolicyArtifact from "./activation-catalog-policy-artifact.generated.js";
import {
  PrincipalCapability,
  canonicalActivationPrincipalNames,
  canonicalBootstrapMembershipRoleNames,
  type ActivationCatalogPolicy,
} from "./effective-principal-inventory";

export type ActivationCatalogPolicyPhase = "preactivation" | "activated";

export type PinnedActivationCatalogPolicy = Readonly<{
  policy: ActivationCatalogPolicy;
  sha256: string;
}>;

export type ActivationCatalogPolicyDigests = Readonly<{
  preactivationCatalogPolicySha256: string;
  activatedCatalogPolicySha256: string;
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
// The checked-in v20 artifact remains independently pinned until the rollout
// orchestrator captures and promotes the schema-owner topology. Live capture
// uses canonicalActivationPrincipalNames; this validator deliberately proves
// only the immutable artifact that is currently promoted.
const promotedArtifactPrincipalNames = canonicalActivationPrincipalNames.filter(
  (name) => name !== "reviewrouter_release_schema_owner",
);
const promotedArtifactBootstrapMembershipRoleNames =
  canonicalBootstrapMembershipRoleNames.filter(
    (name) => name !== "reviewrouter_release_schema_owner",
  );
const canonicalPrincipals = new Set<string>(promotedArtifactPrincipalNames);
const canonicalCapabilities = new Set<string>(
  Object.values(PrincipalCapability),
);
const grantSources = new Set(["attribute", "ownership", "privilege", "public"]);
const rehearsalIdentifier =
  /(?:rehearsal(?:_|items)|app_private|rr_(?:direct|parent|inherited|set_|owner|super|bypass|column|sequence|routine))/u;

export const canonicalActivationCatalogPolicyTrustRootReadiness: Readonly<{
  status: "blocked" | "ready";
  reason: string;
}> = Object.freeze({
  status: "ready",
  reason:
    "reviewed-v20-production-shaped-pg17-candidate-promoted-with-pinned-phase-digests",
});

export function assertCanonicalActivationCatalogPolicyTrustRootReady(): void {
  if (canonicalActivationCatalogPolicyTrustRootReadiness.status !== "ready")
    throw new Error(
      `activation_catalog_policy_trust_root_blocked:${canonicalActivationCatalogPolicyTrustRootReadiness.reason}`,
    );
}

type ActivationCatalogPolicyArtifact = Readonly<{
  kind: "reviewrouter-activation-catalog-policy-artifact";
  version: 1;
  policies: Readonly<{
    preactivation: ActivationCatalogPolicy;
    activated: ActivationCatalogPolicy;
  }>;
}>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function cloneGeneratedArtifact(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function assertActivationCatalogPolicyArtifact(
  value: unknown,
): asserts value is ActivationCatalogPolicyArtifact {
  if (!isExactRecord(value, ["kind", "version", "policies"]))
    throw new Error("activation_catalog_policy_artifact_invalid");
  if (
    value.kind !== "reviewrouter-activation-catalog-policy-artifact" ||
    value.version !== 1 ||
    !isExactRecord(value.policies, ["preactivation", "activated"])
  )
    throw new Error("activation_catalog_policy_artifact_invalid");
  assertActivationCatalogPolicyNormalization(
    value.policies.preactivation,
    "preactivation",
  );
  assertActivationCatalogPolicyNormalization(
    value.policies.activated,
    "activated",
  );
}

const loadedActivationCatalogPolicyArtifact = cloneGeneratedArtifact(
  generatedActivationCatalogPolicyArtifact,
);
assertActivationCatalogPolicyArtifact(loadedActivationCatalogPolicyArtifact);
export const canonicalActivationCatalogPolicyArtifact = deepFreeze(
  loadedActivationCatalogPolicyArtifact,
);

const pin = (policy: ActivationCatalogPolicy): PinnedActivationCatalogPolicy =>
  Object.freeze({
    policy,
    sha256: `sha256:${sha256Canonical(policy)}`,
  });

export const canonicalActivationCatalogPolicies = Object.freeze({
  preactivation: pin(
    canonicalActivationCatalogPolicyArtifact.policies.preactivation,
  ),
  activated: pin(canonicalActivationCatalogPolicyArtifact.policies.activated),
});

export const canonicalActivationCatalogPolicyDigests = Object.freeze({
  preactivationCatalogPolicySha256:
    canonicalActivationCatalogPolicies.preactivation.sha256,
  activatedCatalogPolicySha256:
    canonicalActivationCatalogPolicies.activated.sha256,
});

export const reviewedActivationCatalogPolicyDigests = Object.freeze({
  preactivationCatalogPolicySha256:
    "sha256:c133bacb4a813540245430151ffd80f3380a4123ccc379250828d0317ac514d9",
  activatedCatalogPolicySha256:
    "sha256:7930dc496e760ae4f0577b50db1251f44c55f2db68bf97f790ce290edc8d5253",
});

if (
  !activationCatalogPolicyDigestsEqual(
    canonicalActivationCatalogPolicyDigests,
    reviewedActivationCatalogPolicyDigests,
  )
)
  throw new Error("activation_catalog_policy_reviewed_digest_drift");

const policyDigestPattern = /^sha256:[a-f0-9]{64}$/u;

/**
 * Authorizes the checked-in artifact with independently supplied compact
 * deployment configuration. There is intentionally no default argument: the
 * release artifact cannot authorize itself.
 */
export function authorizeCanonicalActivationCatalogPolicies(
  configured: ActivationCatalogPolicyDigests,
): typeof canonicalActivationCatalogPolicies {
  assertActivationCatalogPolicyNormalization(
    canonicalActivationCatalogPolicies.preactivation.policy,
    "preactivation",
  );
  assertActivationCatalogPolicyNormalization(
    canonicalActivationCatalogPolicies.activated.policy,
    "activated",
  );
  if (
    !policyDigestPattern.test(configured.preactivationCatalogPolicySha256) ||
    !policyDigestPattern.test(configured.activatedCatalogPolicySha256)
  )
    throw new Error("activation_catalog_policy_digest_invalid");
  if (!activationCatalogPolicyDigestsEqual(configured))
    throw new Error("activation_catalog_policy_digest_mismatch");
  assertCanonicalActivationCatalogPolicyTrustRootReady();
  return canonicalActivationCatalogPolicies;
}

export function assertActivationCatalogPolicyNormalization(
  value: unknown,
  phase: ActivationCatalogPolicyPhase,
): asserts value is ActivationCatalogPolicy {
  try {
    assertNormalizedPolicy(value, phase);
  } catch {
    throw new Error(`activation_catalog_policy_normalization_invalid:${phase}`);
  }
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

function assertUnique(values: readonly unknown[]): void {
  const keys = values.map((item) => canonicalJson(item));
  if (new Set(keys).size !== keys.length) throw new Error("duplicate");
}

function assertNormalizedPolicy(
  value: unknown,
  phase: ActivationCatalogPolicyPhase,
): asserts value is ActivationCatalogPolicy {
  if (
    !isExactRecord(value, policyFields) ||
    value.kind !== "reviewrouter-activation-catalog-policy" ||
    value.version !== 1 ||
    value.phase !== phase ||
    value.database !== "review_router"
  )
    throw new Error("policy");
  const arrayFields = policyFields.slice(4);
  if (!arrayFields.every((field) => Array.isArray(value[field])))
    throw new Error("arrays");

  const roles = value.roles as unknown[];
  if (roles.length !== promotedArtifactPrincipalNames.length)
    throw new Error("roles");
  roles.forEach((role, index) => {
    if (
      !isExactRecord(role, [
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
      ]) ||
      role.name !== promotedArtifactPrincipalNames[index] ||
      role.canLogin !==
        (role.name !== "reviewrouter_activation_receipt_guard") ||
      role.inherit !== true ||
      role.superuser !== false ||
      role.bypassRls !== false ||
      role.replication !== false ||
      role.createDatabase !== false ||
      role.createRole !== (role.name === "reviewrouter_role_bootstrap") ||
      role.connectionLimit !== -1 ||
      role.validUntil !== null
    )
      throw new Error("role");
  });

  const memberships = value.memberships as unknown[];
  if (
    memberships.length !== promotedArtifactBootstrapMembershipRoleNames.length
  )
    throw new Error("memberships");
  memberships.forEach((membership, index) => {
    if (
      !isExactRecord(membership, [
        "member",
        "role",
        "setOption",
        "inheritOption",
        "adminOption",
        "grantor",
      ]) ||
      membership.member !== "reviewrouter_role_bootstrap" ||
      membership.role !== promotedArtifactBootstrapMembershipRoleNames[index] ||
      membership.setOption !== false ||
      membership.inheritOption !== false ||
      membership.adminOption !== true ||
      !isExactRecord(membership.grantor, ["kind"]) ||
      membership.grantor.kind !== "external-bootstrap-authority"
    )
      throw new Error("membership");
  });

  const reachability = value.roleReachability as unknown[];
  reachability.forEach((edge) => {
    if (
      !isExactRecord(edge, ["principal", "role", "usage", "set"]) ||
      !canonicalPrincipals.has(String(edge.principal)) ||
      !canonicalPrincipals.has(String(edge.role)) ||
      typeof edge.usage !== "boolean" ||
      typeof edge.set !== "boolean"
    )
      throw new Error("reachability");
  });
  assertUnique(reachability);

  const rowSecurity = value.rowSecurity as unknown[];
  rowSecurity.forEach((relation) => {
    if (
      !isExactRecord(relation, [
        "relation",
        "owner",
        "enabled",
        "forced",
        "policies",
      ]) ||
      !isSafeText(relation.relation) ||
      !canonicalPrincipals.has(String(relation.owner)) ||
      typeof relation.enabled !== "boolean" ||
      typeof relation.forced !== "boolean" ||
      !Array.isArray(relation.policies)
    )
      throw new Error("row-security");
    relation.policies.forEach((policy) => {
      if (
        !isExactRecord(policy, [
          "name",
          "command",
          "permissive",
          "using",
          "withCheck",
          "roles",
        ]) ||
        !isSafeText(policy.name) ||
        !isSafeText(policy.command) ||
        typeof policy.permissive !== "boolean" ||
        !(policy.using === null || typeof policy.using === "string") ||
        !(policy.withCheck === null || typeof policy.withCheck === "string") ||
        !Array.isArray(policy.roles) ||
        !policy.roles.every(
          (role) => role === "PUBLIC" || canonicalPrincipals.has(String(role)),
        )
      )
        throw new Error("row-security-policy");
    });
    assertUnique(relation.policies);
  });
  assertUnique(rowSecurity);

  const extensions = value.extensions as unknown[];
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
          canonicalPrincipals.has(String(extension.owner.name)))
      )
    )
      throw new Error("extension");
  });
  assertUnique(extensions);

  const grants = value.grants as unknown[];
  grants.forEach((grant) => {
    if (
      !isExactRecord(grant, [
        "principal",
        "capability",
        "resource",
        "source",
        "grantable",
        "grantor",
      ]) ||
      !(
        grant.principal === "PUBLIC" ||
        canonicalPrincipals.has(String(grant.principal))
      ) ||
      !canonicalCapabilities.has(String(grant.capability)) ||
      !isSafeText(grant.resource) ||
      !grantSources.has(String(grant.source)) ||
      typeof grant.grantable !== "boolean" ||
      !canonicalPrincipals.has(String(grant.grantor))
    )
      throw new Error("grant");
  });
  assertUnique(grants);

  const effectivePermissions = value.effectivePermissions as unknown[];
  if (effectivePermissions.length !== promotedArtifactPrincipalNames.length)
    throw new Error("effective-permissions");
  effectivePermissions.forEach((entry, index) => {
    if (
      !isExactRecord(entry, ["principal", "permissions"]) ||
      entry.principal !== promotedArtifactPrincipalNames[index] ||
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
    assertUnique(entry.permissions);
  });

  if (rehearsalIdentifier.test(canonicalJson(value)))
    throw new Error("rehearsal-resource");
}

export function activationCatalogPolicyDigestsEqual(
  value: ActivationCatalogPolicyDigests,
  expected: ActivationCatalogPolicyDigests = canonicalActivationCatalogPolicyDigests,
): boolean {
  return (
    value.preactivationCatalogPolicySha256 ===
      expected.preactivationCatalogPolicySha256 &&
    value.activatedCatalogPolicySha256 === expected.activatedCatalogPolicySha256
  );
}
