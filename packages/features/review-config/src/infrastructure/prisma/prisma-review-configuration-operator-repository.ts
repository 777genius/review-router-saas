import type { PrismaClient } from "@prisma/client";
import type {
  ReviewConfigurationOperatorRepository,
  ReviewConfigurationOperatorRepositoryPort,
} from "../../application/ports/review-configuration-operator-ports";

export class PrismaReviewConfigurationOperatorRepository implements ReviewConfigurationOperatorRepositoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async findActiveCandidates(
    input: Parameters<
      ReviewConfigurationOperatorRepositoryPort["findActiveCandidates"]
    >[0],
  ): Promise<readonly ReviewConfigurationOperatorRepository[]> {
    const records = await this.prisma.repositoryConnection.findMany({
      where: {
        provider: input.provider,
        fullName: { equals: input.repositoryFullName, mode: "insensitive" },
        selected: true,
        archived: false,
        ...(input.provider === "github"
          ? { installation: { status: "active" } }
          : { gitlabInstallation: { status: "active" } }),
        ...(input.workspace
          ? {
              workspace: {
                OR: [
                  { id: { equals: input.workspace, mode: "insensitive" } },
                  { slug: { equals: input.workspace, mode: "insensitive" } },
                ],
              },
            }
          : {}),
      },
      select: {
        id: true,
        workspaceId: true,
        provider: true,
        fullName: true,
        workspace: {
          select: {
            id: true,
            slug: true,
          },
        },
      },
      take: 2,
    });
    return records.map((record) => ({
      id: record.id,
      workspaceId: record.workspaceId,
      workspaceSlug: record.workspace.slug,
      provider: record.provider,
      fullName: record.fullName,
    }));
  }
}
