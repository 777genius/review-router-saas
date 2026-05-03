import type { PrismaClient } from "@prisma/client";
import { safeDefaultReviewConfiguration } from "@reviewrouter/features-review-config";
import type {
  ActionHealthReport,
  ActionRepositoryContext,
  ActionSessionClaims,
} from "../../domain/action-control-plane.js";
import type {
  ActionControlPlaneRepositoryPort,
  RuntimeReviewConfigurationRecord,
} from "../../application/ports/action-control-plane-repository-port.js";

export class PrismaActionControlPlaneRepository implements ActionControlPlaneRepositoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async findSelectedRepositoryByGithubId(
    githubRepositoryId: string,
  ): Promise<ActionRepositoryContext | null> {
    const repository = await this.prisma.repositoryConnection.findUnique({
      where: { githubRepositoryId: BigInt(githubRepositoryId) },
      select: {
        id: true,
        workspaceId: true,
        githubRepositoryId: true,
        fullName: true,
        owner: true,
        selected: true,
        installation: { select: { status: true } },
      },
    });

    if (!repository) {
      return null;
    }

    return {
      workspaceId: repository.workspaceId,
      repositoryId: repository.id,
      githubRepositoryId: repository.githubRepositoryId.toString(),
      fullName: repository.fullName,
      owner: repository.owner,
      selected: repository.selected,
      installationStatus: repository.installation.status,
    };
  }

  async findRuntimeReviewConfiguration(input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
  }): Promise<RuntimeReviewConfigurationRecord | null> {
    const repositoryConfig = await this.findLatestConfigVersion({
      workspaceId: input.workspaceId,
      targetKey: `repo:${input.repositoryId}`,
    });
    if (repositoryConfig) {
      return repositoryConfig;
    }

    return this.findLatestConfigVersion({
      workspaceId: input.workspaceId,
      targetKey: "workspace:default",
    });
  }

  async recordHealthReport(input: {
    readonly session: ActionSessionClaims;
    readonly report: ActionHealthReport;
    readonly receivedAt: Date;
  }): Promise<void> {
    const optionalData = {
      ...(input.report.safeErrorSummary
        ? { safeErrorSummary: input.report.safeErrorSummary }
        : {}),
      ...(input.report.startedAt
        ? { startedAt: new Date(input.report.startedAt) }
        : {}),
      ...(input.report.finishedAt
        ? { finishedAt: new Date(input.report.finishedAt) }
        : {}),
    };

    const data = {
      workspaceId: input.session.workspaceId,
      repositoryId: input.session.repositoryId,
      githubRunId: input.session.githubRunId,
      githubRunAttempt: input.session.githubRunAttempt,
      eventName: input.session.eventName,
      actionVersion: input.report.actionVersion,
      configVersion: input.report.configVersion,
      providerSetupState: input.report.providerSetupState,
      providerHealth: input.report.providerHealth,
      safeErrorCategory: input.report.safeErrorCategory,
      receivedAt: input.receivedAt,
      ...optionalData,
    };

    await this.prisma.actionRunHealthReport.upsert({
      where: {
        repositoryId_githubRunId_githubRunAttempt: {
          repositoryId: input.session.repositoryId,
          githubRunId: input.session.githubRunId,
          githubRunAttempt: input.session.githubRunAttempt,
        },
      },
      update: {
        eventName: data.eventName,
        actionVersion: data.actionVersion,
        configVersion: data.configVersion,
        providerSetupState: data.providerSetupState,
        providerHealth: data.providerHealth,
        safeErrorCategory: data.safeErrorCategory,
        safeErrorSummary: data.safeErrorSummary ?? null,
        startedAt: data.startedAt ?? null,
        finishedAt: data.finishedAt ?? null,
        receivedAt: data.receivedAt,
      },
      create: {
        workspaceId: input.session.workspaceId,
        repositoryId: input.session.repositoryId,
        githubRunId: input.session.githubRunId,
        githubRunAttempt: input.session.githubRunAttempt,
        eventName: input.session.eventName,
        actionVersion: input.report.actionVersion,
        configVersion: input.report.configVersion,
        providerSetupState: input.report.providerSetupState,
        providerHealth: input.report.providerHealth,
        safeErrorCategory: input.report.safeErrorCategory,
        receivedAt: input.receivedAt,
        ...optionalData,
      },
    });
  }

  private async findLatestConfigVersion(input: {
    readonly workspaceId: string;
    readonly targetKey: string;
  }): Promise<RuntimeReviewConfigurationRecord | null> {
    const configuration = await this.prisma.reviewConfiguration.findUnique({
      where: {
        workspaceId_targetKey: {
          workspaceId: input.workspaceId,
          targetKey: input.targetKey,
        },
      },
      select: {
        versions: {
          orderBy: { version: "desc" },
          take: 1,
          select: {
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
          },
        },
      },
    });
    const version = configuration?.versions[0];
    if (!version) {
      return null;
    }

    return {
      version: version.version,
      config: {
        schemaVersion: 1,
        provider: {
          kind: version.providerKind === "openrouter" ? "openrouter" : "codex",
          authMode: toAuthMode(version.providerAuthMode),
          model: version.model,
          reasoningEffort: toReasoningEffort(version.reasoningEffort),
          agenticContext: version.agenticContext,
        },
        blockingPolicy: {
          failOnSeverity: toFailOnSeverity(version.failOnSeverity),
        },
        limits: {
          inlineMaxComments: version.inlineMaxComments,
          targetTokensPerBatch:
            version.targetTokensPerBatch ??
            safeDefaultReviewConfiguration.limits.targetTokensPerBatch,
        },
      },
    };
  }
}

function toAuthMode(value: string) {
  switch (value) {
    case "codex_openai_api_key":
    case "openrouter_api_key":
    case "codex_subscription_oauth":
      return value;
    default:
      return "codex_subscription_oauth";
  }
}

function toReasoningEffort(value: string) {
  switch (value) {
    case "low":
    case "medium":
    case "high":
      return value;
    default:
      return "medium";
  }
}

function toFailOnSeverity(value: string) {
  switch (value) {
    case "off":
    case "critical":
    case "major":
      return value;
    default:
      return "critical";
  }
}
