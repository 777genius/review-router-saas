import type { Prisma, PrismaClient } from "@prisma/client";
import {
  parseReviewConfiguration,
  type ReviewConfiguration,
} from "../../domain/review-configuration";
import {
  reviewConfigurationTargetKey,
  type ReviewConfigurationTarget,
} from "../../domain/review-configuration-target";
import type {
  PersistedReviewConfiguration,
  ReviewConfigurationRepositoryPort,
} from "../../application/ports/review-configuration-repository-port";
import {
  isReviewConfigurationWriteConflictError,
  ReviewConfigurationWriteConflictError as WriteConflict,
} from "../../application/ports/review-configuration-repository-port";

export class PrismaReviewConfigurationRepository implements ReviewConfigurationRepositoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async findLatest(
    target: ReviewConfigurationTarget,
  ): Promise<PersistedReviewConfiguration | null> {
    return findLatestReviewConfiguration(this.prisma, target);
  }

  async saveNextVersion(input: {
    readonly target: ReviewConfigurationTarget;
    readonly config: ReviewConfiguration;
    readonly expectedVersion?: number | null;
  }): Promise<PersistedReviewConfiguration> {
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          (tx) => saveNextReviewConfigurationVersion(tx, input),
          { isolationLevel: "Serializable" },
        );
      } catch (error) {
        if (
          isReviewConfigurationWriteConflictError(error) ||
          isPrismaReviewConfigurationWriteConflict(error)
        ) {
          throw new WriteConflict();
        }
        if (
          !isPrismaReviewConfigurationSerializationConflict(error) ||
          attempt === MAX_TRANSACTION_ATTEMPTS
        ) {
          throw error;
        }
      }
    }
    throw new Error("review_configuration_transaction_retry_exhausted");
  }

  async deleteTarget(target: ReviewConfigurationTarget): Promise<boolean> {
    return deleteReviewConfigurationTarget(this.prisma, target);
  }
}

export class PrismaReviewConfigurationTransactionRepository implements ReviewConfigurationRepositoryPort {
  constructor(private readonly prisma: Prisma.TransactionClient) {}

  findLatest(target: ReviewConfigurationTarget) {
    return findLatestReviewConfiguration(this.prisma, target);
  }

  saveNextVersion(
    input: Parameters<ReviewConfigurationRepositoryPort["saveNextVersion"]>[0],
  ) {
    return saveNextReviewConfigurationVersion(this.prisma, input);
  }

  deleteTarget(target: ReviewConfigurationTarget) {
    return deleteReviewConfigurationTarget(this.prisma, target);
  }
}

export function isPrismaReviewConfigurationWriteConflict(
  error: unknown,
): boolean {
  return hasPrismaErrorCode(error, "P2002");
}

export function isPrismaReviewConfigurationSerializationConflict(
  error: unknown,
): boolean {
  return hasPrismaErrorCode(error, "P2034");
}

function hasPrismaErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

const MAX_TRANSACTION_ATTEMPTS = 3;

type ReviewConfigurationPrismaClient = Pick<
  PrismaClient | Prisma.TransactionClient,
  "reviewConfiguration" | "reviewConfigurationVersion"
>;

async function findLatestReviewConfiguration(
  prisma: ReviewConfigurationPrismaClient,
  target: ReviewConfigurationTarget,
): Promise<PersistedReviewConfiguration | null> {
  const record = await prisma.reviewConfiguration.findUnique({
    where: {
      workspaceId_targetKey: {
        workspaceId: target.workspaceId,
        targetKey: reviewConfigurationTargetKey(target),
      },
    },
    select: {
      versions: {
        orderBy: { version: "desc" },
        take: 1,
        select: versionSelect,
      },
    },
  });
  const version = record?.versions[0];
  return version ? toPersistedConfiguration(version) : null;
}

