import {
  decideSourceFreezeRecovery,
  type SourceFreezeRecoveryDecision,
} from "../domain/source-freeze-recovery";
import {
  RecoveryEffectKind,
  RecoveryEffectState,
  type RecoveryEffectRecord,
} from "../domain/recovery-effect";
import type {
  CompensationCheckpoint,
  DatabaseAclWitness,
  ProviderAuthorityDecision,
  ProviderStateWitness,
  SourceFreezeServiceEvidence,
} from "./ports";
import {
  RecoveryEffectProtocol,
  type RecoveryEffectAuthorityPort,
} from "./recovery-effect-protocol";

export interface SourceFreezeRecoveryProviderPort {
  resumeFrozenSourceService(input: {
    evidence: SourceFreezeServiceEvidence;
    decision: ProviderAuthorityDecision;
    databaseWitness: DatabaseAclWitness;
    executionPermit: Readonly<{
      epoch: number;
      token: string;
      executionReceipt: string;
    }>;
  }): Promise<SourceFreezeServiceRecoveryObservation>;
  observeFrozenSourceService(
    evidence: SourceFreezeServiceEvidence,
  ): Promise<SourceFreezeServiceRecoveryObservation | null>;
}

export type SourceFreezeServiceRecoveryObservation = Readonly<{
  serviceId: string;
  suspended: boolean;
  configurationSha256: string;
  environmentSha256: string;
}>;

/**
 * Authority-mediated recovery of the source-freeze effect itself. It needs no
 * service-transition contract: durable freeze evidence is its service scope.
 */
export class SourceFreezeRecoveryUseCase {
  private readonly effects: RecoveryEffectProtocol;

  constructor(
    private readonly ports: {
      ownerId: string;
      authority: RecoveryEffectAuthorityPort;
      provider: SourceFreezeRecoveryProviderPort;
    },
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(ports.ownerId))
      throw new Error("source_freeze_recovery_owner_invalid");
    this.effects = new RecoveryEffectProtocol(ports.authority);
  }

  async execute(input: {
    checkpoint: CompensationCheckpoint;
    decision: ProviderAuthorityDecision;
    databaseWitness: DatabaseAclWitness;
  }): Promise<{
    decision: SourceFreezeRecoveryDecision;
    witness?: ProviderStateWitness;
  }> {
    const policy = decideSourceFreezeRecovery(input.checkpoint);
    if (policy.outcome !== "recover") return { decision: policy };
    if (
      input.checkpoint.activationBoundary !==
        input.decision.activationBoundary ||
      input.checkpoint.lastReceiptSha256 !==
        input.decision.expectedReceiptSha256 ||
      input.decision.decision !== "allow" ||
      input.decision.operation !== "resume_source" ||
      input.decision.activationBoundary !== "before" ||
      input.databaseWitness.sourceWritesRestored !== true ||
      input.databaseWitness.systemIdentifier !==
        input.decision.sourceSystemIdentifier
    )
      throw new Error("source_freeze_recovery_authority_invalid");

    const deployIds: string[] = [];
    for (const serviceId of policy.serviceIds) {
      const evidence = input.checkpoint.sourceFreeze.services.find(
        (item) => item.serviceId === serviceId,
      )!;
      const effect = await this.effects.execute({
        rolloutId: input.decision.rolloutId,
        effectKey: `resume_source_service:${serviceId}`,
        kind: RecoveryEffectKind.ResumeSourceService,
        serviceId,
        ownerId: this.ports.ownerId,
        effect: async (executionPermit) => {
          const observed = await this.ports.provider.resumeFrozenSourceService({
            evidence,
            decision: input.decision,
            databaseWitness: input.databaseWitness,
            executionPermit,
          });
          if (observed.serviceId !== serviceId || observed.suspended)
            throw new Error("source_freeze_recovery_observation_invalid");
          return observed;
        },
        reconcileConsumed: () =>
          this.ports.provider.observeFrozenSourceService(evidence),
        observe: async (observed) => {
          if (observed.serviceId !== serviceId || observed.suspended)
            throw new Error("source_freeze_recovery_observation_invalid");
          return {
            serviceId,
            resumed: true,
            serviceContractSha256: observed.configurationSha256,
            environmentSha256: observed.environmentSha256,
          };
        },
      });
      this.assertCompleted(effect, serviceId);
      deployIds.push(evidence.latestSuccessfulDeployId);
    }
    return {
      decision: policy,
      witness: Object.freeze({
        serviceIds: policy.serviceIds,
        deployIds: Object.freeze(deployIds),
        observedAt: new Date().toISOString(),
        resumed: true as const,
      }),
    };
  }

  private assertCompleted(effect: RecoveryEffectRecord, serviceId: string) {
    if (effect.state === RecoveryEffectState.ForwardRepair)
      throw new Error("source_freeze_recovery_forward_only");
    const observation = effect.observation as {
      serviceId?: unknown;
      resumed?: unknown;
    } | null;
    if (
      effect.state !== RecoveryEffectState.Completed ||
      observation?.serviceId !== serviceId ||
      observation.resumed !== true
    )
      throw new Error("source_freeze_recovery_effect_ambiguous");
  }
}
