import {
  ExternalEffectState,
  assertExternalEffectRecord,
  type ExternalEffectRecord,
  type ExternalEffectReconciliation,
} from "../domain/external-effect";
import {
  beginCompensation,
  completeCompensation,
  RolloutStep,
  sha256Canonical,
  type ReleaseRollout,
  type StepObservation,
} from "../domain/release-rollout";
import {
  ProviderAuthorityOperation,
  type CompensationCheckpoint,
  type DatabaseAclWitness,
  type ProviderAuthorityDecisionPort,
  type SourceFreezeEvidence,
} from "./ports";
import { sourceWriterServiceIdsAreValid } from "../domain/source-writer-service-ids";
import {
  RecoveryEffectProtocol,
  type RecoveryEffectAuthorityPort,
} from "./recovery-effect-protocol";
import {
  RecoveryEffectKind,
  RecoveryEffectState,
} from "../domain/recovery-effect";

type CompensationPorts = {
  recoveryOwnerId: string;
  authority: ProviderAuthorityDecisionPort;
  ledger: RecoveryEffectAuthorityPort & {
    observeCompensationCheckpoint(input: {
      rolloutId: string;
      sourceSystemIdentifier: string;
      targetSystemIdentifier: string;
    }): Promise<CompensationCheckpoint>;
    compareAndSet(input: {
      rolloutId: string;
      expectedCommitSha: string;
      runId: string;
      runAttempt: number;
      sourceSystemIdentifier: string;
      targetSystemIdentifier: string;
      step: RolloutStep;
      provider: StepObservation["provider"];
      expectedReceiptSha256: string;
      nextReceiptSha256: string;
      authoritativeSystemIdentifier: string;
      expectedActivationBoundary: "before";
      nextActivationBoundary: "before";
    }): Promise<boolean>;
    reconcileRollout(rolloutId: string): Promise<unknown>;
    listProvisioningIntents(rolloutId: string): Promise<
      readonly {
        readonly id: string;
        readonly effect: ExternalEffectRecord & {
          readonly reconciliation?: ExternalEffectReconciliation;
        };
      }[]
    >;
  };
  compensateDatabase(): Promise<DatabaseAclWitness>;
  observeDatabaseCompensation(): Promise<DatabaseAclWitness | null>;
  provider: {
    /** The implementation consumes per-service recovery permits internally. */
    readonly recoveryEffectsAreAuthorityMediated: true;
    recoverSourceFreeze(input: {
      decision: import("./ports").ProviderAuthorityDecision;
      databaseWitness: DatabaseAclWitness;
      sourceWriterServiceIds: readonly string[];
      sourceFreeze: SourceFreezeEvidence;
      activationBoundary: CompensationCheckpoint["activationBoundary"];
    }): Promise<import("./ports").ProviderStateWitness>;
  };
};

export type CompensationSafetyReconciliation = Readonly<{
  result: "clean" | "pending" | "blocked";
  safeForCompensation: boolean;
  reason?: "unknown" | "duplicate" | "timeout" | "missing_evidence";
  intentCount: number;
  intents: readonly Readonly<{
    id: string;
    state: ExternalEffectRecord["state"];
    safeForCompensation: boolean;
  }>[];
}>;

