import { canonicalActivationPrincipalNames } from "../packages/features/release-rollout/src/index.ts";

const candidateFields = new Set([
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
]);

const rehearsalIdentifier =
  /(?:^|[.:])(?:rehearsal(?:_|\b)|app_private(?:[.:]|$)|rr_(?:direct|parent|inherited|set_|owner|super|bypass|column|sequence|routine))/u;

const assertProductionShape = (value, phase) => {
  const canonicalPrincipals = new Set(canonicalActivationPrincipalNames);
  const roleNames = value.roles.map((role) => role?.name);
  const extensionsAreNormalized = value.extensions.every((extension) => {
    const owner = extension?.owner;
    return (
      extension !== null &&
      typeof extension === "object" &&
      Object.keys(extension).length === 2 &&
      typeof extension.name === "string" &&
      extension.name.length > 0 &&
      owner !== null &&
      typeof owner === "object" &&
      !Array.isArray(owner) &&
      ((owner.kind === "external-provider-authority" &&
        Object.keys(owner).length === 1) ||
        (owner.kind === "principal" &&
          Object.keys(owner).length === 2 &&
          typeof owner.name === "string" &&
          owner.name.length > 0))
    );
  });
  if (
    !extensionsAreNormalized ||
    new Set(value.extensions.map((extension) => extension.name)).size !==
      value.extensions.length
  )
    throw new Error(
      `activation_catalog_policy_candidate_extension_authority_invalid:${phase}`,
    );
  const providerIdentityPresent =
    roleNames.length !== canonicalPrincipals.size ||
    new Set(roleNames).size !== roleNames.length ||
    roleNames.some((name) => !canonicalPrincipals.has(name)) ||
    value.memberships.some(
      (edge) =>
        !canonicalPrincipals.has(edge?.member) ||
        !canonicalPrincipals.has(edge?.role) ||
        !(
          edge?.grantor?.kind === "external-bootstrap-authority" ||
          (edge?.grantor?.kind === "principal" &&
            canonicalPrincipals.has(edge.grantor.name))
        ),
    ) ||
    value.roleReachability.some(
      (edge) =>
        !canonicalPrincipals.has(edge?.principal) ||
        !canonicalPrincipals.has(edge?.role),
    ) ||
    value.rowSecurity.some(
      (relation) =>
        !canonicalPrincipals.has(relation?.owner) ||
        relation?.policies?.some((policy) =>
          policy?.roles?.some(
            (role) => role !== "PUBLIC" && !canonicalPrincipals.has(role),
          ),
        ),
    ) ||
    value.extensions.some(
      (extension) =>
        extension?.owner?.kind === "principal" &&
        !canonicalPrincipals.has(extension.owner.name),
    ) ||
    value.grants.some(
      (grant) =>
        (grant?.principal !== "PUBLIC" &&
          !canonicalPrincipals.has(grant?.principal)) ||
        (grant?.grantor !== "external-bootstrap-authority" &&
          !canonicalPrincipals.has(grant?.grantor)),
    ) ||
    value.effectivePermissions.some(
      (entry) => !canonicalPrincipals.has(entry?.principal),
    );
  if (providerIdentityPresent)
    throw new Error(
      `activation_catalog_policy_candidate_provider_identity_forbidden:${phase}`,
    );
  const authorityTexts = [
    ...value.roles.map((item) => item?.name),
    ...value.memberships.flatMap((item) => [
      item?.member,
      item?.role,
      item?.grantor?.name,
    ]),
    ...value.roleReachability.flatMap((item) => [item?.principal, item?.role]),
    ...value.rowSecurity.flatMap((item) => [
      item?.relation,
      item?.owner,
      ...(Array.isArray(item?.policies)
        ? item.policies.flatMap((policy) => [
            policy?.name,
            ...(Array.isArray(policy?.roles) ? policy.roles : []),
          ])
        : []),
    ]),
    ...value.extensions.flatMap((item) => [item?.name, item?.owner?.name]),
    ...value.grants.flatMap((item) => [
      item?.principal,
      item?.resource,
      item?.grantor,
    ]),
    ...value.effectivePermissions.flatMap((item) => [
      item?.principal,
      ...(Array.isArray(item?.permissions)
        ? item.permissions.map((permission) => permission?.resource)
        : []),
    ]),
  ];
  if (
    authorityTexts.some(
      (item) => typeof item === "string" && rehearsalIdentifier.test(item),
    )
  )
    throw new Error(
      `activation_catalog_policy_candidate_rehearsal_resource_forbidden:${phase}`,
    );
  const grantKeys = value.grants.map((grant) =>
    JSON.stringify([
      grant?.principal,
      grant?.capability,
      grant?.resource,
      grant?.source,
      grant?.grantable,
      grant?.grantor,
    ]),
  );
  if (new Set(grantKeys).size !== grantKeys.length)
    throw new Error(
      `activation_catalog_policy_candidate_duplicate_grant:${phase}`,
    );
};

const assertCandidate = (value, phase) => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== candidateFields.size ||
    !Object.keys(value).every((field) => candidateFields.has(field)) ||
    value.kind !== "reviewrouter-activation-catalog-policy" ||
    value.version !== 1 ||
    value.phase !== phase ||
    value.database !== "review_router" ||
    ![
      "roles",
      "memberships",
      "roleReachability",
      "rowSecurity",
      "extensions",
      "grants",
      "effectivePermissions",
    ].every((field) => Array.isArray(value[field]))
  )
    throw new Error(`activation_catalog_policy_candidate_invalid:${phase}`);
  assertProductionShape(value, phase);
  return value;
};

export function parsePrivatePg17ActivationCatalogPolicyCandidate(stdout) {
  if (typeof stdout !== "string")
    throw new Error("activation_catalog_policy_candidate_output_invalid");
  let observations;
  try {
    observations = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
  } catch {
    throw new Error("activation_catalog_policy_candidate_output_invalid");
  }
  const preactivation = observations.find(
    (item) => item.preactivation,
  )?.preactivation;
  const activated = observations.find((item) => item.activated)?.activated;
  return Object.freeze({
    kind: "reviewrouter-activation-catalog-policy-artifact-candidate",
    version: 1,
    policies: Object.freeze({
      preactivation: assertCandidate(preactivation, "preactivation"),
      activated: assertCandidate(activated, "activated"),
    }),
  });
}
