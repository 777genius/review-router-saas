import type { PrismaClient } from "@prisma/client";
import type { SupportDiagnosticsRepositoryPort } from "../../application/ports/support-diagnostics-repository-port";
import type { SupportDiagnosticsInput } from "../../domain/support-diagnostics";

export class PrismaSupportDiagnosticsRepository implements SupportDiagnosticsRepositoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async getWorkspaceDiagnosticsInput(
    workspaceId: string,
  ): Promise<SupportDiagnosticsInput | null> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        id: true,
        name: true,
        slug: true,
        installations: {
          select: {
            status: true,
            repositorySelection: true,
          },
        },
        repositories: {
          select: {
            id: true,
            selected: true,
            archived: true,
            setupStatus: true,
            actionHealth: {
              orderBy: { receivedAt: "desc" },
              take: 1,
              select: {
                providerSetupState: true,
                providerHealth: true,
                findingCriticalCount: true,
                findingMajorCount: true,
                findingMinorCount: true,
                findingInfoCount: true,
                inlineCommentCount: true,
                summaryCommentCount: true,
              },
            },
          },
        },
        provisioning: {
          select: { status: true },
        },
        auditEvents: {
          orderBy: { createdAt: "desc" },
          take: 10,
          select: { action: true },
        },
      },
    });
    if (!workspace) {
      return null;
    }

    const outbox = await this.prisma.outboxEvent.findMany({
      where: { workspaceId },
      orderBy: { occurredAt: "desc" },
      take: 50,
      select: {
        status: true,
        type: true,
      },
    });

    return {
      workspace: {
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
      },
      installations: workspace.installations.map((installation) => ({
        status: installation.status,
        repositorySelection: installation.repositorySelection,
      })),
      repositories: workspace.repositories.map((repository) => {
        const latestHealth = repository.actionHealth[0];
        return {
          id: repository.id,
          selected: repository.selected,
          archived: repository.archived,
          setupStatus: repository.setupStatus,
          latestProviderSetupState: latestHealth?.providerSetupState ?? null,
          latestProviderHealth: latestHealth?.providerHealth ?? null,
          latestFindingCounts: latestHealth
            ? {
                critical: latestHealth.findingCriticalCount,
                major: latestHealth.findingMajorCount,
                minor: latestHealth.findingMinorCount,
                info: latestHealth.findingInfoCount,
              }
            : null,
          latestCommentCounts: latestHealth
            ? {
                inline: latestHealth.inlineCommentCount,
                summary: latestHealth.summaryCommentCount,
              }
            : null,
        };
      }),
      workflowProvisioning: workspace.provisioning.map((item) => ({
        status: item.status,
      })),
      outbox: outbox.map((event) => ({
        status: event.status,
        type: event.type,
      })),
      recentAuditActions: workspace.auditEvents.map((event) => event.action),
    };
  }
}
