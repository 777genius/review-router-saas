import type { InvestigationOperatorStatus } from "../../domain/operator-status";
import type {
  InvestigationEvaluationImportStatus,
  InvestigationEvaluationRecord,
  InvestigationEvaluationSignatureAlgorithm,
  InvestigationEvaluationSubject,
} from "../../domain/investigation-evaluation";
import type {
  InvestigationRolloutPolicy,
  InvestigationRolloutTarget,
} from "../../domain/investigation-rollout-policy";
import type {
  InvestigationTelemetrySample,
  InvestigationTerminalOperationalTelemetrySample,
} from "../../domain/investigation-telemetry";
import type { InvestigationPromotionTrustProfile } from "../../domain/promotion-trust-profile";
import type {
  InvestigationPromotionPolicyProfile,
  InvestigationPromotionProfileIdentity,
} from "../../domain/promotion-policy";

export const maximumInvestigationPromotionTelemetrySamples = 1_000;

export enum InvestigationPromotionTelemetryReadStatus {
  Complete = "complete",
  TooLarge = "too_large",
}

export type InvestigationPromotionTelemetryReadResult =
  | Readonly<{
      status: InvestigationPromotionTelemetryReadStatus.Complete;
      samples: readonly InvestigationTelemetrySample[];
    }>
  | Readonly<{
      status: InvestigationPromotionTelemetryReadStatus.TooLarge;
    }>;

export interface InvestigationTelemetryRepositoryPort {
  append(
    sample: InvestigationTerminalOperationalTelemetrySample,
  ): Promise<void>;
  readPromotionSampleSet(
    input: Readonly<{
      producerReleaseId: string;
      trustProfile: InvestigationPromotionTrustProfile;
      validAt: string;
    }>,
  ): Promise<InvestigationPromotionTelemetryReadResult>;
}

export interface InvestigationOperatorStatusRepositoryPort {
  find(investigationId: string): Promise<InvestigationOperatorStatus | null>;
}

export interface InvestigationOperationsDigestPort {
  digestUtf8(value: string): Promise<string>;
}

export type InvestigationPromotionReportCommit<Result> = Readonly<{
  result: Result;
  reportCanonicalJson: string;
  reportHash: string;
}>;

export interface InvestigationPromotionReportUnitOfWorkPort {
  withPromotionSnapshot<Result>(
    input: Readonly<{
      producerReleaseId: string;
      trustProfile: InvestigationPromotionTrustProfile;
      validAt: string;
    }>,
    build: (
      telemetry: InvestigationPromotionTelemetryReadResult,
    ) => Promise<InvestigationPromotionReportCommit<Result>>,
  ): Promise<Result>;
}

export interface InvestigationPromotionPolicyQueryPort {
  find(
    identity: InvestigationPromotionProfileIdentity,
  ): Promise<InvestigationPromotionPolicyProfile | null>;
}

export interface InvestigationRolloutPolicyQueryPort {
  readCurrentPolicy(): Promise<InvestigationRolloutPolicy>;
}

export interface InvestigationEmergencyStopQueryPort {
  isEmergencyStopped(target: InvestigationRolloutTarget): Promise<boolean>;
}

export interface InvestigationEvaluationSignatureVerifierPort {
  verify(input: {
    readonly algorithm: InvestigationEvaluationSignatureAlgorithm;
    readonly keyId: string;
    readonly payloadCanonicalJson: string;
    readonly signature: string;
    readonly issuedAt: string;
    readonly now: Date;
  }): Promise<boolean>;
}

export interface InvestigationEvaluationRepositoryPort {
  findSubject(input: {
    readonly terminalSampleId: string;
    readonly certificateId: string;
  }): Promise<InvestigationEvaluationSubject | null>;
  commit(input: {
    readonly record: InvestigationEvaluationRecord;
    readonly derivedSample: InvestigationTelemetrySample;
  }): Promise<InvestigationEvaluationImportStatus>;
}

export interface InvestigationEvaluationClockPort {
  now(): Date;
}
