import {
  normalizeInvestigationPromotionTrustProfile,
  type InvestigationPromotionTrustProfile,
} from "./promotion-trust-profile";

export const maximumInvestigationPromotionPolicyProfiles = 32;

export enum InvestigationPromotionPolicyErrorCode {
  ProfileNotConfigured = "profile_not_configured",
}

export class InvestigationPromotionPolicyError extends Error {
  constructor(readonly code: InvestigationPromotionPolicyErrorCode) {
    super(`promotion_policy_${code}`);
    this.name = "InvestigationPromotionPolicyError";
  }
}

export type InvestigationPromotionProfileIdentity = Readonly<{
  id: string;
  version: string;
}>;

export type InvestigationPromotionThresholds = Readonly<{
  minSeededSamples: number;
  minShadowSamples: number;
  maxUnexplainedDisagreements: number;
  maxP95TotalTokens: number;
  maxP95DurationMs: number;
}>;

export type InvestigationPromotionPolicyProfile = Readonly<{
  identity: InvestigationPromotionProfileIdentity;
  trustProfile: InvestigationPromotionTrustProfile;
  thresholds: InvestigationPromotionThresholds;
}>;

const identityFields = Object.freeze(["id", "version"] as const);
const profileFields = Object.freeze([
  "identity",
  "trustProfile",
  "thresholds",
] as const);
const thresholdFields = Object.freeze([
  "minSeededSamples",
  "minShadowSamples",
  "maxUnexplainedDisagreements",
  "maxP95TotalTokens",
  "maxP95DurationMs",
] as const);

export function normalizeInvestigationPromotionProfileIdentity(
  input: InvestigationPromotionProfileIdentity,
): InvestigationPromotionProfileIdentity {
  exactFields(input, identityFields, "promotion_profile_identity_fields");
  identifier(input.id, "promotion_profile_id");
  identifier(input.version, "promotion_profile_version");
  return Object.freeze({ id: input.id, version: input.version });
}

export function normalizeInvestigationPromotionThresholds(
  input: InvestigationPromotionThresholds,
): InvestigationPromotionThresholds {
  exactFields(input, thresholdFields, "promotion_threshold_fields");
  for (const field of thresholdFields) {
    const value = input[field];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${field}_invalid`);
    }
  }
  if (input.minSeededSamples === 0 || input.minShadowSamples === 0) {
    throw new Error("promotion_evidence_threshold_zero");
  }
  return Object.freeze({ ...input });
}

export function normalizeInvestigationPromotionPolicyProfile(
  input: InvestigationPromotionPolicyProfile,
): InvestigationPromotionPolicyProfile {
  exactFields(input, profileFields, "promotion_policy_profile_fields");
  return Object.freeze({
    identity: normalizeInvestigationPromotionProfileIdentity(input.identity),
    trustProfile: normalizeInvestigationPromotionTrustProfile(
      input.trustProfile,
    ),
    thresholds: normalizeInvestigationPromotionThresholds(input.thresholds),
  });
}

export function investigationPromotionProfileIdentityKey(
  identity: InvestigationPromotionProfileIdentity,
): string {
  const normalized = normalizeInvestigationPromotionProfileIdentity(identity);
  return `${normalized.id}\u0000${normalized.version}`;
}

function exactFields(
  value: unknown,
  expected: readonly string[],
  field: string,
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field}_invalid`);
  }
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((item, index) => item !== sortedExpected[index])
  ) {
    throw new Error(`${field}_invalid`);
  }
}

function identifier(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value)
  ) {
    throw new Error(`${field}_invalid`);
  }
}
