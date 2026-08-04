import {
  InvestigationRolloutDecision,
  ResolveInvestigationRollout,
  investigationRolloutCapabilities,
  type InvestigationRolloutCapability,
  type InvestigationRolloutTarget,
} from "@reviewrouter/features-review-investigation-operations";
import { ReviewActionV2RouteFailure } from "@reviewrouter/features-action-control-plane/v2";
import { ReviewActionV2ProtocolErrorCode } from "@reviewrouter/protocol-review-action-v2";

export interface ReviewInvestigationRolloutGuardPort {
  assertAllowed(input: {
    readonly capability: InvestigationRolloutCapability;
    readonly target: InvestigationRolloutTarget;
  }): Promise<void>;
}

export interface ReviewInvestigationRolloutCapabilityResolutionPort {
  resolveAllowedCapabilities(input: {
    readonly target: InvestigationRolloutTarget;
  }): Promise<readonly InvestigationRolloutCapability[]>;
  resolveAllowedCapabilitiesForTargets(input: {
    readonly targets: readonly InvestigationRolloutTarget[];
  }): Promise<readonly (readonly InvestigationRolloutCapability[])[]>;
}

export class ReviewInvestigationRolloutGuard
  implements
    ReviewInvestigationRolloutGuardPort,
    ReviewInvestigationRolloutCapabilityResolutionPort
{
  constructor(private readonly rollout: ResolveInvestigationRollout) {}

  async assertAllowed(input: {
    readonly capability: InvestigationRolloutCapability;
    readonly target: InvestigationRolloutTarget;
  }): Promise<void> {
    const decision = await this.rollout.execute(input);
    if (decision === InvestigationRolloutDecision.Allowed) return;
    throw new ReviewActionV2RouteFailure(
      decision === InvestigationRolloutDecision.Unavailable ? 503 : 403,
      ReviewActionV2ProtocolErrorCode.CapabilityDisabled,
      [`investigation_rollout_${decision}`],
    );
  }

  async resolveAllowedCapabilities(input: {
    readonly target: InvestigationRolloutTarget;
  }): Promise<readonly InvestigationRolloutCapability[]> {
    return (
      await this.resolveAllowedCapabilitiesForTargets({
        targets: [input.target],
      })
    )[0]!;
  }

  async resolveAllowedCapabilitiesForTargets(input: {
    readonly targets: readonly InvestigationRolloutTarget[];
  }): Promise<readonly (readonly InvestigationRolloutCapability[])[]> {
    const decisionSets = await this.rollout.executeAllForTargets(input);
    if (decisionSets.some(hasUnavailableDecision)) {
      throw new ReviewActionV2RouteFailure(
        503,
        ReviewActionV2ProtocolErrorCode.CapabilityDisabled,
        ["investigation_rollout_unavailable"],
      );
    }
    return Object.freeze(
      decisionSets.map((decisions) =>
        Object.freeze(
          investigationRolloutCapabilities.filter(
            (capability) =>
              decisions[capability] === InvestigationRolloutDecision.Allowed,
          ),
        ),
      ),
    );
  }
}

function hasUnavailableDecision(
  decisions: Readonly<
    Record<InvestigationRolloutCapability, InvestigationRolloutDecision>
  >,
): boolean {
  return investigationRolloutCapabilities.some(
    (capability) =>
      decisions[capability] === InvestigationRolloutDecision.Unavailable,
  );
}
