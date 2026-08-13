import {
  ExternalEffectState,
  assertExternalEffectRecord,
  classifyExternalEffectDiscovery,
  mayDispatchProviderPost,
  type ExternalEffectControlReconciliation,
  type ExternalEffectRecord,
  type ExternalEffectReconciliation,
} from "../domain/external-effect";

export interface ExternalEffectDispatchAuthorityPort<TPrepare> {
  prepare(input: TPrepare): Promise<ExternalEffectRecord>;
  acquireDispatchPermit(input: {
    effectId: string;
    ownerId: string;
    expectedEpoch: number;
  }): Promise<ExternalEffectRecord>;
}

export interface ExternalEffectReconciliationAuthorityPort {
  reconcile(input: {
    effectId: string;
    ownerId: string;
    expectedEpoch: number;
    providerId?: string;
    reconciliation: ExternalEffectControlReconciliation;
    evidence?: unknown;
  }): Promise<ExternalEffectRecord>;
}

/** Orchestrates the only path allowed to cross an irreversible provider POST boundary. */
export class ExternalEffectDispatchUseCase<TPrepare, TResponse> {
  constructor(
    private readonly authority: ExternalEffectDispatchAuthorityPort<TPrepare>,
  ) {}

  async execute(input: {
    effectId: string;
    ownerId: string;
    prepare: TPrepare;
    dispatch: () => Promise<TResponse>;
  }): Promise<{ record: ExternalEffectRecord; response?: TResponse }> {
    const prepared = assertExternalEffectRecord(
      await this.authority.prepare(input.prepare),
    );
    if (prepared.state !== ExternalEffectState.Prepared)
      return { record: prepared };
    const permit = assertExternalEffectRecord(
      await this.authority.acquireDispatchPermit({
        effectId: input.effectId,
        ownerId: input.ownerId,
        expectedEpoch: prepared.epoch,
      }),
    );
    if (
      !mayDispatchProviderPost({
        record: permit,
        permitOwnerId: input.ownerId,
        permitEpoch: prepared.epoch + 1,
      })
    )
      return { record: permit };
    // A thrown/lost response deliberately leaves the durable state dispatching.
    return { record: permit, response: await input.dispatch() };
  }
}

/** Owns reconciliation commands; adapters only collect provider and cleanup evidence. */
export class ExternalEffectReconciliationUseCase {
  constructor(
    private readonly authority: ExternalEffectReconciliationAuthorityPort,
  ) {}

  async discover(input: {
    effectId: string;
    ownerId: string;
    expectedEpoch: number;
    matchingProviderIds: readonly string[];
    timedOut: boolean;
    legacyUnresolved?: boolean;
  }): Promise<{
    record: ExternalEffectRecord;
    reconciliation: ExternalEffectReconciliation;
  }> {
    const reconciliation = classifyExternalEffectDiscovery(input);
    const providerId =
      input.matchingProviderIds.length === 1
        ? input.matchingProviderIds[0]
        : undefined;
    const record = assertExternalEffectRecord(
      await this.authority.reconcile({
        effectId: input.effectId,
        ownerId: input.ownerId,
        expectedEpoch: input.expectedEpoch,
        ...(providerId ? { providerId } : {}),
        reconciliation,
      }),
    );
    return { record, reconciliation };
  }

  async blocked(input: {
    effectId: string;
    ownerId: string;
    expectedEpoch: number;
    reason: "unknown" | "duplicate" | "timeout" | "unresolved_legacy";
    providerId?: string;
    evidence?: unknown;
  }): Promise<ExternalEffectRecord> {
    return assertExternalEffectRecord(
      await this.authority.reconcile({
        effectId: input.effectId,
        ownerId: input.ownerId,
        expectedEpoch: input.expectedEpoch,
        ...(input.providerId ? { providerId: input.providerId } : {}),
        reconciliation: {
          result: "blocked",
          safeForCompensation: false,
          reason: input.reason,
        },
        ...(input.evidence ? { evidence: input.evidence } : {}),
      }),
    );
  }
}
