import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  ActivationFence,
  ActivationReceipt,
  RunnerIdentity,
  StepObservation,
  TargetSwitchFence,
} from "@reviewrouter/features-release-rollout";
import type { PrismaClient } from "@reviewrouter/platform-db";
import { Prisma } from "@prisma/client";

type RolloutBinding = {
  rolloutId: string;
  expectedCommitSha: string;
  runId: string;
  runAttempt: number;
  sourceSystemIdentifier: string;
  targetSystemIdentifier: string;
};
type ProvisioningIntent = {
  id: string;
  rolloutId: string;
  serviceId: string;
  lifecycle: "role" | "cutover";
  workflowJobId: string;
  runnerName: string;
  createdAt: string;
};
type PersistedJob = {
  rolloutId: string;
  serviceId: string;
  jobId: string;
  observedAt: string;
  cleanupCanary: string;
  lifecycle: "role" | "cutover";
  provisioningIntentId: string;
};
type PersistedRunnerRegistration = Readonly<{
  runnerId: number;
  runnerGroupId: number;
  labels: readonly string[];
  uniqueLabel: string;
  workFolder: string;
}>;
type PersistRunnerRegistrationInput = Readonly<{
  rolloutId: string;
  lifecycle: "role" | "cutover";
  workflowJobId: string;
  registration: PersistedRunnerRegistration;
}>;
type ProviderJobStatus = "succeeded" | "failed" | "canceled";
type PersistedProviderCleanupWitness = Readonly<{
  jobId: string;
  canary: string;
  providerStatus: ProviderJobStatus;
  containerTerminated: true;
  logSha256: string;
  removedPaths: readonly string[];
  remainingPaths: readonly [];
  providerLogId: string;
  providerObservedAt: string;
}>;
type IndependentCleanupWitness = Readonly<{
  providerStatus: ProviderJobStatus;
  listenerStopped: true;
  workspaceRemoved: true;
  credentialProcessGone: true;
  canary: string;
  observedAt: string;
  providerLogSha256: string;
  removedPaths: readonly string[];
  remainingPaths: readonly [];
}>;

export interface ReleaseAuthorityLedgerPort {
  claim(input: RolloutBinding): Promise<"claimed" | "duplicate">;
  compareAndSet(
    input: RolloutBinding & {
      step: string;
      provider?: unknown;
      expectedReceiptSha256: string;
      nextReceiptSha256: string;
      authoritativeSystemIdentifier: string;
      activationBoundary: "before" | "activated" | "uncertain";
    },
  ): Promise<boolean>;
  markActivationUncertain(input: RolloutBinding): Promise<boolean>;
  fenceTargetSwitch(
    input: RolloutBinding & {
      previousReceiptSha256: string;
      nonce: string;
      fencedAt: Date;
    },
  ): Promise<TargetSwitchFence | null>;
  fenceActivation(
    input: RolloutBinding & {
      jobId: string;
      previousReceiptSha256: string;
      targetDeployIds: readonly string[];
      nonce: string;
      fencedAt: Date;
    },
  ): Promise<ActivationFence | null>;
  finalizeActivation(input: {
    fence: ActivationFence;
    provider?: unknown;
    nextReceiptSha256: string;
    activationReceipt: ActivationReceipt;
  }): Promise<boolean>;
  activationState(
    input: Pick<
      RolloutBinding,
      "rolloutId" | "sourceSystemIdentifier" | "targetSystemIdentifier"
    >,
  ): Promise<"before" | "uncertain" | "activated">;
  verifyFinalAuthority(
    input: RolloutBinding & {
      expectedReceiptSha256: string;
      activationReceipt: ActivationReceipt;
    },
  ): Promise<boolean>;
}

export interface RunnerOperationsLedgerPort {
  persistIntent(input: ProvisioningIntent): Promise<"created" | "existing">;
  listIntents(rolloutId: string): Promise<readonly ProvisioningIntent[]>;
  recordIntentOutcome(input: {
    intentId: string;
    jobId: string;
    outcome:
      | "bound"
      | "persistence_failed_cleaned"
      | "persistence_failed_unknown";
    observation?: StepObservation;
  }): Promise<void>;
  persistJob(input: PersistedJob): Promise<void>;
  listOpenJobs(rolloutId: string): Promise<readonly PersistedJob[]>;
  persistIdentity(
    jobId: string,
    identity: RunnerIdentity,
    observation: StepObservation,
  ): Promise<void>;
  currentRunner(
    rolloutId: string,
    lifecycle: "role" | "cutover",
  ): Promise<{ identity: RunnerIdentity; observation: StepObservation }>;
  markTerminal(jobId: string, observation: StepObservation): Promise<void>;
  cleanupObservation(jobId: string): Promise<StepObservation>;
  persistProviderWitness(
    jobId: string,
    witness: PersistedProviderCleanupWitness,
  ): Promise<void>;
  cleanupWitness(jobId: string): Promise<IndependentCleanupWitness>;
  persistRegistration(input: PersistRunnerRegistrationInput): Promise<void>;
}

export interface ReleaseRolloutReconciliationPort {
  reconcile(rolloutId: string): Promise<Record<string, unknown>>;
}

const json = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

