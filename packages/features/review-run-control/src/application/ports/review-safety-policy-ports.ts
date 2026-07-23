import type {
  ReviewSafetyEmergencyControl,
  ReviewSafetyPolicy,
  ReviewSafetyResolutionTarget,
  ReviewSafetyScope,
} from "../../domain/review-safety-policy";
import type { ReviewSafetyCapability } from "../../domain/review-run-control-types";

export enum ReviewSafetyControlWriteStatus {
  Created = "created",
  Updated = "updated",
  Restored = "restored",
  Conflict = "conflict",
}

export interface ReviewSafetyPolicyQueryPort {
  findApplicableReviewSafetyPolicies(input: {
    readonly target: ReviewSafetyResolutionTarget;
    readonly capabilities: readonly ReviewSafetyCapability[];
  }): Promise<readonly ReviewSafetyPolicy[]>;
}

export interface ReviewSafetyPolicyCommandPort {
  putReviewSafetyPolicy(input: {
    readonly expectedVersion: number;
    readonly policy: ReviewSafetyPolicy;
  }): Promise<{
    readonly status: ReviewSafetyControlWriteStatus;
    readonly policy?: ReviewSafetyPolicy | undefined;
  }>;
}

export interface ReviewSafetyEmergencyControlQueryPort {
  findApplicableReviewSafetyEmergencyControls(
    target: ReviewSafetyResolutionTarget,
  ): Promise<readonly ReviewSafetyEmergencyControl[]>;
}

export interface ReviewSafetyEmergencyControlCommandPort {
  putReviewSafetyEmergencyControl(input: {
    readonly expectedVersion: number;
    readonly control: ReviewSafetyEmergencyControl;
  }): Promise<{
    readonly status: ReviewSafetyControlWriteStatus;
    readonly control?: ReviewSafetyEmergencyControl | undefined;
  }>;
}

export interface ReviewSafetyControlInspectionPort {
  findReviewSafetyPolicy(input: {
    readonly scope: ReviewSafetyScope;
    readonly capability: ReviewSafetyCapability;
  }): Promise<ReviewSafetyPolicy | null>;
  findReviewSafetyEmergencyControl(
    scope: ReviewSafetyScope,
  ): Promise<ReviewSafetyEmergencyControl | null>;
}

export interface ReviewSafetyDecisionResolverPort {
  resolveReviewSafetyPolicy(input: {
    readonly decisionKind: import("../../domain/review-run-control-types").ReviewSafetyDecisionKind;
    readonly target: ReviewSafetyResolutionTarget;
  }): Promise<
    import("../../domain/review-safety-policy").ReviewSafetyPolicySnapshot
  >;
}
