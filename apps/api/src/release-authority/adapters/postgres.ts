import type { PrismaClient } from "@reviewrouter/platform-db";
import { Prisma } from "@prisma/client";
import type {
  ActivationAuthorization,
  ProviderAuthorityDecision,
  ProviderAuthorityRequest,
  RunnerIdentity,
  StepObservation,
  TargetSwitchFence,
} from "@reviewrouter/features-release-rollout";
import { assertExternalEffectRecord } from "@reviewrouter/features-release-rollout";
import type {
  IndependentCleanupWitness,
  PersistedJob,
  PersistedProviderCleanupWitness,
  PersistRunnerRegistrationInput,
  CreateProvisioningIntent,
  ProvisioningIntent,
  ReleaseAuthorityState,
  ReleaseCompensationCheckpoint,
  ReleaseAuthorityLedgerPort,
  ReleaseRolloutReconciliationPort,
  ReleaseRolloutReconciliationContext,
  RolloutBinding,
  RunnerCleanupWitnessPort,
  RunnerOperationsLedgerPort,
  WitnessGatedTerminalCleanupFact,
  ReleaseServiceTransitionLedgerPort,
} from "../domain/model.js";
import type {
  ServiceTransitionCheckpoint,
  ServiceTransitionLedger,
} from "@reviewrouter/features-release-rollout";

type JsonRow = { value: unknown };

const conflictMessages = new Set([
  "release rollout claim identity conflict",
  "release authority activation identity conflict",
  "release authority activation replay conflict",
  "release authority activation receipt conflict",
  "provider authority replay conflict",
  "release runner intent identity conflict",
]);

const normalizeRoutineError = (error: unknown): never => {
  const value =
    error && typeof error === "object"
      ? (error as {
          code?: unknown;
          message?: unknown;
          meta?: { code?: unknown; message?: unknown };
        })
      : undefined;
  const databaseCode = value?.meta?.code ?? value?.code;
  const detail = String(value?.meta?.message ?? value?.message ?? "");
  if (
    databaseCode === "P0001" &&
    [...conflictMessages].some((message) => detail.includes(message))
  )
    throw Object.assign(new Error("release_authority_conflict"), {
      statusCode: 409,
    });
  throw error;
};

const firstValue = async (
  prisma: PrismaClient,
  query: Prisma.Sql,
): Promise<unknown> => {
  let rows: JsonRow[] | undefined;
  try {
    rows = await prisma.$queryRaw<JsonRow[]>(query);
  } catch (error) {
    normalizeRoutineError(error);
  }
  if (!rows || rows.length !== 1)
    throw new Error("release_control_routine_result_missing");
  return rows[0]?.value;
};

const requiredBoolean = (value: unknown): boolean => {
  if (typeof value !== "boolean")
    throw new Error("release_control_routine_boolean_invalid");
  return value;
};

const requiredRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("release_control_routine_record_invalid");
  return value as Record<string, unknown>;
};

const asJsonb = (value: unknown): Prisma.Sql =>
  Prisma.sql`${JSON.stringify(value)}::jsonb`;