export class PrismaReleaseRolloutLedgerRepository
  implements
    ReleaseAuthorityLedgerPort,
    RunnerOperationsLedgerPort,
    ReleaseRolloutReconciliationPort
{
  constructor(private readonly prisma: PrismaClient) {}

  async claim(input: RolloutBinding): Promise<"claimed" | "duplicate"> {
    try {
      await this.prisma.releaseRolloutLedger.create({
        data: {
          ...input,
          authoritativeSystemIdentifier: input.sourceSystemIdentifier,
          activationBoundary: "before",
          lastReceiptSha256: `sha256:${"0".repeat(64)}`,
        },
      });
      return "claimed";
    } catch (error) {
      if ((error as { code?: string }).code !== "P2002") throw error;
      const existing = await this.prisma.releaseRolloutLedger.findUnique({
        where: { rolloutId: input.rolloutId },
      });
      if (
        !existing ||
        existing.expectedCommitSha !== input.expectedCommitSha ||
        existing.runId !== input.runId ||
        existing.runAttempt !== input.runAttempt ||
        existing.sourceSystemIdentifier !== input.sourceSystemIdentifier ||
        existing.targetSystemIdentifier !== input.targetSystemIdentifier
      )
        throw new Error("release_rollout_claim_identity_conflict", {
          cause: error,
        });
      return "duplicate";
    }
  }

  async compareAndSet(
    input: RolloutBinding & {
      step: string;
      provider?: unknown;
      expectedReceiptSha256: string;
      nextReceiptSha256: string;
      authoritativeSystemIdentifier: string;
      activationBoundary: "before" | "activated" | "uncertain";
    },
  ): Promise<boolean> {
    return await this.prisma.$transaction(async (transaction) => {
      const changed = await transaction.releaseRolloutLedger.updateMany({
        where: {
          rolloutId: input.rolloutId,
          expectedCommitSha: input.expectedCommitSha,
          runId: input.runId,
          runAttempt: input.runAttempt,
          sourceSystemIdentifier: input.sourceSystemIdentifier,
          targetSystemIdentifier: input.targetSystemIdentifier,
          lastReceiptSha256: input.expectedReceiptSha256,
          ...(input.step === "stage_target_services"
            ? {
                targetSwitchNonce: String(
                  (input.provider as Record<string, unknown> | undefined)
                    ?.targetSwitchFenceNonce,
                ),
                targetSwitchVersion: Number(
                  (input.provider as Record<string, unknown> | undefined)
                    ?.targetSwitchFenceVersion,
                ),
              }
            : {}),
          activationBoundary: input.activationBoundary,
          sourcePermanentlyIneligible: input.activationBoundary !== "before",
        },
        data: {
          lastReceiptSha256: input.nextReceiptSha256,
          authoritativeSystemIdentifier: input.authoritativeSystemIdentifier,
          activationBoundary: input.activationBoundary,
          sourcePermanentlyIneligible: input.activationBoundary !== "before",
        },
      });
      if (changed.count !== 1) return false;
      await transaction.releaseRolloutReceipt.create({
        data: {
          receiptSha256: input.nextReceiptSha256,
          rolloutId: input.rolloutId,
          step: input.step,
          ...(input.provider === undefined
            ? {}
            : { providerBinding: json(input.provider) }),
          previousReceiptSha256: input.expectedReceiptSha256,
          activationBoundary:
            input.activationBoundary === "activated" ? "activated" : "before",
        },
      });
      return true;
    });
  }

  async markActivationUncertain(input: RolloutBinding): Promise<boolean> {
    const result = await this.prisma.releaseRolloutLedger.updateMany({
      where: { ...input, activationBoundary: { in: ["before", "uncertain"] } },
      data: {
        activationBoundary: "uncertain",
        authoritativeSystemIdentifier: input.targetSystemIdentifier,
        sourcePermanentlyIneligible: true,
      },
    });
    return result.count === 1;
  }

  async fenceTargetSwitch(
    input: RolloutBinding & {
      previousReceiptSha256: string;
      nonce: string;
      fencedAt: Date;
    },
  ): Promise<TargetSwitchFence | null> {
    const changed = await this.prisma.releaseRolloutLedger.updateMany({
      where: {
        rolloutId: input.rolloutId,
        expectedCommitSha: input.expectedCommitSha,
        runId: input.runId,
        runAttempt: input.runAttempt,
        sourceSystemIdentifier: input.sourceSystemIdentifier,
        targetSystemIdentifier: input.targetSystemIdentifier,
        lastReceiptSha256: input.previousReceiptSha256,
        activationBoundary: "before",
        targetSwitchNonce: null,
      },
      data: {
        targetSwitchNonce: input.nonce,
        targetSwitchVersion: { increment: 1 },
        targetSwitchFencedAt: input.fencedAt,
      },
    });
    if (changed.count !== 1) return null;
    const value = await this.prisma.releaseRolloutLedger.findFirst({
      where: {
        rolloutId: input.rolloutId,
        expectedCommitSha: input.expectedCommitSha,
        runId: input.runId,
        runAttempt: input.runAttempt,
        sourceSystemIdentifier: input.sourceSystemIdentifier,
        targetSystemIdentifier: input.targetSystemIdentifier,
        lastReceiptSha256: input.previousReceiptSha256,
        activationBoundary: "before",
        targetSwitchNonce: input.nonce,
      },
    });
    if (!value?.targetSwitchNonce || !value.targetSwitchFencedAt) return null;
    return Object.freeze({
      schemaVersion: 1,
      rolloutId: value.rolloutId,
      expectedCommitSha: value.expectedCommitSha,
      runId: value.runId,
      runAttempt: value.runAttempt,
      sourceSystemIdentifier: value.sourceSystemIdentifier,
      targetSystemIdentifier: value.targetSystemIdentifier,
      previousReceiptSha256: value.lastReceiptSha256,
      nonce: value.targetSwitchNonce,
      version: value.targetSwitchVersion,
      fencedAt: value.targetSwitchFencedAt.toISOString(),
    });
  }

  async fenceActivation(
    input: RolloutBinding & {
      jobId: string;
      previousReceiptSha256: string;
      targetDeployIds: readonly string[];
      nonce: string;
      fencedAt: Date;
    },
  ): Promise<ActivationFence | null> {
    const changed = await this.prisma.releaseRolloutLedger.updateMany({
      where: {
        rolloutId: input.rolloutId,
        expectedCommitSha: input.expectedCommitSha,
        runId: input.runId,
        runAttempt: input.runAttempt,
        sourceSystemIdentifier: input.sourceSystemIdentifier,
        targetSystemIdentifier: input.targetSystemIdentifier,
        lastReceiptSha256: input.previousReceiptSha256,
        activationBoundary: "before",
        sourcePermanentlyIneligible: false,
        activationFenceNonce: null,
      },
      data: {
        activationBoundary: "uncertain",
        authoritativeSystemIdentifier: input.targetSystemIdentifier,
        sourcePermanentlyIneligible: true,
        activationFenceNonce: input.nonce,
        activationFenceVersion: { increment: 1 },
        activationJobId: input.jobId,
        activationTargetDeployIds: json(input.targetDeployIds),
        activationFencedAt: input.fencedAt,
      },
    });
    if (changed.count !== 1) return null;
    const value = await this.prisma.releaseRolloutLedger.findUniqueOrThrow({
      where: { rolloutId: input.rolloutId },
    });
    return Object.freeze({
      schemaVersion: 1,
      rolloutId: value.rolloutId,
      expectedCommitSha: value.expectedCommitSha,
      runId: value.runId,
      jobId: value.activationJobId!,
      runAttempt: value.runAttempt,
      sourceSystemIdentifier: value.sourceSystemIdentifier,
      targetSystemIdentifier: value.targetSystemIdentifier,
      previousReceiptSha256: value.lastReceiptSha256,
      nonce: value.activationFenceNonce!,
      version: value.activationFenceVersion,
      claimVersion: value.claimVersion,
      targetDeployIds: value.activationTargetDeployIds as string[],
      fencedAt: value.activationFencedAt!.toISOString(),
    });
  }

  async finalizeActivation(input: {
    fence: ActivationFence;
    provider?: unknown;
    nextReceiptSha256: string;
    activationReceipt: ActivationReceipt;
  }): Promise<boolean> {
    if (
      input.activationReceipt.fenceNonce !== input.fence.nonce ||
      input.activationReceipt.fenceVersion !== input.fence.version ||
      input.activationReceipt.previousReceiptSha256 !==
        input.fence.previousReceiptSha256
    )
      return false;
    return await this.prisma.$transaction(async (transaction) => {
      const changed = await transaction.releaseRolloutLedger.updateMany({
        where: {
          rolloutId: input.fence.rolloutId,
          expectedCommitSha: input.fence.expectedCommitSha,
          runId: input.fence.runId,
          runAttempt: input.fence.runAttempt,
          sourceSystemIdentifier: input.fence.sourceSystemIdentifier,
          targetSystemIdentifier: input.fence.targetSystemIdentifier,
          lastReceiptSha256: input.fence.previousReceiptSha256,
          activationBoundary: "uncertain",
          sourcePermanentlyIneligible: true,
          activationFenceNonce: input.fence.nonce,
          activationFenceVersion: input.fence.version,
          activationJobId: input.fence.jobId,
        },
        data: {
          activationBoundary: "activated",
          lastReceiptSha256: input.nextReceiptSha256,
          activationReceipt: json(input.activationReceipt),
        },
      });
      if (changed.count !== 1) return false;
      await transaction.releaseRolloutReceipt.create({
        data: {
          receiptSha256: input.nextReceiptSha256,
          rolloutId: input.fence.rolloutId,
          step: "activate_target_generation",
          ...(input.provider === undefined
            ? {}
            : { providerBinding: json(input.provider) }),
          previousReceiptSha256: input.fence.previousReceiptSha256,
          activationBoundary: "activated",
        },
      });
      return true;
    });
  }

  async activationState(
    input: Pick<
      RolloutBinding,
      "rolloutId" | "sourceSystemIdentifier" | "targetSystemIdentifier"
    >,
  ) {
    const value = await this.prisma.releaseRolloutLedger.findFirstOrThrow({
      where: input,
      select: { activationBoundary: true },
    });
    if (
      !["before", "uncertain", "activated"].includes(value.activationBoundary)
    )
      throw new Error("release_rollout_activation_state_invalid");
    return value.activationBoundary as "before" | "uncertain" | "activated";
  }

  async verifyFinalAuthority(
    input: RolloutBinding & {
      expectedReceiptSha256: string;
      activationReceipt: ActivationReceipt;
    },
  ): Promise<boolean> {
    const value = await this.prisma.releaseRolloutLedger.findFirst({
      where: {
        rolloutId: input.rolloutId,
        expectedCommitSha: input.expectedCommitSha,
        runId: input.runId,
        runAttempt: input.runAttempt,
        sourceSystemIdentifier: input.sourceSystemIdentifier,
        targetSystemIdentifier: input.targetSystemIdentifier,
        activationBoundary: "activated",
        sourcePermanentlyIneligible: true,
        authoritativeSystemIdentifier: input.targetSystemIdentifier,
        lastReceiptSha256: input.expectedReceiptSha256,
      },
      select: { activationReceipt: true },
    });
    return (
      value !== null &&
      JSON.stringify(value.activationReceipt) ===
        JSON.stringify(input.activationReceipt)
    );
  }

  async persistIntent(
    input: ProvisioningIntent,
  ): Promise<"created" | "existing"> {
    try {
      await this.prisma.releaseRunnerProvisioningIntent.create({
        data: {
          ...input,
          intentId: input.id,
          createdAt: new Date(input.createdAt),
        },
      });
      return "created";
    } catch (error) {
      if ((error as { code?: string }).code !== "P2002") throw error;
      const existing =
        await this.prisma.releaseRunnerProvisioningIntent.findUnique({
          where: { intentId: input.id },
        });
      if (
        !existing ||
        existing.rolloutId !== input.rolloutId ||
        existing.serviceId !== input.serviceId ||
        existing.lifecycle !== input.lifecycle ||
        existing.workflowJobId !== input.workflowJobId ||
        existing.runnerName !== input.runnerName
      )
        throw new Error("release_runner_intent_identity_conflict", {
          cause: error,
        });
      return "existing";
    }
  }

  async listIntents(rolloutId: string): Promise<readonly ProvisioningIntent[]> {
    const values = await this.prisma.releaseRunnerProvisioningIntent.findMany({
      where: { rolloutId },
      orderBy: { createdAt: "asc" },
    });
    return values.map((value) => ({
      id: value.intentId,
      rolloutId: value.rolloutId,
      serviceId: value.serviceId,
      lifecycle: value.lifecycle as "role" | "cutover",
      workflowJobId: value.workflowJobId,
      runnerName: value.runnerName,
      createdAt: value.createdAt.toISOString(),
    }));
  }

  async recordIntentOutcome(input: {
    intentId: string;
    jobId: string;
    outcome:
      | "bound"
      | "persistence_failed_cleaned"
      | "persistence_failed_unknown";
    observation?: StepObservation;
  }): Promise<void> {
    const changed =
      await this.prisma.releaseRunnerProvisioningIntent.updateMany({
        where: {
          intentId: input.intentId,
          OR: [{ providerJobId: null }, { providerJobId: input.jobId }],
        },
        data: {
          providerJobId: input.jobId,
          outcome: input.outcome,
          ...(input.observation === undefined
            ? {}
            : { reconciliationObservation: json(input.observation) }),
          reconciledAt: new Date(),
        },
      });
    if (changed.count !== 1)
      throw new Error("release_runner_intent_outcome_cas_failed");
  }

  async persistJob(input: PersistedJob): Promise<void> {
    await this.prisma.releaseRunnerJob.create({
      data: { ...input, observedAt: new Date(input.observedAt) },
    });
  }

  async listOpenJobs(rolloutId: string): Promise<readonly PersistedJob[]> {
    const values = await this.prisma.releaseRunnerJob.findMany({
      where: { rolloutId, terminalAt: null },
      orderBy: { observedAt: "asc" },
    });
    return values.map((value) => ({
      rolloutId: value.rolloutId,
      serviceId: value.serviceId,
      jobId: value.jobId,
      observedAt: value.observedAt.toISOString(),
      cleanupCanary: value.cleanupCanary,
      lifecycle: value.lifecycle as "role" | "cutover",
      provisioningIntentId: value.provisioningIntentId,
    }));
  }

  async persistIdentity(
    jobId: string,
    identity: RunnerIdentity,
    observation: StepObservation,
  ): Promise<void> {
    const changed = await this.prisma.releaseRunnerJob.updateMany({
      where: { jobId, runnerIdentity: { equals: Prisma.DbNull } },
      data: {
        runnerIdentity: json(identity),
        provisionObservation: json(observation),
      },
    });
    if (changed.count !== 1)
      throw new Error("release_runner_identity_cas_failed");
  }

  async currentRunner(rolloutId: string, lifecycle: "role" | "cutover") {
    const value = await this.prisma.releaseRunnerJob.findFirstOrThrow({
      where: { rolloutId, lifecycle },
    });
    if (!value.runnerIdentity || !value.provisionObservation)
      throw new Error("release_runner_identity_missing");
    return {
      identity: value.runnerIdentity as unknown as RunnerIdentity,
      observation: value.provisionObservation as unknown as StepObservation,
    };
  }

  async markTerminal(
    jobId: string,
    observation: StepObservation,
  ): Promise<void> {
    const changed = await this.prisma.releaseRunnerJob.updateMany({
      where: { jobId, terminalAt: null },
      data: { terminalAt: new Date(), cleanupObservation: json(observation) },
    });
    if (changed.count !== 1)
      throw new Error("release_runner_terminal_cas_failed");
  }

  async cleanupObservation(jobId: string): Promise<StepObservation> {
    const value = await this.prisma.releaseRunnerJob.findUniqueOrThrow({
      where: { jobId },
      select: { cleanupObservation: true },
    });
    if (!value.cleanupObservation)
      throw new Error("release_runner_cleanup_observation_missing");
    return value.cleanupObservation as unknown as StepObservation;
  }

  async persistProviderWitness(
    jobId: string,
    witness: PersistedProviderCleanupWitness,
  ): Promise<void> {
    if (
      witness.jobId !== jobId ||
      !["succeeded", "failed", "canceled"].includes(witness.providerStatus) ||
      witness.containerTerminated !== true ||
      !/^sha256:[a-f0-9]{64}$/u.test(String(witness.logSha256)) ||
      typeof witness.providerLogId !== "string" ||
      !witness.providerLogId ||
      typeof witness.providerObservedAt !== "string" ||
      !Number.isFinite(Date.parse(witness.providerObservedAt)) ||
      !Array.isArray(witness.removedPaths) ||
      witness.removedPaths.length === 0 ||
      witness.removedPaths.some(
        (path) =>
          typeof path !== "string" || !path.startsWith("/runner/_work/"),
      ) ||
      !Array.isArray(witness.remainingPaths) ||
      witness.remainingPaths.length !== 0
    )
      throw new Error("release_runner_provider_witness_invalid");
    const changed = await this.prisma.releaseRunnerJob.updateMany({
      where: { jobId, cleanupProviderWitness: { equals: Prisma.DbNull } },
      data: { cleanupProviderWitness: json(witness) },
    });
    if (changed.count !== 1)
      throw new Error("release_runner_provider_witness_cas_failed");
  }

  async cleanupWitness(jobId: string): Promise<IndependentCleanupWitness> {
    const value = await this.prisma.releaseRunnerJob.findUniqueOrThrow({
      where: { jobId },
    });
    const provider = value.cleanupProviderWitness as Record<
      string,
      unknown
    > | null;
    if (
      !provider ||
      provider.jobId !== jobId ||
      provider.canary !== value.cleanupCanary ||
      !["succeeded", "failed", "canceled"].includes(
        String(provider.providerStatus),
      ) ||
      provider.containerTerminated !== true ||
      !/^sha256:[a-f0-9]{64}$/u.test(String(provider.logSha256)) ||
      !Array.isArray(provider.removedPaths) ||
      !Array.isArray(provider.remainingPaths) ||
      provider.remainingPaths.length !== 0
    )
      throw new Error("release_runner_independent_cleanup_witness_unproven");
    return {
      providerStatus: provider.providerStatus as ProviderJobStatus,
      listenerStopped: true,
      workspaceRemoved: true,
      credentialProcessGone: true,
      canary: value.cleanupCanary,
      observedAt: String(provider.providerObservedAt),
      providerLogSha256: String(provider.logSha256),
      removedPaths: provider.removedPaths,
      remainingPaths: [],
    };
  }

  async persistRegistration(
    input: PersistRunnerRegistrationInput,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const intent =
        await transaction.releaseRunnerProvisioningIntent.findFirstOrThrow({
          where: {
            rolloutId: input.rolloutId,
            lifecycle: input.lifecycle,
            workflowJobId: input.workflowJobId,
          },
        });
      const existingRegistration =
        intent.registrationRunnerId === null
          ? undefined
          : {
              runnerId: Number(intent.registrationRunnerId),
              runnerGroupId: Number(intent.registrationRunnerGroupId),
              labels: intent.registrationLabels,
              uniqueLabel: intent.registrationUniqueLabel,
              workFolder: intent.registrationWorkFolder,
            };
      if (
        existingRegistration &&
        JSON.stringify(existingRegistration) !==
          JSON.stringify(input.registration)
      )
        throw new Error("release_runner_registration_conflict");
      await transaction.releaseRunnerProvisioningIntent.update({
        where: { intentId: intent.intentId },
        data: {
          registrationRunnerId: BigInt(input.registration.runnerId),
          registrationRunnerGroupId: BigInt(input.registration.runnerGroupId),
          registrationLabels: [...input.registration.labels],
          registrationUniqueLabel: input.registration.uniqueLabel,
          registrationWorkFolder: input.registration.workFolder,
        },
      });
      const job = await transaction.releaseRunnerJob.findFirstOrThrow({
        where: {
          rolloutId: input.rolloutId,
          lifecycle: input.lifecycle,
          provisioningIntentId: intent.intentId,
        },
      });
      const identity = job.runnerIdentity as Record<string, unknown> | null;
      const observation = job.provisionObservation as Record<
        string,
        unknown
      > | null;
      if (!identity || !observation)
        throw new Error("release_runner_registration_identity_missing");
      const registeredIdentity = {
        ...identity,
        githubRunnerId: input.registration.runnerId,
        githubRunnerLabels: input.registration.labels,
      };
      const registeredObservation = {
        ...observation,
        facts: registeredIdentity,
      };
      await transaction.releaseRunnerJob.update({
        where: { jobId: job.jobId },
        data: {
          runnerIdentity: json(registeredIdentity),
          provisionObservation: json(registeredObservation),
        },
      });
    });
  }

  async reconcile(rolloutId: string): Promise<Record<string, unknown>> {
    return await this.prisma.$transaction(async (transaction) => {
      const rollout = await transaction.releaseRolloutLedger.findUniqueOrThrow({
        where: { rolloutId },
      });
      const openRunnerJobs = await transaction.releaseRunnerJob.count({
        where: { rolloutId, terminalAt: null },
      });
      if (openRunnerJobs !== 0)
        throw new Error("release_rollout_reconciliation_open_jobs");
      if (rollout.activationBoundary === "before") {
        const compensated = await transaction.releaseRolloutReceipt.findFirst({
          where: { rolloutId, step: "complete_compensation" },
        });
        if (!compensated)
          throw new Error("release_rollout_compensation_receipt_missing");
        return {
          state: "pre_activation_compensated",
          sourceEligible: true,
          sourceAclRestored: true,
          sourceServicesResumed: true,
          openRunnerJobs: 0,
        };
      }
      return {
        state:
          rollout.activationBoundary === "activated"
            ? "activated_forward_only"
            : "activation_uncertain_forward_only",
        sourceEligible: false,
        sourceAclRestored: false,
        sourceServicesResumed: false,
        openRunnerJobs: 0,
      };
    });
  }
}

