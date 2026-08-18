import {
  RenderProviderFreezeAdapter,
  RenderTransactionalServicesAdapter,
  SourceFreezeRecoveryUseCase,
  decideSourceFreezeRecovery,
  type CompensationCheckpoint,
  type ProviderStateWitness,
  type RecoveryEffectAuthorityPort,
  type ProviderMutationAuthorityPort,
} from "../../packages/features/release-rollout/src/index";

/** Render is confined to this composition adapter; the use case stays provider-neutral. */
export function createPrivatePg17SourceFreezeRecovery(input: {
  ledger: RecoveryEffectAuthorityPort;
  ownerId: string;
  apiKey: string;
  sourceSystemIdentifier: string;
  rolloutId: string;
  mutationAuthority: ProviderMutationAuthorityPort;
  beforeResume?: () => Promise<ProviderStateWitness | void>;
}) {
  const freeze = new RenderProviderFreezeAdapter(
    fetch,
    undefined,
    input.mutationAuthority,
  );
  const services = new RenderTransactionalServicesAdapter(
    input.apiKey,
    fetch,
    undefined,
    input.mutationAuthority,
    { rolloutId: input.rolloutId, ownerId: input.ownerId },
  );
  const recovery = new SourceFreezeRecoveryUseCase({
    ownerId: input.ownerId,
    authority: input.ledger,
    provider: {
      resumeFrozenSourceService: async ({
        evidence,
        decision,
        databaseWitness,
        executionPermit,
        executeAuthorized,
      }) => {
        await freeze.resumeFrozenServiceAndObserve({
          apiKey: input.apiKey,
          serviceId: evidence.serviceId,
          rolloutId: input.rolloutId,
          mutationOwnerId: input.ownerId,
          expectedDeployId: evidence.latestSuccessfulDeployId,
          sourceSystemIdentifier: input.sourceSystemIdentifier,
          decision,
          databaseWitness,
          executionPermit,
          executeAuthorized,
        });
        return services.observe(evidence.serviceId);
      },
      observeFrozenSourceService: async (evidence) => {
        if (
          !(await freeze.observeFrozenServiceRecovery({
            apiKey: input.apiKey,
            serviceId: evidence.serviceId,
            expectedDeployId: evidence.latestSuccessfulDeployId,
          }))
        )
          return null;
        const observed = await services.observe(evidence.serviceId);
        return observed.suspended ? null : observed;
      },
    },
  });
  let prepared = false;
  let preparedWitness: ProviderStateWitness | undefined;

  return {
    recoveryEffectsAreAuthorityMediated: true as const,
    recoverSourceFreeze: async (value: {
      decision: Parameters<
        SourceFreezeRecoveryUseCase["execute"]
      >[0]["decision"];
      databaseWitness: Parameters<
        SourceFreezeRecoveryUseCase["execute"]
      >[0]["databaseWitness"];
      sourceWriterServiceIds: readonly string[];
      sourceFreeze: CompensationCheckpoint["sourceFreeze"];
      activationBoundary: CompensationCheckpoint["activationBoundary"];
    }) => {
      if (
        JSON.stringify(value.sourceWriterServiceIds) !==
        JSON.stringify(value.sourceFreeze.serviceIds)
      )
        throw new Error("private_pg17_source_freeze_scope_mismatch");
      const policy = decideSourceFreezeRecovery({
        activationBoundary: value.activationBoundary,
        sourceFreeze: value.sourceFreeze,
      });
      if (policy.outcome !== "recover")
        throw new Error(`private_pg17_source_freeze_${policy.outcome}`);
      if (!prepared) {
        preparedWitness = (await input.beforeResume?.()) ?? undefined;
        prepared = true;
      }
      if (preparedWitness) {
        if (
          JSON.stringify(preparedWitness.serviceIds) !==
            JSON.stringify(value.sourceWriterServiceIds) ||
          preparedWitness.resumed !== true
        )
          throw new Error("private_pg17_transition_recovery_scope_mismatch");
        return preparedWitness;
      }
      const result = await recovery.execute({
        checkpoint: {
          activationBoundary: value.activationBoundary,
          state: "compensating",
          lastReceiptSha256: value.decision.expectedReceiptSha256,
          lastStep: "begin_compensation",
          receiptCount: 0,
          sourceFreeze: value.sourceFreeze,
        },
        decision: value.decision,
        databaseWitness: value.databaseWitness,
      });
      if (!result.witness)
        throw new Error(
          `private_pg17_source_freeze_${result.decision.outcome}`,
        );
      return result.witness;
    },
  };
}
