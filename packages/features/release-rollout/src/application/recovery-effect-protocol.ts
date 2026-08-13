import {
  RecoveryEffectState,
  assertRecoveryEffectRecord,
  mayConsumeRecoveryPermit,
  type RecoveryEffectKind,
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
    ownerId: string;
    leaseSeconds: number;
  }): Promise<RecoveryEffectRecord>;
  consumeRecoveryEffectPermit(input: {
    rolloutId: string;
    effectKey: string;
    ownerId: string;
    epoch: number;
    permitToken: string;
  }): Promise<RecoveryEffectRecord>;
  completeRecoveryEffect(input: {
    rolloutId: string;
    effectKey: string;
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
    effect: (permit: Readonly<{ epoch: number; token: string }>) => Promise<T>;
    observe: (response: T) => Promise<unknown>;
    reconcileConsumed?: () => Promise<T | null>;
  }): Promise<RecoveryEffectRecord> {
    const intended = assertRecoveryEffectRecord(
      await this.authority.intendRecoveryEffect({
        rolloutId: input.rolloutId,
        effectKey: input.effectKey,
        kind: input.kind,
        ...(input.serviceId ? { serviceId: input.serviceId } : {}),
      }),
    );
    if (
      intended.state === RecoveryEffectState.Completed ||
      intended.state === RecoveryEffectState.ForwardRepair
    )
      return intended;
    if (intended.state === RecoveryEffectState.Consumed) {
      if (!input.reconcileConsumed) return intended;
      const response = await input.reconcileConsumed();
      if (response === null) return intended;
      return this.completeFromObservation({
        rolloutId: input.rolloutId,
        effectKey: input.effectKey,
        consumed: intended,
        observation: await input.observe(response),
      });
    }
    const claim = assertRecoveryEffectRecord(
      await this.authority.claimRecoveryEffect({
        rolloutId: input.rolloutId,
        effectKey: input.effectKey,
        ownerId: input.ownerId,
        leaseSeconds: input.leaseSeconds ?? 60,
      }),
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
    const consumed = assertRecoveryEffectRecord(
      await this.authority.consumeRecoveryEffectPermit({
        rolloutId: input.rolloutId,
        effectKey: input.effectKey,
        ownerId: input.ownerId,
        epoch: claim.epoch,
        permitToken: claim.permitToken!,
      }),
    );
    if (consumed.state !== RecoveryEffectState.Consumed) return consumed;
    // No authority transaction exists while this callback performs I/O.
    const response = await input.effect({
      epoch: consumed.epoch,
      token: consumed.permitToken!,
    });
    const observation = await input.observe(response);
    return assertRecoveryEffectRecord(
      await this.authority.completeRecoveryEffect({
        rolloutId: input.rolloutId,
        effectKey: input.effectKey,
        epoch: consumed.epoch,
        permitToken: consumed.permitToken!,
        observation,
      }),
    );
  }

  async completeFromObservation(input: {
    rolloutId: string;
    effectKey: string;
    consumed: RecoveryEffectRecord;
    observation: unknown;
  }): Promise<RecoveryEffectRecord> {
    const consumed = assertRecoveryEffectRecord(input.consumed);
    if (consumed.state !== RecoveryEffectState.Consumed) return consumed;
    return assertRecoveryEffectRecord(
      await this.authority.completeRecoveryEffect({
        rolloutId: input.rolloutId,
        effectKey: input.effectKey,
        epoch: consumed.epoch,
        permitToken: consumed.permitToken!,
        observation: input.observation,
      }),
    );
  }
}