export class ReleaseAuthorityService {
  constructor(private readonly repository: ReleaseAuthorityLedgerPort) {}
  claim = (input: RolloutBinding) => this.repository.claim(input);
  cas = (input: Parameters<ReleaseAuthorityLedgerPort["compareAndSet"]>[0]) =>
    this.repository.compareAndSet(input);
  markUncertain = (input: RolloutBinding) =>
    this.repository.markActivationUncertain(input);
  fenceTargetSwitch = (
    input: RolloutBinding & { previousReceiptSha256: string },
  ) =>
    this.repository.fenceTargetSwitch({
      ...input,
      nonce: randomBytes(16).toString("hex"),
      fencedAt: new Date(),
    });
  fence = (
    input: RolloutBinding & {
      jobId: string;
      previousReceiptSha256: string;
      targetDeployIds: readonly string[];
    },
  ) =>
    this.repository.fenceActivation({
      ...input,
      nonce: randomBytes(16).toString("hex"),
      fencedAt: new Date(),
    });
  finalize = (
    input: Parameters<ReleaseAuthorityLedgerPort["finalizeActivation"]>[0],
  ) => this.repository.finalizeActivation(input);
  state = (
    input: Parameters<ReleaseAuthorityLedgerPort["activationState"]>[0],
  ) => this.repository.activationState(input);
  verifyFinalAuthority = (
    input: Parameters<ReleaseAuthorityLedgerPort["verifyFinalAuthority"]>[0],
  ) => this.repository.verifyFinalAuthority(input);
}

