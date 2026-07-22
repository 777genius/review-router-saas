import {
  createReviewSafetyEmergencyControl,
  createReviewSafetyPolicy,
  type ReviewSafetyScope,
} from "../../domain/review-safety-policy";
import type {
  ProviderTaskSelector,
  ReviewSafetyCapability,
  ReviewSafetyRolloutMode,
} from "../../domain/review-run-control-types";
import type { ClockPort, IdentifierFactoryPort } from "../ports/platform-ports";
import type {
  ReviewSafetyControlInspectionPort,
  ReviewSafetyEmergencyControlCommandPort,
  ReviewSafetyPolicyCommandPort,
} from "../ports/review-safety-policy-ports";

export class ManageReviewSafetyControls {
  constructor(
    private readonly dependencies: {
      readonly clock: ClockPort;
      readonly identifiers: IdentifierFactoryPort;
      readonly inspections: ReviewSafetyControlInspectionPort;
      readonly policyCommands: ReviewSafetyPolicyCommandPort;
      readonly emergencyCommands: ReviewSafetyEmergencyControlCommandPort;
    },
  ) {}

  async updateReviewSafetyPolicy(input: {
    readonly expectedVersion: number;
    readonly scope: ReviewSafetyScope;
    readonly capability: ReviewSafetyCapability;
    readonly rolloutMode: ReviewSafetyRolloutMode;
    readonly providerTaskSelectors?:
      | readonly ProviderTaskSelector[]
      | undefined;
    readonly updatedBy: string;
  }) {
    const existing = await this.dependencies.inspections.findReviewSafetyPolicy(
      {
        scope: input.scope,
        capability: input.capability,
      },
    );
    const policy = createReviewSafetyPolicy({
      policyId:
        existing?.policyId ??
        this.dependencies.identifiers.nextId("safety_policy"),
      scope: input.scope,
      capability: input.capability,
      rolloutMode: input.rolloutMode,
      providerTaskSelectors: input.providerTaskSelectors,
      updatedBy: input.updatedBy,
      updatedAt: this.dependencies.clock.now(),
      version: input.expectedVersion + 1,
    });
    return this.dependencies.policyCommands.putReviewSafetyPolicy({
      expectedVersion: input.expectedVersion,
      policy,
    });
  }

  async setReviewSafetyEmergencyStop(input: {
    readonly expectedVersion: number;
    readonly scope: ReviewSafetyScope;
    readonly stopped: boolean;
    readonly reason: string;
    readonly updatedBy: string;
  }) {
    const existing =
      await this.dependencies.inspections.findReviewSafetyEmergencyControl(
        input.scope,
      );
    const control = createReviewSafetyEmergencyControl({
      emergencyControlId:
        existing?.emergencyControlId ??
        this.dependencies.identifiers.nextId("safety_emergency"),
      scope: input.scope,
      stopped: input.stopped,
      reason: input.reason,
      updatedBy: input.updatedBy,
      updatedAt: this.dependencies.clock.now(),
      version: input.expectedVersion + 1,
    });
    return this.dependencies.emergencyCommands.putReviewSafetyEmergencyControl({
      expectedVersion: input.expectedVersion,
      control,
    });
  }
}