async function saveNextReviewConfigurationVersion(
  prisma: ReviewConfigurationPrismaClient,
  input: Parameters<ReviewConfigurationRepositoryPort["saveNextVersion"]>[0],
): Promise<PersistedReviewConfiguration> {
  const config = parseReviewConfiguration(input.config);
  const targetKey = reviewConfigurationTargetKey(input.target);
  const configuration = await prisma.reviewConfiguration.upsert({
    where: {
      workspaceId_targetKey: {
        workspaceId: input.target.workspaceId,
        targetKey,
      },
    },
    update: {
      repositoryId:
        input.target.scope === "repository" ? input.target.repositoryId : null,
    },
    create: {
      workspaceId: input.target.workspaceId,
      repositoryId:
        input.target.scope === "repository" ? input.target.repositoryId : null,
      targetKey,
    },
    select: { id: true },
  });

  const latest = await prisma.reviewConfigurationVersion.findFirst({
    where: { configurationId: configuration.id },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  if (
    input.expectedVersion !== undefined &&
    (latest?.version ?? null) !== input.expectedVersion
  ) {
    throw new WriteConflict();
  }
  const nextVersion = (latest?.version ?? 0) + 1;
  const saved = await prisma.reviewConfigurationVersion.create({
    data: {
      configurationId: configuration.id,
      version: nextVersion,
      schemaVersion: config.schemaVersion,
      providerKind: config.provider.kind,
      providerAuthMode: config.provider.authMode,
      model: config.provider.model,
      reasoningEffort: config.provider.reasoningEffort,
      agenticContext: config.provider.agenticContext,
      fastMode: config.provider.fastMode,
      failOnSeverity: config.blockingPolicy.failOnSeverity,
      inlineMaxComments: config.limits.inlineMaxComments,
      providerLimit: config.execution.providerLimit,
      providerMaxParallel: config.execution.providerMaxParallel,
      inlineMinAgreement: config.execution.inlineMinAgreement,
      targetTokensPerBatch: config.limits.targetTokensPerBatch,
      reviewLanguage: config.reviewLanguage ?? null,
      investigationRecordingEnabled:
        config.investigationRollout.recordingEnabled,
      investigationShadowEnabled: config.investigationRollout.shadowEnabled,
      investigationContextCriticEnabled:
        config.investigationRollout.contextCriticEnabled,
      investigationVerifiedCleanEnabled:
        config.investigationRollout.verifiedCleanEnabled,
      investigationCrossRevisionReplayEnabled:
        config.investigationRollout.crossRevisionReplayEnabled,
      investigationProductionEffectsEnabled:
        config.investigationRollout.productionEffectsEnabled,
      providers: {
        create: config.providers.map((provider, index) => ({
          order: index,
          providerKind: provider.kind,
          providerAuthMode: provider.authMode,
          model: provider.model,
          reasoningEffort: provider.reasoningEffort,
          agenticContext: provider.agenticContext,
          fastMode: provider.fastMode,
          requiredHealthy: provider.requiredHealthy,
        })),
      },
    },
    select: versionSelect,
  });

  return toPersistedConfiguration(saved);
}

async function deleteReviewConfigurationTarget(
  prisma: ReviewConfigurationPrismaClient,
  target: ReviewConfigurationTarget,
): Promise<boolean> {
  const result = await prisma.reviewConfiguration.deleteMany({
    where: {
      workspaceId: target.workspaceId,
      targetKey: reviewConfigurationTargetKey(target),
    },
  });
  return result.count > 0;
}

const versionSelect = {
  id: true,
  version: true,
  schemaVersion: true,
  providerKind: true,
  providerAuthMode: true,
  model: true,
  reasoningEffort: true,
  agenticContext: true,
  fastMode: true,
  failOnSeverity: true,
  inlineMaxComments: true,
  providerLimit: true,
  providerMaxParallel: true,
  inlineMinAgreement: true,
  targetTokensPerBatch: true,
  reviewLanguage: true,
  investigationRecordingEnabled: true,
  investigationShadowEnabled: true,
  investigationContextCriticEnabled: true,
  investigationVerifiedCleanEnabled: true,
  investigationCrossRevisionReplayEnabled: true,
  investigationProductionEffectsEnabled: true,
  providers: {
    orderBy: { order: "asc" },
    select: {
      providerKind: true,
      providerAuthMode: true,
      model: true,
      reasoningEffort: true,
      agenticContext: true,
      fastMode: true,
      requiredHealthy: true,
    },
  },
} as const;

type VersionRecord = {
  readonly id: string;
  readonly version: number;
  readonly schemaVersion: number;
  readonly providerKind: string;
  readonly providerAuthMode: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly agenticContext: boolean;
  readonly fastMode: boolean;
  readonly failOnSeverity: string;
  readonly inlineMaxComments: number;
  readonly providerLimit: number;
  readonly providerMaxParallel: number;
  readonly inlineMinAgreement: number;
  readonly targetTokensPerBatch: number;
  readonly reviewLanguage: string | null;
  readonly investigationRecordingEnabled: boolean;
  readonly investigationShadowEnabled: boolean;
  readonly investigationContextCriticEnabled: boolean;
  readonly investigationVerifiedCleanEnabled: boolean;
  readonly investigationCrossRevisionReplayEnabled: boolean;
  readonly investigationProductionEffectsEnabled: boolean;
  readonly providers: readonly {
    readonly providerKind: string;
    readonly providerAuthMode: string;
    readonly model: string;
    readonly reasoningEffort: string;
    readonly agenticContext: boolean;
    readonly fastMode: boolean;
    readonly requiredHealthy: boolean;
  }[];
};

function toPersistedConfiguration(
  version: VersionRecord,
): PersistedReviewConfiguration {
  return {
    version: version.version,
    revisionToken: `db:${version.id}`,
    config: parseReviewConfiguration({
      schemaVersion: 2,
      providers: version.providers.length
        ? version.providers.map((provider) => ({
            kind: provider.providerKind,
            authMode: provider.providerAuthMode,
            model: provider.model,
            reasoningEffort: provider.reasoningEffort,
            agenticContext: provider.agenticContext,
            fastMode: provider.fastMode,
            requiredHealthy: provider.requiredHealthy,
          }))
        : [
            {
              kind: version.providerKind,
              authMode: version.providerAuthMode,
              model: version.model,
              reasoningEffort: version.reasoningEffort,
              agenticContext: version.agenticContext,
              fastMode: version.fastMode,
              requiredHealthy: true,
            },
          ],
      provider: {
        kind: version.providerKind,
        authMode: version.providerAuthMode,
        model: version.model,
        reasoningEffort: version.reasoningEffort,
        agenticContext: version.agenticContext,
        fastMode: version.fastMode,
        requiredHealthy: true,
      },
      execution: {
        providerLimit: version.providerLimit,
        providerMaxParallel: version.providerMaxParallel,
        inlineMinAgreement: version.inlineMinAgreement,
      },
      blockingPolicy: { failOnSeverity: version.failOnSeverity },
      limits: {
        inlineMaxComments: version.inlineMaxComments,
        targetTokensPerBatch: version.targetTokensPerBatch,
      },
      reviewLanguage: version.reviewLanguage ?? undefined,
      investigationRollout: {
        recordingEnabled: version.investigationRecordingEnabled ?? false,
        shadowEnabled: version.investigationShadowEnabled ?? false,
        contextCriticEnabled:
          version.investigationContextCriticEnabled ?? false,
        verifiedCleanEnabled:
          version.investigationVerifiedCleanEnabled ?? false,
        crossRevisionReplayEnabled:
          version.investigationCrossRevisionReplayEnabled ?? false,
        productionEffectsEnabled:
          version.investigationProductionEffectsEnabled ?? false,
      },
    }),
  };
}
