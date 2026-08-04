import type { InvestigationPromotionPolicyQueryPort } from "../../application/ports/operations-ports";
import {
  investigationPromotionProfileIdentityKey,
  maximumInvestigationPromotionPolicyProfiles,
  normalizeInvestigationPromotionPolicyProfile,
  type InvestigationPromotionPolicyProfile,
  type InvestigationPromotionProfileIdentity,
} from "../../domain/promotion-policy";

export const investigationPromotionPolicyProfilesEnv =
  "REVIEW_ROUTER_INVESTIGATION_PROMOTION_POLICY_PROFILES_JSON";

export class ConfiguredInvestigationPromotionPolicyRegistry implements InvestigationPromotionPolicyQueryPort {
  private readonly profiles: ReadonlyMap<
    string,
    InvestigationPromotionPolicyProfile
  >;

  constructor(profiles: readonly InvestigationPromotionPolicyProfile[]) {
    if (
      profiles.length < 1 ||
      profiles.length > maximumInvestigationPromotionPolicyProfiles
    ) {
      throw new Error("promotion_policy_profile_count_invalid");
    }
    const configured = new Map<string, InvestigationPromotionPolicyProfile>();
    for (const input of profiles) {
      const profile = normalizeInvestigationPromotionPolicyProfile(input);
      const key = investigationPromotionProfileIdentityKey(profile.identity);
      if (configured.has(key)) {
        throw new Error("promotion_policy_profile_identity_duplicate");
      }
      configured.set(key, profile);
    }
    this.profiles = configured;
  }

  static fromJson(
    value: string,
  ): ConfiguredInvestigationPromotionPolicyRegistry {
    let decoded: unknown;
    try {
      decoded = JSON.parse(value);
    } catch {
      throw new Error("promotion_policy_profiles_json_invalid");
    }
    if (!Array.isArray(decoded)) {
      throw new Error("promotion_policy_profiles_json_invalid");
    }
    return new ConfiguredInvestigationPromotionPolicyRegistry(
      decoded as InvestigationPromotionPolicyProfile[],
    );
  }

  async find(
    identity: InvestigationPromotionProfileIdentity,
  ): Promise<InvestigationPromotionPolicyProfile | null> {
    return (
      this.profiles.get(investigationPromotionProfileIdentityKey(identity)) ??
      null
    );
  }
}