/** Application gate: transport adapters supply durable facts; only this gate decides safety. */
export function reconcileCompensationSafety(
  evidence: readonly {
    readonly id: string;
    readonly effect: ExternalEffectRecord & {
      readonly reconciliation?: ExternalEffectReconciliation;
    };
  }[],
): CompensationSafetyReconciliation {
  if (evidence.length === 0)
    return {
      result: "blocked",
      safeForCompensation: false,
      reason: "missing_evidence",
      intentCount: 0,
      intents: [],
    };
  if (new Set(evidence.map(({ id }) => id)).size !== evidence.length)
    return {
      result: "blocked",
      safeForCompensation: false,
      reason: "duplicate",
      intentCount: evidence.length,
      intents: [],
    };

  const intents = evidence.map(({ id, effect: value }) => {
    const effect = assertExternalEffectRecord(value);
    return {
      id,
      state: effect.state,
      safeForCompensation: effect.safeForCompensation,
    };
  });
  const blocked = evidence.find(
    ({ effect }) => effect.state === ExternalEffectState.Blocked,
  );
  if (blocked) {
    const reportedReason = blocked.effect.reconciliation;
    return {
      result: "blocked",
      safeForCompensation: false,
      reason:
        reportedReason?.result === "blocked" &&
        (reportedReason.reason === "duplicate" ||
          reportedReason.reason === "timeout")
          ? reportedReason.reason
          : "unknown",
      intentCount: intents.length,
      intents,
    };
  }
  if (
    intents.every(
      ({ state, safeForCompensation }) =>
        (state === ExternalEffectState.Cleaned ||
          state === ExternalEffectState.Abandoned) &&
        safeForCompensation,
    )
  )
    return {
      result: "clean",
      safeForCompensation: true,
      intentCount: intents.length,
      intents,
    };
  return {
    result: "pending",
    safeForCompensation: false,
    intentCount: intents.length,
    intents,
  };
}

function freezeMutationIsProven(checkpoint: CompensationCheckpoint): boolean {
  const freeze = checkpoint.sourceFreeze;
  return (
    (freeze.status === "partial" || freeze.status === "complete") &&
    sourceWriterServiceIdsAreValid(freeze.serviceIds) &&
    freeze.services.length === freeze.serviceIds.length &&
    freeze.services.every(
      (service, index) =>
        service.serviceId === freeze.serviceIds[index] &&
        service.latestSuccessfulDeployId.length > 0 &&
        Number.isFinite(Date.parse(service.observedAt)),
    )
  );
}

function missingFreezeEvidence(
  intentCount: number,
): CompensationSafetyReconciliation {
  return {
    result: "blocked",
    safeForCompensation: false,
    reason: "missing_evidence",
    intentCount,
    intents: [],
  };
}

function zeroIntentCompensationSafety(
  checkpoint: CompensationCheckpoint,
): CompensationSafetyReconciliation {
  if (freezeMutationIsProven(checkpoint))
    return {
      result: "clean",
      safeForCompensation: true,
      intentCount: 0,
      intents: [],
    };
  return missingFreezeEvidence(0);
}

