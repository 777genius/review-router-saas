import {
  RecoveryEffectState,
  assertRecoveryEffectConsumptionResult,
  assertRecoveryEffectExecutionAuthorization,
  assertRecoveryEffectObservation,
  assertRecoveryEffectRecordBinding,
  mayConsumeRecoveryPermit,
  type RecoveryEffectKind,
  type RecoveryEffectConsumptionResult,
  type RecoveryEffectRecord,
} from "../domain/recovery-effect";

export interface RecoveryEffectAuthorityPort {
  intendRecoveryEffect(input: {
    rolloutId: string;
    effectKey: string;
    kind: RecoveryEffectKind;
    serviceId?: string;
  }): Promise<RecoveryEffectRecord>;
  claimRecoveryEffect(input: {
    rolloutId: string;
    effectKey: string;
    kind: RecoveryEffectKind;
    ownerId: string;
    leaseSeconds: number;
  }): Promise<RecoveryEffectRecord>;
  consumeRecoveryEffectPermit(input: {
    rolloutId: string;
    effectKey: string;
    kind: RecoveryEffectKind;
    ownerId: string;
    epoch: number;
    permitToken: string;
  }): Promise<RecoveryEffectConsumptionResult>;
  validateRecoveryEffectExecution(input: {
    rolloutId: string;
    effectKey: string;
    kind: RecoveryEffectKind;
    ownerId: string;
    epoch: number;
    permitToken: string;
    executionReceipt: string;
  }): Promise<RecoveryEffectConsumptionResult>;
  completeRecoveryEffect(input: {
    rolloutId: string;
    effectKey: string;
    kind: RecoveryEffectKind;
    ownerId: string;
    epoch: number;
    permitToken: string;
    executionReceipt: string;
    observation: unknown;
  }): Promise<RecoveryEffectRecord>;
  reconcileRecoveryEffect(input: {
    rolloutId: string;
    effectKey: string;
    kind: RecoveryEffectKind;
    ownerId: string;
    epoch: number;
    permitToken: string;
    observation: unknown;
  }): Promise<RecoveryEffectRecord>;
}

/**
 * Coordinates a recovery effect without retaining an authority transaction
 * across the supplied provider/database call. A consumed record is ambiguous
 * until independently observed; it is never automatically replayed.
 */
export class RecoveryEffectProtocol {
  constructor(private readonly authority: RecoveryEffectAuthorityPort) {}