export class RunnerOperationsService {
  constructor(private readonly repository: RunnerOperationsLedgerPort) {}
  persistIntent = (input: ProvisioningIntent) =>
    this.repository.persistIntent(input);
  listIntents = (rolloutId: string) => this.repository.listIntents(rolloutId);
  recordIntentOutcome = (
    input: Parameters<RunnerOperationsLedgerPort["recordIntentOutcome"]>[0],
  ) => this.repository.recordIntentOutcome(input);
  persistJob = (input: PersistedJob) => this.repository.persistJob(input);
  listOpenJobs = (rolloutId: string) => this.repository.listOpenJobs(rolloutId);
  persistIdentity = (
    jobId: string,
    identity: RunnerIdentity,
    observation: StepObservation,
  ) => this.repository.persistIdentity(jobId, identity, observation);
  currentRunner = (rolloutId: string, lifecycle: "role" | "cutover") =>
    this.repository.currentRunner(rolloutId, lifecycle);
  markTerminal = (jobId: string, observation: StepObservation) =>
    this.repository.markTerminal(jobId, observation);
  cleanupObservation = (jobId: string) =>
    this.repository.cleanupObservation(jobId);
  persistProviderWitness = (
    jobId: string,
    witness: PersistedProviderCleanupWitness,
  ) => this.repository.persistProviderWitness(jobId, witness);
  cleanupWitness = (jobId: string) => this.repository.cleanupWitness(jobId);
  persistRegistration = (
    input: Parameters<RunnerOperationsLedgerPort["persistRegistration"]>[0],
  ) => this.repository.persistRegistration(input);
}

