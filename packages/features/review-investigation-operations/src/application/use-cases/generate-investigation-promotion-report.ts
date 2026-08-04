import {
  evaluatePromotion,
  type InvestigationPromotionReportBody,
} from "../../domain/promotion-report";
import { canonicalInvestigationOperationsJson } from "../../domain/canonical-json";
import { assertInvestigationPromotionTrustProfileValidAt } from "../../domain/promotion-trust-profile";
import {
  InvestigationPromotionPolicyError,
  InvestigationPromotionPolicyErrorCode,
  investigationPromotionProfileIdentityKey,
  normalizeInvestigationPromotionPolicyProfile,
  normalizeInvestigationPromotionProfileIdentity,
  type InvestigationPromotionProfileIdentity,
} from "../../domain/promotion-policy";
import {
  InvestigationPromotionTelemetryReadStatus,
  maximumInvestigationPromotionTelemetrySamples,
  type InvestigationOperationsDigestPort,
  type InvestigationPromotionPolicyQueryPort,
  type InvestigationPromotionReportUnitOfWorkPort,
} from "../ports/operations-ports";

export type ImmutableInvestigationPromotionReport = Readonly<{
  body: InvestigationPromotionReportBody;
  canonicalJson: string;
  reportHash: string;
}>;

export class GenerateInvestigationPromotionReport {
  constructor(
    private readonly policies: InvestigationPromotionPolicyQueryPort,
    private readonly reports: InvestigationPromotionReportUnitOfWorkPort,
    private readonly digest: InvestigationOperationsDigestPort,
  ) {}

  async execute(input: {
    readonly generatedAt: string;
    readonly producerReleaseId: string;
    readonly profile: InvestigationPromotionProfileIdentity;
  }): Promise<ImmutableInvestigationPromotionReport> {
    const identity = normalizeInvestigationPromotionProfileIdentity(
      input.profile,
    );
    const configured = await this.policies.find(identity);
    if (configured === null) {
      throw new InvestigationPromotionPolicyError(
        InvestigationPromotionPolicyErrorCode.ProfileNotConfigured,
      );
    }
    const policy = normalizeInvestigationPromotionPolicyProfile(configured);
    if (
      investigationPromotionProfileIdentityKey(policy.identity) !==
      investigationPromotionProfileIdentityKey(identity)
    ) {
      throw new InvestigationPromotionPolicyError(
        InvestigationPromotionPolicyErrorCode.ProfileNotConfigured,
      );
    }
    assertInvestigationPromotionTrustProfileValidAt({
      profile: policy.trustProfile,
      validAt: input.generatedAt,
    });
    return this.reports.withPromotionSnapshot(
      {
        producerReleaseId: input.producerReleaseId,
        trustProfile: policy.trustProfile,
        validAt: input.generatedAt,
      },
      async (telemetry) => {
        if (
          telemetry.status ===
            InvestigationPromotionTelemetryReadStatus.TooLarge ||
          telemetry.samples.length >
            maximumInvestigationPromotionTelemetrySamples
        ) {
          throw new Error("promotion_telemetry_sample_set_too_large");
        }
        const samples = telemetry.samples;
        const sampleSetCanonicalJson = canonicalInvestigationOperationsJson(
          [...samples].sort((a, b) =>
            a.sampleId.localeCompare(b.sampleId, "en"),
          ),
        );
        const sampleSetHash = await this.digest.digestUtf8(
          sampleSetCanonicalJson,
        );
        const body = evaluatePromotion({
          generatedAt: input.generatedAt,
          producerReleaseId: input.producerReleaseId,
          policy,
          sampleSetHash,
          samples,
        });
        const canonicalJson = canonicalInvestigationOperationsJson(body);
        const reportHash = await this.digest.digestUtf8(canonicalJson);
        const result = Object.freeze({
          body,
          canonicalJson,
          reportHash,
        });
        return Object.freeze({
          result,
          reportCanonicalJson: canonicalJson,
          reportHash,
        });
      },
    );
  }
}
