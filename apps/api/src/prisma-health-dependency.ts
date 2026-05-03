import type { HealthDependencyPort } from "@reviewrouter/features-system-health";
import type { PrismaClient } from "@reviewrouter/platform-db";

export class PrismaHealthDependency implements HealthDependencyPort {
  constructor(private readonly prisma: PrismaClient) {}

  async check() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { name: "database", status: "ok" as const };
    } catch {
      return { name: "database", status: "degraded" as const };
    }
  }
}