export class ReleaseRolloutReconciliationService {
  constructor(private readonly repository: ReleaseRolloutReconciliationPort) {}
  reconcile = (rolloutId: string) => this.repository.reconcile(rolloutId);
}

export type ReleaseRolloutLedgerRouteDependencies = {
  authority: ReleaseAuthorityService;
  runnerOperations: RunnerOperationsService;
  reconciliation: ReleaseRolloutReconciliationService;
  controlTokenSha256: string;
  witnessTokenSha256: string;
};

function authorize(request: FastifyRequest, expected: string): void {
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const actual = createHash("sha256").update(token).digest();
  const expectedBuffer = Buffer.from(expected, "hex");
  if (
    expectedBuffer.length !== actual.length ||
    !timingSafeEqual(actual, expectedBuffer)
  )
    throw Object.assign(new Error("release_rollout_ledger_unauthorized"), {
      statusCode: 401,
    });
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Object.assign(new Error("release_rollout_ledger_request_invalid"), {
      statusCode: 400,
    });
  return value as Record<string, unknown>;
};
const invalidRegistrationRequest = (): never => {
  throw Object.assign(
    new Error("release_runner_registration_request_invalid"),
    {
      statusCode: 400,
    },
  );
};
const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  return JSON.stringify(actual) === JSON.stringify([...expected].sort());
};
const nonemptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;
const registrationRequest = (
  value: unknown,
): PersistRunnerRegistrationInput => {
  const body = record(value);
  if (
    !exactKeys(body, [
      "rolloutId",
      "lifecycle",
      "workflowJobId",
      "registration",
    ]) ||
    !nonemptyString(body.rolloutId) ||
    (body.lifecycle !== "role" && body.lifecycle !== "cutover") ||
    !nonemptyString(body.workflowJobId)
  )
    return invalidRegistrationRequest();
  const registration = record(body.registration);
  if (
    !exactKeys(registration, [
      "runnerId",
      "runnerGroupId",
      "labels",
      "uniqueLabel",
      "workFolder",
    ]) ||
    !Number.isSafeInteger(registration.runnerId) ||
    Number(registration.runnerId) <= 0 ||
    !Number.isSafeInteger(registration.runnerGroupId) ||
    Number(registration.runnerGroupId) <= 0 ||
    !Array.isArray(registration.labels) ||
    registration.labels.length === 0 ||
    registration.labels.length > 32 ||
    registration.labels.some(
      (label) =>
        typeof label !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(label),
    ) ||
    typeof registration.uniqueLabel !== "string" ||
    !/^rr-[A-Za-z0-9][A-Za-z0-9._-]{1,125}$/u.test(registration.uniqueLabel) ||
    !registration.labels.includes(registration.uniqueLabel) ||
    typeof registration.workFolder !== "string" ||
    !/^_work\/rr-[A-Za-z0-9][A-Za-z0-9._-]{1,125}$/u.test(
      registration.workFolder,
    )
  )
    return invalidRegistrationRequest();
  return {
    rolloutId: body.rolloutId,
    lifecycle: body.lifecycle,
    workflowJobId: body.workflowJobId,
    registration: {
      runnerId: Number(registration.runnerId),
      runnerGroupId: Number(registration.runnerGroupId),
      labels: Object.freeze([...registration.labels] as string[]),
      uniqueLabel: registration.uniqueLabel,
      workFolder: registration.workFolder,
    },
  };
};
const providerWitnessRequest = (
  value: unknown,
): PersistedProviderCleanupWitness => {
  const body = record(value);
  if (
    !exactKeys(body, [
      "jobId",
      "canary",
      "providerStatus",
      "containerTerminated",
      "logSha256",
      "removedPaths",
      "remainingPaths",
      "providerLogId",
      "providerObservedAt",
    ]) ||
    !nonemptyString(body.jobId) ||
    !nonemptyString(body.canary) ||
    !["succeeded", "failed", "canceled"].includes(
      String(body.providerStatus),
    ) ||
    body.containerTerminated !== true ||
    !/^sha256:[a-f0-9]{64}$/u.test(String(body.logSha256)) ||
    !Array.isArray(body.removedPaths) ||
    body.removedPaths.length === 0 ||
    body.removedPaths.some(
      (path) => typeof path !== "string" || !path.startsWith("/runner/_work/"),
    ) ||
    !Array.isArray(body.remainingPaths) ||
    body.remainingPaths.length !== 0 ||
    !nonemptyString(body.providerLogId) ||
    typeof body.providerObservedAt !== "string" ||
    !Number.isFinite(Date.parse(body.providerObservedAt))
  )
    throw Object.assign(
      new Error("release_runner_provider_witness_request_invalid"),
      { statusCode: 400 },
    );
  return body as PersistedProviderCleanupWitness;
};

