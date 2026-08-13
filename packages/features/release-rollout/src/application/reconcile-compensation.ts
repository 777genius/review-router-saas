import {
  ExternalEffectState,
  assertExternalEffectRecord,
  type ExternalEffectRecord,
  type ExternalEffectReconciliation,
} from "../domain/external-effect";
import {
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
  type ProviderControlPort,
} from "./ports";

type CompensationPorts = {
  authority: ProviderAuthorityDecisionPort;
  ledger: {
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
  provider: Pick<ProviderControlPort, "compensateAndObserve">;
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

export class ReleaseCompensationReconciliationUseCase {
  constructor(private readonly ports: CompensationPorts) {}

  async execute(rollout: ReleaseRollout): Promise<{
    outcome: "compensated" | "forward_only" | "denied";
    externalEffects?: CompensationSafetyReconciliation;
    reconciliation: unknown;
  }> {
    let checkpoint = await this.checkpoint(rollout);
    if (checkpoint.activationBoundary !== "before")
      return {
        outcome: "forward_only",
        reconciliation: await this.ports.ledger.reconcileRollout(
          rollout.rolloutId,
        ),
      };

    const externalEffects = reconcileCompensationSafety(
      await this.ports.ledger.listProvisioningIntents(rollout.rolloutId),
    );
    if (!externalEffects.safeForCompensation)
      return {
        outcome: "denied",
        externalEffects,
        reconciliation: null,
      };

    if (checkpoint.state === "pre_activation")
      checkpoint = await this.append(rollout, checkpoint, {
        step: RolloutStep.BeginCompensation,
        observedAt: new Date().toISOString(),
        facts: {
          activationBoundary: "before",
          sourceSystemIdentifier: rollout.source.systemIdentifier,
        },
      });

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
      const databaseWitness = await this.ports.compensateDatabase();
      const providerWitness = await this.ports.provider.compensateAndObserve({
        decision,
        databaseWitness,
      });
      checkpoint = await this.append(rollout, checkpoint, {
        step: RolloutStep.EffectCompensation,
        observedAt: new Date().toISOString(),
        facts: { databaseWitness, providerWitness },
        provider: {
          renderServiceIds: providerWitness.serviceIds,
          renderDeployIds: providerWitness.deployIds,
        },
      });
    }

    if (
      checkpoint.state === "compensating" &&
      checkpoint.lastStep === RolloutStep.EffectCompensation
    )
      checkpoint = await this.append(rollout, checkpoint, {
        step: RolloutStep.CompleteCompensation,
        observedAt: new Date().toISOString(),
        facts: { activationBoundary: "before", independentWitnesses: true },
      });

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
