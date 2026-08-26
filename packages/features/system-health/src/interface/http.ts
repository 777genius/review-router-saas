import type { FastifyInstance } from "fastify";
import type { Clock } from "@reviewrouter/shared";
import { getSystemHealth } from "../application/get-system-health.js";
import type { HealthDependencyPort } from "../application/ports/health-dependency-port.js";

export function registerSystemHealthRoutes(
  app: FastifyInstance,
  clock: Clock,
  dependencies: readonly HealthDependencyPort[] = [],
): void {
  app.get("/health", async () => ({
    service: "review-router-api" as const,
    status: "ok" as const,
    checkedAt: clock.now(),
    dependencies: [],
  }));
  app.get("/ready", async (_request, reply) => {
    const readiness = await getSystemHealth({ clock, dependencies });
    return reply.code(readiness.status === "ok" ? 200 : 503).send(readiness);
  });
}
