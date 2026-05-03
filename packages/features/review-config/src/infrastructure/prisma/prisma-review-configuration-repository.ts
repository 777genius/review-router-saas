import type { PrismaClient } from "@prisma/client";
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

export class PrismaReviewConfigurationRepository implements ReviewConfigurationRepositoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async findLatest(
    target: ReviewConfigurationTarget,
  ): Promise<PersistedReviewConfiguration | null> {
    const record = await this.prisma.reviewConfiguration.findUnique({
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
    if (!version) {
      return null;
    }

    return toPersistedConfiguration(version);
  }

  async saveNextVersion(input: {
    readonly target: ReviewConfigurationTarget;
    readonly config: ReviewConfiguration;
  }): Promise<PersistedReviewConfiguration> {
    const config = parseReviewConfiguration(input.config);
    const targetKey = reviewConfigurationTargetKey(input.target);

    return this.prisma.$transaction(async (tx) => {
      const configuration = await tx.reviewConfiguration.upsert({
        where: {
          workspaceId_targetKey: {
            workspaceId: input.target.workspaceId,
            targetKey,
          },
        },
        update: {
          repositoryId:
            input.target.scope === "repository"
              ? input.target.repositoryId
              : null,
        },
        create: {
          workspaceId: input.target.workspaceId,
          repositoryId:
            input.target.scope === "repository"
              ? input.target.repositoryId
              : null,
          targetKey,
        },
        select: { id: true },
      });

      const latest = await tx.reviewConfigurationVersion.findFirst({
        where: { configurationId: configuration.id },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      const nextVersion = (latest?.version ?? 0) + 1;
      const saved = await tx.reviewConfigurationVersion.create({
        data: {
          configurationId: configuration.id,
          version: nextVersion,
          schemaVersion: config.schemaVersion,
          providerKind: config.provider.kind,
          providerAuthMode: config.provider.authMode,
          model: config.provider.model,
          reasoningEffort: config.provider.reasoningEffort,
          agenticContext: config.provider.agenticContext,
          failOnSeverity: config.blockingPolicy.failOnSeverity,
          inlineMaxComments: config.limits.inlineMaxComments,
          targetTokensPerBatch: config.limits.targetTokensPerBatch,
        },
        select: versionSelect,
      });

      return toPersistedConfiguration(saved);
    });
  }
}

const versionSelect = {
  version: true,
  schemaVersion: true,
  providerKind: true,
  providerAuthMode: true,
  model: true,
  reasoningEffort: true,
  agenticContext: true,
  failOnSeverity: true,
  inlineMaxComments: true,
  targetTokensPerBatch: true,
} as const;

type VersionRecord = {
  readonly version: number;
  readonly schemaVersion: number;
  readonly providerKind: string;
  readonly providerAuthMode: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly agenticContext: boolean;
  readonly failOnSeverity: string;
  readonly inlineMaxComments: number;
  readonly targetTokensPerBatch: number;
};

function toPersistedConfiguration(
  version: VersionRecord,
): PersistedReviewConfiguration {
  return {
    version: version.version,
    config: parseReviewConfiguration({
      schemaVersion: version.schemaVersion,
      provider: {
        kind: version.providerKind,
        authMode: version.providerAuthMode,
        model: version.model,
        reasoningEffort: version.reasoningEffort,
        agenticContext: version.agenticContext,
      },
      blockingPolicy: { failOnSeverity: version.failOnSeverity },
      limits: {
        inlineMaxComments: version.inlineMaxComments,
        targetTokensPerBatch: version.targetTokensPerBatch,
      },
    }),
  };
}