export async function registerReleaseRolloutLedgerRoutes(
  app: FastifyInstance,
  dependencies: ReleaseRolloutLedgerRouteDependencies,
): Promise<void> {
  const control = async (request: FastifyRequest) =>
    authorize(request, dependencies.controlTokenSha256);
  const witness = async (request: FastifyRequest) =>
    authorize(request, dependencies.witnessTokenSha256);
  app.post("/v1/rollouts/claim", { preHandler: control }, async (request) => ({
    result: await dependencies.authority.claim(
      record(request.body) as RolloutBinding,
    ),
  }));
  app.post<{ Params: { rolloutId: string } }>(
    "/v1/rollouts/:rolloutId/cas",
    { preHandler: control },
    async (request) => ({
      changed: await dependencies.authority.cas({
        ...record(request.body),
        rolloutId: request.params.rolloutId,
      } as never),
    }),
  );
  app.put<{ Params: { rolloutId: string } }>(
    "/v1/rollouts/:rolloutId/activation-uncertain",
    { preHandler: control },
    async (request) => ({
      marked: await dependencies.authority.markUncertain({
        ...record(request.body),
        rolloutId: request.params.rolloutId,
      } as RolloutBinding),
    }),
  );
  app.post<{ Params: { rolloutId: string } }>(
    "/v1/rollouts/:rolloutId/target-switch-fence",
    { preHandler: control },
    async (request) => {
      const fence = await dependencies.authority.fenceTargetSwitch({
        ...record(request.body),
        rolloutId: request.params.rolloutId,
      } as never);
      return fence ? { changed: true, fence } : { changed: false };
    },
  );
  app.post<{ Params: { rolloutId: string } }>(
    "/v1/rollouts/:rolloutId/activation-fence",
    { preHandler: control },
    async (request) => {
      const fence = await dependencies.authority.fence({
        ...record(request.body),
        rolloutId: request.params.rolloutId,
      } as never);
      return { changed: fence !== null, ...(fence ? { fence } : {}) };
    },
  );
  app.post<{ Params: { rolloutId: string } }>(
    "/v1/rollouts/:rolloutId/activation-finalize",
    { preHandler: control },
    async (request) => ({
      changed: await dependencies.authority.finalize(
        record(request.body) as never,
      ),
    }),
  );
  app.get<{
    Params: { rolloutId: string };
    Querystring: {
      source_system_identifier: string;
      target_system_identifier: string;
    };
  }>(
    "/v1/rollouts/:rolloutId/activation-state",
    { preHandler: control },
    async (request) => ({
      state: await dependencies.authority.state({
        rolloutId: request.params.rolloutId,
        sourceSystemIdentifier: request.query.source_system_identifier,
        targetSystemIdentifier: request.query.target_system_identifier,
      }),
    }),
  );
  app.post<{ Params: { rolloutId: string } }>(
    "/v1/rollouts/:rolloutId/verify-final-authority",
    { preHandler: control },
    async (request) => ({
      verified: await dependencies.authority.verifyFinalAuthority({
        ...record(request.body),
        rolloutId: request.params.rolloutId,
      } as never),
    }),
  );
  app.post(
    "/v1/runner-jobs/intents",
    { preHandler: control },
    async (request) => ({
      result: await dependencies.runnerOperations.persistIntent(
        record(request.body) as ProvisioningIntent,
      ),
    }),
  );
  app.get<{ Querystring: { rollout_id: string } }>(
    "/v1/runner-jobs/intents",
    { preHandler: control },
    async (request) =>
      dependencies.runnerOperations.listIntents(request.query.rollout_id),
  );
  app.put<{ Params: { intentId: string } }>(
    "/v1/runner-jobs/intents/:intentId/outcome",
    { preHandler: control },
    async (request, reply) => {
      await dependencies.runnerOperations.recordIntentOutcome({
        ...record(request.body),
        intentId: request.params.intentId,
      } as never);
      return reply.code(204).send();
    },
  );
  app.post(
    "/v1/runner-jobs",
    { preHandler: control },
    async (request, reply) => {
      await dependencies.runnerOperations.persistJob(
        record(request.body) as PersistedJob,
      );
      return reply.code(204).send();
    },
  );
  app.get<{
    Querystring: {
      rollout_id: string;
      state?: string;
      lifecycle?: "role" | "cutover";
    };
  }>("/v1/runner-jobs", { preHandler: control }, async (request) =>
    request.query.lifecycle
      ? dependencies.runnerOperations.currentRunner(
          request.query.rollout_id,
          request.query.lifecycle,
        )
      : dependencies.runnerOperations.listOpenJobs(request.query.rollout_id),
  );
  app.get<{
    Querystring: { rollout_id: string; lifecycle: "role" | "cutover" };
  }>("/v1/runner-jobs/current", { preHandler: control }, async (request) =>
    dependencies.runnerOperations.currentRunner(
      request.query.rollout_id,
      request.query.lifecycle,
    ),
  );
  app.put<{ Params: { jobId: string } }>(
    "/v1/runner-jobs/:jobId/identity",
    { preHandler: control },
    async (request, reply) => {
      const body = record(request.body);
      await dependencies.runnerOperations.persistIdentity(
        request.params.jobId,
        body.identity as RunnerIdentity,
        body.observation as StepObservation,
      );
      return reply.code(204).send();
    },
  );
  app.put<{ Params: { jobId: string } }>(
    "/v1/runner-jobs/:jobId/terminal",
    { preHandler: control },
    async (request, reply) => {
      await dependencies.runnerOperations.markTerminal(
        request.params.jobId,
        record(request.body).observation as StepObservation,
      );
      return reply.code(204).send();
    },
  );
  app.get<{ Params: { jobId: string } }>(
    "/v1/runner-jobs/:jobId/cleanup-observation",
    { preHandler: control },
    async (request) =>
      dependencies.runnerOperations.cleanupObservation(request.params.jobId),
  );
  app.get<{ Params: { jobId: string } }>(
    "/v1/runner-jobs/:jobId/cleanup-witness",
    { preHandler: control },
    async (request) =>
      dependencies.runnerOperations.cleanupWitness(request.params.jobId),
  );
  app.put<{ Params: { jobId: string } }>(
    "/v1/runner-jobs/:jobId/provider-witness",
    { preHandler: witness },
    async (request, reply) => {
      await dependencies.runnerOperations.persistProviderWitness(
        request.params.jobId,
        providerWitnessRequest(request.body),
      );
      return reply.code(204).send();
    },
  );
  app.post(
    "/v1/runner-jobs/registration",
    { preHandler: control },
    async (request, reply) => {
      await dependencies.runnerOperations.persistRegistration(
        registrationRequest(request.body),
      );
      return reply.code(204).send();
    },
  );
  app.post<{ Params: { rolloutId: string } }>(
    "/v1/rollouts/:rolloutId/reconcile",
    { preHandler: control },
    async (request) =>
      dependencies.reconciliation.reconcile(request.params.rolloutId),
  );
}