export class RoutineReleaseControlLedgerAdapter
  implements
    ReleaseAuthorityLedgerPort,
    RunnerOperationsLedgerPort,
    ReleaseRolloutReconciliationPort,
    ReleaseServiceTransitionLedgerPort
{
  constructor(private readonly prisma: PrismaClient) {}

  async claim(input: RolloutBinding): Promise<"claimed" | "duplicate"> {
    const value = await firstValue(
      this.prisma,
      Prisma.sql`SELECT release_authority.release_rollout_claim(
        ${input.rolloutId}, ${input.expectedCommitSha}, ${input.runId},
        ${input.runAttempt}, ${input.sourceSystemIdentifier},
        ${input.targetSystemIdentifier}) AS value`,
    );
    if (value !== "claimed" && value !== "duplicate")
      throw new Error("release_rollout_claim_result_invalid");
    return value;
  }

  async compareAndSet(
    input: Parameters<ReleaseAuthorityLedgerPort["compareAndSet"]>[0],
  ): Promise<boolean> {
    return requiredBoolean(
      await firstValue(
        this.prisma,
        Prisma.sql`SELECT release_authority.release_rollout_append_receipt(
          ${input.rolloutId}, ${input.expectedCommitSha}, ${input.runId},
          ${input.runAttempt}, ${input.sourceSystemIdentifier},
          ${input.targetSystemIdentifier}, ${input.step},
          ${input.expectedReceiptSha256}, ${input.nextReceiptSha256},
          ${input.authoritativeSystemIdentifier}, ${input.expectedActivationBoundary},
          ${input.nextActivationBoundary}, ${asJsonb(input.provider ?? null)}) AS value`,
      ),
    );
  }

  async markActivationUncertain(input: RolloutBinding): Promise<boolean> {
    return requiredBoolean(
      await firstValue(
        this.prisma,
        Prisma.sql`SELECT release_authority.release_rollout_mark_activation_uncertain(
          ${input.rolloutId}, ${input.expectedCommitSha}, ${input.runId},
          ${input.runAttempt}, ${input.sourceSystemIdentifier},
          ${input.targetSystemIdentifier}) AS value`,
      ),
    );
  }

  async fenceTargetSwitch(
    input: Parameters<ReleaseAuthorityLedgerPort["fenceTargetSwitch"]>[0],
  ): Promise<TargetSwitchFence | null> {
    const value = await firstValue(
      this.prisma,
      Prisma.sql`SELECT release_authority.release_rollout_fence_target_switch(
        ${input.rolloutId}, ${input.expectedCommitSha}, ${input.runId},
        ${input.runAttempt}, ${input.sourceSystemIdentifier},
        ${input.targetSystemIdentifier}, ${input.previousReceiptSha256}) AS value`,
    );
    return value === null
      ? null
      : (requiredRecord(value) as unknown as TargetSwitchFence);
  }

  async authorizeActivation(
    input: Parameters<ReleaseAuthorityLedgerPort["authorizeActivation"]>[0],
  ): Promise<ActivationAuthorization> {
    return requiredRecord(
      await firstValue(
        this.prisma,
        Prisma.sql`SELECT release_authority.authorize_activation(
          ${input.rolloutId}, ${input.expectedCommitSha}, ${input.runId},
          ${input.runAttempt}, ${input.sourceSystemIdentifier},
          ${input.targetSystemIdentifier}, ${input.jobId},
          ${input.previousReceiptSha256}, ${asJsonb(input.targetDeployIds)},
          ${input.postgresMajor}, ${input.migrationChecksum}) AS value`,
      ),
    ) as unknown as ActivationAuthorization;
  }

  async finalizeActivation(
    input: Parameters<ReleaseAuthorityLedgerPort["finalizeActivation"]>[0],
  ): Promise<boolean> {
    return requiredBoolean(
      await firstValue(
        this.prisma,
        Prisma.sql`SELECT release_authority.release_rollout_finalize_activation(
          ${asJsonb(input.authorization)}, ${asJsonb(input.provider ?? null)},
          ${input.nextReceiptSha256}, ${asJsonb(input.activationReceipt)}) AS value`,
      ),
    );
  }

  async activationState(
    input: Parameters<ReleaseAuthorityLedgerPort["activationState"]>[0],
  ): Promise<"before" | "uncertain" | "activated"> {
    const value = await firstValue(
      this.prisma,
      Prisma.sql`SELECT release_authority.release_rollout_activation_state(
        ${input.rolloutId}, ${input.sourceSystemIdentifier},
        ${input.targetSystemIdentifier}) AS value`,
    );
    if (value !== "before" && value !== "uncertain" && value !== "activated")
      throw new Error("release_rollout_activation_state_invalid");
    return value;
  }

  async authorityState(
    input: Parameters<ReleaseAuthorityLedgerPort["authorityState"]>[0],
  ): Promise<ReleaseAuthorityState> {
    const value = await firstValue(
      this.prisma,
      Prisma.sql`SELECT release_authority.observe_state(
        ${input.rolloutId}, ${input.sourceSystemIdentifier},
        ${input.targetSystemIdentifier}) AS value`,
    );
    if (
      typeof value !== "string" ||
      ![
        "pre_activation",
        "compensating",
        "compensated",
        "activation_authorized",
        "activated",
        "outcome_unknown",
        "forward_repair_required",
      ].includes(value)
    )
      throw new Error("release_authority_state_invalid");
    return value as ReleaseAuthorityState;
  }

  async compensationCheckpoint(
    input: Parameters<ReleaseAuthorityLedgerPort["compensationCheckpoint"]>[0],
  ): Promise<ReleaseCompensationCheckpoint> {
    return requiredRecord(
      await firstValue(
        this.prisma,
        Prisma.sql`SELECT release_authority.release_rollout_compensation_checkpoint(
          ${input.rolloutId}, ${input.sourceSystemIdentifier},
          ${input.targetSystemIdentifier}) AS value`,
      ),
    ) as ReleaseCompensationCheckpoint;
  }

  async verifyFinalAuthority(
    input: Parameters<ReleaseAuthorityLedgerPort["verifyFinalAuthority"]>[0],
  ): Promise<boolean> {
    return requiredBoolean(
      await firstValue(
        this.prisma,
        Prisma.sql`SELECT release_authority.release_rollout_verify_final_authority(
          ${input.rolloutId}, ${input.expectedCommitSha}, ${input.runId},
          ${input.runAttempt}, ${input.sourceSystemIdentifier},
          ${input.targetSystemIdentifier}, ${input.expectedReceiptSha256},
          ${asJsonb(input.activationReceipt)}) AS value`,
      ),
    );
  }

  async decideProviderOperation(
    input: ProviderAuthorityRequest,
  ): Promise<ProviderAuthorityDecision> {
    return requiredRecord(
      await firstValue(
        this.prisma,
        Prisma.sql`SELECT release_authority.release_provider_authority_decide(
          ${asJsonb(input)}) AS value`,
      ),
    ) as unknown as ProviderAuthorityDecision;
  }

  async persistProvisioningIntent(
    input: CreateProvisioningIntent,
  ): ReturnType<RunnerOperationsLedgerPort["persistProvisioningIntent"]> {
    return assertExternalEffectRecord(
      (await firstValue(
        this.prisma,
        Prisma.sql`SELECT release_authority.release_runner_prepare_effect(${asJsonb(input)}) AS value`,
      )) as never,
    );
  }

  async listIntents(rolloutId: string): Promise<readonly ProvisioningIntent[]> {
    const value = await firstValue(
      this.prisma,
      Prisma.sql`SELECT release_authority.release_runner_list_intents(${rolloutId}) AS value`,
    );
    if (
      !Array.isArray(value) ||
      value.some(
        (entry) =>
          !entry ||
          typeof entry !== "object" ||
          typeof (entry as ProvisioningIntent).id !== "string" ||
          typeof (entry as ProvisioningIntent).startCommandSha256 !==
            "string" ||
          !(entry as ProvisioningIntent).effect ||
          ((entry as ProvisioningIntent).creationLeaseOwner !== null &&
            typeof (entry as ProvisioningIntent).creationLeaseOwner !==
              "string") ||
          ((entry as ProvisioningIntent).creationLeaseExpiresAt !== null &&
            typeof (entry as ProvisioningIntent).creationLeaseExpiresAt !==
              "string") ||
          ((entry as ProvisioningIntent).creationLeaseOwner === null) !==
            ((entry as ProvisioningIntent).creationLeaseExpiresAt === null),
      )
    )
      throw new Error("release_runner_intents_invalid");
    for (const entry of value)
      assertExternalEffectRecord((entry as ProvisioningIntent).effect);
    return value as ProvisioningIntent[];
  }

  async acquireProviderDispatchPermit(
    input: Parameters<
      RunnerOperationsLedgerPort["acquireProviderDispatchPermit"]
    >[0],
  ): ReturnType<RunnerOperationsLedgerPort["acquireProviderDispatchPermit"]> {
    return assertExternalEffectRecord(
      (await firstValue(
        this.prisma,
        Prisma.sql`SELECT release_authority.release_runner_acquire_dispatch_permit(${asJsonb(input)}) AS value`,
      )) as never,
    );
  }

  async abandonPreparedEffect(
    input: Parameters<RunnerOperationsLedgerPort["abandonPreparedEffect"]>[0],
  ): ReturnType<RunnerOperationsLedgerPort["abandonPreparedEffect"]> {
    return assertExternalEffectRecord(
      (await firstValue(
        this.prisma,
        Prisma.sql`SELECT release_authority.release_runner_abandon_prepared(
          ${input.intentId}, ${input.claimantId}, ${input.expectedEpoch}) AS value`,
      )) as never,
    );
  }

  async reconcileProvisioningEffect(
    input: Parameters<
      RunnerOperationsLedgerPort["reconcileProvisioningEffect"]
    >[0],
  ): ReturnType<RunnerOperationsLedgerPort["reconcileProvisioningEffect"]> {
    return assertExternalEffectRecord(
      (await firstValue(
        this.prisma,
        Prisma.sql`SELECT release_authority.release_runner_reconcile_effect(${asJsonb(input)}) AS value`,
      )) as never,
    );
  }

  async persistJob(input: PersistedJob): Promise<void> {
    requiredBoolean(
      await firstValue(
        this.prisma,
        Prisma.sql`SELECT release_authority.release_runner_persist_job(${asJsonb(input)}) AS value`,
      ),
    );
  }

  async listOpenJobs(rolloutId: string): Promise<readonly PersistedJob[]> {
    const value = await firstValue(
      this.prisma,
      Prisma.sql`SELECT release_authority.release_runner_list_open_jobs(${rolloutId}) AS value`,
    );
    if (!Array.isArray(value)) throw new Error("release_runner_jobs_invalid");
    return value as PersistedJob[];
  }

  async persistIdentity(
    jobId: string,
    identity: RunnerIdentity,
    observation: StepObservation,
  ): Promise<void> {
    requiredBoolean(
      await firstValue(
        this.prisma,
        Prisma.sql`SELECT release_authority.release_runner_persist_identity(${jobId}, ${asJsonb(identity)}, ${asJsonb(observation)}) AS value`,
      ),
    );
  }

  async currentRunner(rolloutId: string, lifecycle: "role" | "cutover") {
    const value = requiredRecord(
      await firstValue(
        this.prisma,
        Prisma.sql`SELECT release_authority.release_runner_current(${rolloutId}, ${lifecycle}) AS value`,
      ),
    );
    return value as { identity: RunnerIdentity; observation: StepObservation };
  }

  async markTerminal(
    jobId: string,
    observation: StepObservation,
  ): Promise<void> {
    requiredBoolean(
      await firstValue(
        this.prisma,
        Prisma.sql`SELECT release_authority.release_runner_mark_terminal(${jobId}, ${asJsonb(observation)}) AS value`,
      ),
    );
  }

  async cleanupObservation(jobId: string): Promise<StepObservation> {
    return requiredRecord(
      await firstValue(
        this.prisma,
        Prisma.sql`SELECT release_authority.release_runner_cleanup_observation(${jobId}) AS value`,
      ),
    ) as unknown as StepObservation;
  }

  async cleanupWitness(jobId: string): Promise<IndependentCleanupWitness> {
    return requiredRecord(
      await firstValue(
        this.prisma,
        Prisma.sql`SELECT release_authority.release_runner_cleanup_witness(${jobId}) AS value`,
      ),
    ) as IndependentCleanupWitness;
  }

  async terminalCleanupFact(
    rolloutId: string,
    lifecycle: "role" | "cutover",
  ): Promise<WitnessGatedTerminalCleanupFact> {
    return requiredRecord(
      await firstValue(
        this.prisma,
        Prisma.sql`SELECT release_authority.release_runner_terminal_cleanup_fact(${rolloutId}, ${lifecycle}) AS value`,
      ),
    ) as WitnessGatedTerminalCleanupFact;
  }

  async persistRegistration(
    input: PersistRunnerRegistrationInput,
  ): Promise<void> {
    const r = input.registration;
    const value = await firstValue(
      this.prisma,
      Prisma.sql`SELECT release_authority.release_runner_persist_registration(
      ${input.rolloutId}, ${input.lifecycle}, ${input.workflowJobId},
      ${BigInt(r.runnerId)}, ${BigInt(r.runnerGroupId)}, ${[...r.labels]},
      ${r.uniqueLabel}, ${r.workFolder}) AS value`,
    );
    if (!requiredBoolean(value))
      throw new Error("release_runner_registration_conflict");
  }

  async context(
    rolloutId: string,
  ): Promise<ReleaseRolloutReconciliationContext> {
    return requiredRecord(
      await firstValue(
        this.prisma,
        Prisma.sql`SELECT release_authority.release_rollout_reconciliation_context(${rolloutId}) AS value`,
      ),
    ) as ReleaseRolloutReconciliationContext;
  }

  async reconcile(
    input: Parameters<ReleaseRolloutReconciliationPort["reconcile"]>[0],
  ): Promise<Record<string, unknown>> {
    return requiredRecord(
      await firstValue(
        this.prisma,
        Prisma.sql`SELECT release_authority.release_rollout_reconcile(
          ${input.rolloutId}, ${asJsonb(input.targetObservation)}) AS value`,
      ),
    );
  }

  async begin(
    input: Parameters<ServiceTransitionLedger["begin"]>[0],
  ): Promise<"created" | "existing"> {
    const value = await firstValue(
      this.prisma,
      Prisma.sql`SELECT release_authority.release_service_transition_begin(${asJsonb(input)}) AS value`,
    );
    if (value !== "created" && value !== "existing")
      throw new Error("release_service_transition_begin_invalid");
    return value;
  }
  async readContract(
    rolloutId: string,
  ): Promise<Awaited<ReturnType<ServiceTransitionLedger["readContract"]>>> {
    const value = await firstValue(
      this.prisma,
      Prisma.sql`SELECT release_authority.release_service_transition_contract(${rolloutId}) AS value`,
    );
    return value === null
      ? null
      : (requiredRecord(value) as Awaited<
          ReturnType<ServiceTransitionLedger["readContract"]>
        >);
  }

  async append(
    checkpoint: Omit<ServiceTransitionCheckpoint, "sequence">,
  ): Promise<ServiceTransitionCheckpoint> {
    return requiredRecord(
      await firstValue(
        this.prisma,
        Prisma.sql`SELECT release_authority.release_service_transition_append(${asJsonb(checkpoint)}) AS value`,
      ),
    ) as unknown as ServiceTransitionCheckpoint;
  }

  async read(
    rolloutId: string,
  ): Promise<readonly ServiceTransitionCheckpoint[]> {
    const value = await firstValue(
      this.prisma,
      Prisma.sql`SELECT release_authority.release_service_transition_read(${rolloutId}) AS value`,
    );
    if (!Array.isArray(value))
      throw new Error("release_service_transition_read_invalid");
    return value as ServiceTransitionCheckpoint[];
  }

  async complete(input: {
    rolloutId: string;
    outcome: "target_staged" | "source_recovered";
  }): Promise<void> {
    requiredBoolean(
      await firstValue(
        this.prisma,
        Prisma.sql`SELECT release_authority.release_service_transition_complete(${asJsonb(input)}) AS value`,
      ),
    );
  }
}

export class RoutineRunnerCleanupWitnessAdapter implements RunnerCleanupWitnessPort {
  constructor(private readonly prisma: PrismaClient) {}

  async persistProviderWitness(
    jobId: string,
    witness: PersistedProviderCleanupWitness,
  ): Promise<void> {
    const value = await firstValue(
      this.prisma,
      Prisma.sql`SELECT release_authority.release_runner_persist_cleanup_witness(${jobId}, ${asJsonb(witness)}) AS value`,
    );
    if (!requiredBoolean(value))
      throw new Error("release_runner_provider_witness_cas_failed");
  }
}