  async execute<T>(input: {
    rolloutId: string;
    effectKey: string;
    kind: RecoveryEffectKind;
    serviceId?: string;
    ownerId: string;
    leaseSeconds?: number;
    effect: (
      permit: Readonly<{
        epoch: number;
        token: string;
        executionReceipt: string;
      }>,
      executeAuthorized: <R>(io: () => Promise<R>) => Promise<R>,
    ) => Promise<T>;
    observe: (response: T) => Promise<unknown>;
    reconcileConsumed?: () => Promise<T | null>;
  }): Promise<RecoveryEffectRecord> {
    const intended = assertRecoveryEffectRecordBinding(
      await this.authority.intendRecoveryEffect({
        rolloutId: input.rolloutId,
        effectKey: input.effectKey,
        kind: input.kind,
        ...(input.serviceId ? { serviceId: input.serviceId } : {}),
      }),
      {
        rolloutId: input.rolloutId,
        effectKey: input.effectKey,
        kind: input.kind,
        serviceId: input.serviceId ?? null,
      },
    );
    if (
      intended.state === RecoveryEffectState.Completed ||
      intended.state === RecoveryEffectState.ForwardRepair
    )
      return intended;
    if (
      intended.state === RecoveryEffectState.Consumed ||
      intended.state === RecoveryEffectState.Executing
    ) {
      if (!input.reconcileConsumed) return intended;
      const response = await input.reconcileConsumed();
      if (response === null) return intended;
      return this.reconcileFromObservation({
        rolloutId: input.rolloutId,
        effectKey: input.effectKey,
        consumed: intended,
        observation: await input.observe(response),
      });
    }
    const claim = assertRecoveryEffectRecordBinding(
      await this.authority.claimRecoveryEffect({
        rolloutId: input.rolloutId,
        effectKey: input.effectKey,
        kind: input.kind,
        ownerId: input.ownerId,
        leaseSeconds: input.leaseSeconds ?? 60,
      }),
      {
        rolloutId: input.rolloutId,
        effectKey: input.effectKey,
        kind: input.kind,
      },
    );
    if (claim.state !== RecoveryEffectState.Claimed) return claim;
    if (
      !mayConsumeRecoveryPermit({
        record: claim,
        ownerId: input.ownerId,
        epoch: claim.epoch,
        permitToken: claim.permitToken!,
        now: new Date().toISOString(),
      })
    )
      throw new Error("recovery_effect_claim_invalid_or_expired");
    const consumption = assertRecoveryEffectConsumptionResult(
      await this.authority.consumeRecoveryEffectPermit({
        rolloutId: input.rolloutId,
        effectKey: input.effectKey,
        kind: input.kind,
        ownerId: input.ownerId,
        epoch: claim.epoch,
        permitToken: claim.permitToken!,
      }),
      {
        rolloutId: input.rolloutId,
        effectKey: input.effectKey,
        kind: input.kind,
        ownerId: input.ownerId,
        epoch: claim.epoch,
        permitToken: claim.permitToken!,
      },
    );
    const consumed = consumption.record;
    if (consumed.state !== RecoveryEffectState.Consumed) return consumed;
    // A consumed snapshot alone never authorizes I/O. Only the linearization
    // winner receives this non-replayable response capability.
    if (consumption.executionAuthorization === null) return consumed;
    let executed = false;
    const executeAuthorized = async <R>(io: () => Promise<R>): Promise<R> => {
      if (executed) throw new Error("recovery_effect_execution_replay");
      executed = true;
      const validation = assertRecoveryEffectConsumptionResult(
        await this.authority.validateRecoveryEffectExecution({
          rolloutId: input.rolloutId,
          effectKey: input.effectKey,
          kind: input.kind,
          ownerId: input.ownerId,
          epoch: consumed.epoch,
          permitToken: consumed.permitToken!,
          executionReceipt: consumption.executionAuthorization!.receipt,
        }),
        {
          rolloutId: input.rolloutId,
          effectKey: input.effectKey,
          kind: input.kind,
          ownerId: input.ownerId,
          epoch: consumed.epoch,
          permitToken: consumed.permitToken!,
        },
      );
      if (validation.executionAuthorization === null)
        throw new Error("recovery_effect_execution_not_authorized");
      assertRecoveryEffectExecutionAuthorization(
        validation.executionAuthorization,
        consumption.executionAuthorization!,
      );
      // No application/provider observation may occur between this committed
      // authority validation and invoking the supplied one-shot I/O closure.
      return io();
    };
    const executionAuthorization = consumption.executionAuthorization;
    const response = await input.effect(
      {
        epoch: consumed.epoch,
        token: consumed.permitToken!,
        executionReceipt: executionAuthorization.receipt,
      },
      executeAuthorized,
    );
    if (!executed) throw new Error("recovery_effect_execution_not_authorized");
    const observation = assertRecoveryEffectObservation(
      input.kind,
      await input.observe(response),
    );
    return assertRecoveryEffectRecordBinding(
      await this.authority.completeRecoveryEffect({
        rolloutId: input.rolloutId,
        effectKey: input.effectKey,
        kind: consumed.kind,
        ownerId: consumed.claimOwnerId!,
        epoch: consumed.epoch,
        permitToken: consumed.permitToken!,
        executionReceipt: executionAuthorization.receipt,
        observation,
      }),
      {
        rolloutId: input.rolloutId,
        effectKey: input.effectKey,
        kind: input.kind,
        ownerId: input.ownerId,
        epoch: consumed.epoch,
        permitToken: consumed.permitToken!,
      },
    );
  }

  async reconcileFromObservation(input: {
    rolloutId: string;
    effectKey: string;
    consumed: RecoveryEffectRecord;
    observation: unknown;
  }): Promise<RecoveryEffectRecord> {
    const consumed = assertRecoveryEffectRecordBinding(input.consumed, {
      rolloutId: input.rolloutId,
      effectKey: input.effectKey,
    });
    if (
      consumed.state !== RecoveryEffectState.Consumed &&
      consumed.state !== RecoveryEffectState.Executing
    )
      return consumed;
    const observation = assertRecoveryEffectObservation(
      consumed.kind,
      input.observation,
    );
    return assertRecoveryEffectRecordBinding(
      await this.authority.reconcileRecoveryEffect({
        rolloutId: input.rolloutId,
        effectKey: input.effectKey,
        kind: consumed.kind,
        ownerId: consumed.claimOwnerId!,
        epoch: consumed.epoch,
        permitToken: consumed.permitToken!,
        observation,
      }),
      {
        rolloutId: input.rolloutId,
        effectKey: input.effectKey,
        kind: consumed.kind,
        ownerId: consumed.claimOwnerId!,
        epoch: consumed.epoch,
        permitToken: consumed.permitToken!,
      },
    );
  }
}
