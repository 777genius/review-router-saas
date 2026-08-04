import {
  InvestigationRolloutDecision,
  evaluateInvestigationRollout,
  investigationRolloutCapabilities,
  type InvestigationRolloutCapability,
  type InvestigationRolloutTarget,
} from "../../domain/investigation-rollout-policy";
import type {
  InvestigationEmergencyStopQueryPort,
  InvestigationRolloutPolicyQueryPort,
} from "../ports/operations-ports";

export class ResolveInvestigationRollout {
  constructor(
    private readonly policies: InvestigationRolloutPolicyQueryPort,
    private readonly emergencies: InvestigationEmergencyStopQueryPort,
  ) {}

  async execute(input: {
    readonly capability: InvestigationRolloutCapability;
    readonly target: InvestigationRolloutTarget;
  }): Promise<InvestigationRolloutDecision> {
    const decisions = await this.executeAll({ target: input.target });
    return decisions[input.capability];
  }

  async executeAll(input: {
    readonly target: InvestigationRolloutTarget;
  }): Promise<InvestigationRolloutDecisionSet> {
    return (await this.executeAllForTargets({ targets: [input.target] }))[0]!;
  }

  async executeAllForTargets(input: {
    readonly targets: readonly InvestigationRolloutTarget[];
  }): Promise<readonly InvestigationRolloutDecisionSet[]> {
    if (input.targets.length === 0 || input.targets.length > 16) {
      return input.targets.map(() =>
        uniformDecisionSet(InvestigationRolloutDecision.Unavailable),
      );
    }
    try {
      assertSingleAuthorizationTarget(input.targets);
      const policy = await this.policies.readCurrentPolicy();
      if (policy.emergencyDisabled) {
        return input.targets.map(() =>
          uniformDecisionSet(InvestigationRolloutDecision.EmergencyDisabled),
        );
      }
      if (await this.emergencies.isEmergencyStopped(input.targets[0]!)) {
        return input.targets.map(() =>
          uniformDecisionSet(InvestigationRolloutDecision.EmergencyDisabled),
        );
      }
      return input.targets.map((target) =>
        decisionSet((capability) =>
          evaluateInvestigationRollout(policy, capability, target),
        ),
      );
    } catch {
      return input.targets.map(() =>
        uniformDecisionSet(InvestigationRolloutDecision.Unavailable),
      );
    }
  }
}

export type InvestigationRolloutDecisionSet = Readonly<
  Record<InvestigationRolloutCapability, InvestigationRolloutDecision>
>;

function uniformDecisionSet(
  decision: InvestigationRolloutDecision,
): InvestigationRolloutDecisionSet {
  return decisionSet(() => decision);
}

function decisionSet(
  resolve: (
    capability: InvestigationRolloutCapability,
  ) => InvestigationRolloutDecision,
): InvestigationRolloutDecisionSet {
  return Object.freeze(
    Object.fromEntries(
      investigationRolloutCapabilities.map((capability) => [
        capability,
        resolve(capability),
      ]),
    ),
  ) as InvestigationRolloutDecisionSet;
}

function assertSingleAuthorizationTarget(
  targets: readonly InvestigationRolloutTarget[],
): void {
  const first = targets[0]!;
  const providers = new Set<string>();
  for (const target of targets) {
    if (
      target.workspaceId !== first.workspaceId ||
      target.repositoryConnectionId !== first.repositoryConnectionId ||
      target.scmRepositoryIdentityId !== first.scmRepositoryIdentityId ||
      target.trustDomain !== first.trustDomain ||
      target.producerReleaseId !== first.producerReleaseId ||
      providers.has(target.provider)
    ) {
      throw new Error("investigation_rollout_target_set_invalid");
    }
    providers.add(target.provider);
  }
}
