import type { ReviewRunAuthorization } from "@reviewrouter/features-review-run-control";
import {
  InvestigationRolloutCapability,
  isInvestigationRolloutCapability,
  isInvestigationRolloutCapabilitySetDependencyClosed,
} from "@reviewrouter/features-review-investigation-operations";
import { reviewInvestigationExtensionV1 } from "@reviewrouter/protocol-review-action-v2";

export type ReviewInvestigationAuthorizedProviderKind = "codex" | "claude_code";

export type ReviewInvestigationExtensionRequirement = Readonly<{
  providerKind: ReviewInvestigationAuthorizedProviderKind;
  capability: InvestigationRolloutCapability;
}>;

export function hasAuthorizedReviewInvestigationExtension(
  authorization: Pick<
    ReviewRunAuthorization,
    "reviewInvestigationAuthorizationDescriptorCanonicalJson"
  >,
  requirement?: ReviewInvestigationExtensionRequirement,
): boolean {
  const canonical =
    authorization.reviewInvestigationAuthorizationDescriptorCanonicalJson;
  if (canonical === null) return false;
  let value: unknown;
  try {
    value = JSON.parse(canonical);
  } catch {
    return false;
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "authorizationDescriptorVersion",
      "capability",
      "coverageProfileHash",
      "extensionCanonicalizerDigest",
      "extensionId",
      "extensionSchemaDigest",
      "policyHash",
      "providerCapabilities",
    ])
  ) {
    return false;
  }
  if (
    value.authorizationDescriptorVersion === 3 &&
    value.capability === "review_investigation_v1" &&
    isSha256(value.coverageProfileHash) &&
    value.extensionId === reviewInvestigationExtensionV1.extensionId &&
    value.extensionSchemaDigest ===
      reviewInvestigationExtensionV1.schemaDigest &&
    value.extensionCanonicalizerDigest ===
      reviewInvestigationExtensionV1.canonicalizerDigest &&
    isSha256(value.policyHash)
  ) {
    const providerCapabilities = validatedProviderCapabilities(
      value.providerCapabilities,
    );
    if (providerCapabilities === null) return false;
    return requirement === undefined
      ? true
      : providerCapabilities.some(
          (row) =>
            row.providerKind === requirement.providerKind &&
            row.capabilities.includes(requirement.capability),
        );
  }
  return false;
}

function validatedProviderCapabilities(value: unknown):
  | readonly Readonly<{
      providerKind: ReviewInvestigationAuthorizedProviderKind;
      capabilities: readonly InvestigationRolloutCapability[];
    }>[]
  | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2) {
    return null;
  }
  const providers: ReviewInvestigationAuthorizedProviderKind[] = [];
  const rows: {
    providerKind: ReviewInvestigationAuthorizedProviderKind;
    capabilities: readonly InvestigationRolloutCapability[];
  }[] = [];
  for (const row of value) {
    if (
      !isRecord(row) ||
      !hasExactKeys(row, ["capabilities", "providerKind"]) ||
      (row.providerKind !== "codex" && row.providerKind !== "claude_code") ||
      !Array.isArray(row.capabilities) ||
      row.capabilities.length === 0 ||
      row.capabilities.length > 6 ||
      row.capabilities.some(
        (capability) => !isInvestigationRolloutCapability(capability),
      ) ||
      new Set(row.capabilities).size !== row.capabilities.length ||
      !strictlySorted(row.capabilities) ||
      !row.capabilities.includes(InvestigationRolloutCapability.Recording) ||
      !isInvestigationRolloutCapabilitySetDependencyClosed(
        new Set(row.capabilities),
      )
    ) {
      return null;
    }
    providers.push(row.providerKind);
    rows.push({
      providerKind: row.providerKind,
      capabilities: row.capabilities as InvestigationRolloutCapability[],
    });
  }
  if (
    new Set(providers).size !== providers.length ||
    !strictlySorted(providers)
  ) {
    return null;
  }
  return rows;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function strictlySorted(values: readonly string[]): boolean {
  return values.every(
    (value, index) => index === 0 || values[index - 1]! < value,
  );
}