export class ReleaseCompensationReconciliationUseCase {
  private readonly recoveryEffects: RecoveryEffectProtocol;
  constructor(private readonly ports: CompensationPorts) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(ports.recoveryOwnerId))
      throw new Error("release_compensation_recovery_owner_invalid");
    this.recoveryEffects = new RecoveryEffectProtocol(ports.ledger);
  }

  /** Immediate-failure entry point; scheduled reconciliation uses execute(). */
  async recover(rollout: ReleaseRollout): Promise<ReleaseRollout> {
    const result = await this.execute(rollout);
    if (result.outcome !== "compensated" && result.outcome !== "no_op")
      throw new Error(`release_compensation_${result.outcome}`);
    if (rollout.phase === "recovery_compensated") return rollout;
    return completeCompensation(beginCompensation(rollout));
  }

  async execute(rollout: ReleaseRollout): Promise<{
    outcome: "compensated" | "forward_only" | "denied" | "no_op";
    externalEffects?: CompensationSafetyReconciliation;
    reconciliation: unknown;
  }> {
    let { checkpoint, externalEffects } = await this.safetySnapshot(rollout);
    if (checkpoint.activationBoundary !== "before")
      return {
        outcome: "forward_only",
        reconciliation: await this.ports.ledger.reconcileRollout(
          rollout.rolloutId,
        ),
      };

    if (
      externalEffects.intentCount === 0 &&
      checkpoint.sourceFreeze.status === "none"
    )
      return {
        outcome: "no_op",
        externalEffects: {
          result: "clean",
          safeForCompensation: true,
          intentCount: 0,
          intents: [],
        },
        reconciliation: { state: "pre_activation_no_source_mutation" },
      };
    if (!externalEffects.safeForCompensation)
      return {
        outcome: "denied",
        externalEffects,
        reconciliation: null,
      };

    if (checkpoint.state === "pre_activation")
      await this.append(rollout, checkpoint, {
        step: RolloutStep.BeginCompensation,
        observedAt: new Date().toISOString(),
        facts: {
          activationBoundary: "before",
          sourceSystemIdentifier: rollout.source.systemIdentifier,
          sourceFreeze: checkpoint.sourceFreeze,
          externalEffects,
        },
      });

    ({ checkpoint, externalEffects } = await this.safetySnapshot(rollout));
    if (!externalEffects.safeForCompensation)
      return { outcome: "denied", externalEffects, reconciliation: null };

    if (
      checkpoint.state === "compensating" &&
      checkpoint.lastStep === RolloutStep.BeginCompensation
    ) {
      const decision = await this.ports.authority.decide({
        rolloutId: rollout.rolloutId,
        operation: ProviderAuthorityOperation.ResumeSource,
        sourceSystemIdentifier: rollout.source.systemIdentifier,
        targetSystemIdentifier: rollout.target.systemIdentifier,
        expectedReceiptSha256: checkpoint.lastReceiptSha256,
        activationBoundary: "before",
      });
      if (
        decision.decision !== "allow" ||
        decision.operation !== ProviderAuthorityOperation.ResumeSource ||
        decision.rolloutId !== rollout.rolloutId ||
        decision.sourceSystemIdentifier !== rollout.source.systemIdentifier ||
        decision.targetSystemIdentifier !== rollout.target.systemIdentifier ||
        decision.expectedReceiptSha256 !== checkpoint.lastReceiptSha256 ||
        decision.activationBoundary !== "before" ||
        !decision.decisionId ||
        Number.isNaN(Date.parse(decision.decidedAt))
      )
        throw new Error("provider_authority_decision_invalid");

      ({ checkpoint, externalEffects } = await this.safetySnapshot(rollout));
      if (!externalEffects.safeForCompensation)
        return { outcome: "denied", externalEffects, reconciliation: null };
      if (
        checkpoint.state !== "compensating" ||
        checkpoint.lastStep !== RolloutStep.BeginCompensation
      )
        throw new Error("release_compensation_checkpoint_changed");

      let databaseWitness: DatabaseAclWitness | undefined;
      const databaseEffect = await this.recoveryEffects.execute({
        rolloutId: rollout.rolloutId,
        effectKey: "restore_database_writes",
        kind: RecoveryEffectKind.RestoreDatabaseWrites,
        ownerId: this.ports.recoveryOwnerId,
        effect: async () => {
          databaseWitness = await this.ports.compensateDatabase();
          return databaseWitness;
        },
        observe: async (witness) => witness,
        reconcileConsumed: () => this.ports.observeDatabaseCompensation(),
      });
      if (databaseEffect.state === RecoveryEffectState.ForwardRepair)
        return {
          outcome: "forward_only",
          externalEffects,
          reconciliation: await this.ports.ledger.reconcileRollout(
            rollout.rolloutId,
          ),
        };
      if (databaseEffect.state !== RecoveryEffectState.Completed)
        throw new Error("release_database_recovery_effect_ambiguous");
      databaseWitness ??= databaseEffect.observation as DatabaseAclWitness;

      ({ checkpoint, externalEffects } = await this.safetySnapshot(rollout));
      if (!externalEffects.safeForCompensation)
        return { outcome: "denied", externalEffects, reconciliation: null };

      const providerWitness = await this.ports.provider.recoverSourceFreeze({
        decision,
        databaseWitness,
        sourceWriterServiceIds: checkpoint.sourceFreeze.serviceIds,
        sourceFreeze: checkpoint.sourceFreeze,
        activationBoundary: checkpoint.activationBoundary,
      });

      ({ checkpoint, externalEffects } = await this.safetySnapshot(rollout));
      if (!externalEffects.safeForCompensation)
        return { outcome: "denied", externalEffects, reconciliation: null };

      await this.append(rollout, checkpoint, {
        step: RolloutStep.EffectCompensation,
        observedAt: new Date().toISOString(),
        facts: { databaseWitness, providerWitness },
        provider: {
          renderServiceIds: providerWitness.serviceIds,
          renderDeployIds: providerWitness.deployIds,
        },
      });

      ({ checkpoint, externalEffects } = await this.safetySnapshot(rollout));
      if (!externalEffects.safeForCompensation)
        return { outcome: "denied", externalEffects, reconciliation: null };
    }

    if (
      checkpoint.state === "compensating" &&
      checkpoint.lastStep === RolloutStep.EffectCompensation
    )
      await this.append(rollout, checkpoint, {
        step: RolloutStep.CompleteCompensation,
        observedAt: new Date().toISOString(),
        facts: { activationBoundary: "before", independentWitnesses: true },
      });

    ({ checkpoint, externalEffects } = await this.safetySnapshot(rollout));
    if (!externalEffects.safeForCompensation)
      return { outcome: "denied", externalEffects, reconciliation: null };
    if (checkpoint.state !== "compensated")
      throw new Error("release_compensation_checkpoint_incomplete");

    return {
      outcome: "compensated",
      externalEffects,
      reconciliation: await this.ports.ledger.reconcileRollout(
        rollout.rolloutId,
      ),
    };
  }

  private checkpoint(rollout: ReleaseRollout) {
    return this.ports.ledger.observeCompensationCheckpoint({
      rolloutId: rollout.rolloutId,
      sourceSystemIdentifier: rollout.source.systemIdentifier,
      targetSystemIdentifier: rollout.target.systemIdentifier,
    });
  }

  private async safetySnapshot(rollout: ReleaseRollout): Promise<{
    checkpoint: CompensationCheckpoint;
    externalEffects: CompensationSafetyReconciliation;
  }> {
    const checkpoint = await this.checkpoint(rollout);
    const intents = await this.ports.ledger.listProvisioningIntents(
      rollout.rolloutId,
    );
    const runnerSafety = intents.length
      ? reconcileCompensationSafety(intents)
      : zeroIntentCompensationSafety(checkpoint);
    return {
      checkpoint,
      externalEffects: freezeMutationIsProven(checkpoint)
        ? runnerSafety
        : missingFreezeEvidence(intents.length),
    };
  }

  private async append(
    rollout: ReleaseRollout,
    checkpoint: CompensationCheckpoint,
    observation: StepObservation,
  ) {
    const base = {
      step: observation.step,
      receiptId: `${rollout.rolloutId}:${observation.step}:${checkpoint.receiptCount + 1}`,
      observedAt: observation.observedAt,
      rolloutId: rollout.rolloutId,
      expectedCommitSha: rollout.expectedCommitSha,
      runId: rollout.execution.runId,
      runAttempt: rollout.execution.runAttempt,
      sourceSystemIdentifier: rollout.source.systemIdentifier,
      targetSystemIdentifier: rollout.target.systemIdentifier,
      provider: observation.provider,
      observationSha256: `sha256:${sha256Canonical(observation.facts)}`,
      previousReceiptSha256: checkpoint.lastReceiptSha256,
    };
    const nextReceiptSha256 = `sha256:${sha256Canonical(base)}`;
    const changed = await this.ports.ledger.compareAndSet({
      rolloutId: rollout.rolloutId,
      expectedCommitSha: rollout.expectedCommitSha,
      runId: rollout.execution.runId,
      runAttempt: rollout.execution.runAttempt,
      sourceSystemIdentifier: rollout.source.systemIdentifier,
      targetSystemIdentifier: rollout.target.systemIdentifier,
      step: observation.step,
      provider: observation.provider,
      expectedReceiptSha256: checkpoint.lastReceiptSha256,
      nextReceiptSha256,
      authoritativeSystemIdentifier: rollout.source.systemIdentifier,
      expectedActivationBoundary: "before",
      nextActivationBoundary: "before",
    });
    if (!changed) throw new Error("rollout_receipt_ledger_cas_failed");
    return await this.checkpoint(rollout);
  }
}
