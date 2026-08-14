import { createHash } from "node:crypto";
import type { ActivationCatalogPolicy } from "@reviewrouter/features-release-rollout";

export type ActivationCatalogPolicyPhase = "preactivation" | "activated";

export type TrustedActivationCatalogPolicy = Readonly<{
  policy: ActivationCatalogPolicy;
  sha256: string;
}>;

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
};

export function trustedActivationCatalogPolicy(
  serialized: string,
  phase: ActivationCatalogPolicyPhase,
): TrustedActivationCatalogPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error(`activation_catalog_policy_json_invalid:${phase}`);
  }
  const policy = canonicalize(parsed);
  const expectedFields = new Set([
    "kind",
    "version",
    "phase",
    "database",
    "roles",
    "memberships",
    "roleReachability",
    "rowSecurity",
    "grants",
    "effectivePermissions",
  ]);
  if (
    policy === null ||
    typeof policy !== "object" ||
    Array.isArray(policy) ||
    (policy as Record<string, unknown>).kind !==
      "reviewrouter-activation-catalog-policy" ||
    (policy as Record<string, unknown>).version !== 1 ||
    (policy as Record<string, unknown>).phase !== phase ||
    Object.keys(policy as Record<string, unknown>).length !==
      expectedFields.size ||
    !Object.keys(policy as Record<string, unknown>).every((field) =>
      expectedFields.has(field),
    ) ||
    typeof (policy as Record<string, unknown>).database !== "string" ||
    ![
      "roles",
      "memberships",
      "roleReachability",
      "rowSecurity",
      "grants",
      "effectivePermissions",
    ].every((field) =>
      Array.isArray((policy as Record<string, unknown>)[field]),
    )
  )
    throw new Error(`activation_catalog_policy_contract_invalid:${phase}`);
  const sha256 = `sha256:${createHash("sha256")
    .update(JSON.stringify(policy))
    .digest("hex")}`;
  return Object.freeze({
    policy: Object.freeze(policy as unknown as ActivationCatalogPolicy),
    sha256,
  });
}
