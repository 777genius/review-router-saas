import type { FastifyInstance } from "fastify";
import type { Clock } from "@reviewrouter/shared";
import { getSystemHealth } from "../application/get-system-health.js";
import type { HealthDependencyPort } from "../application/ports/health-dependency-port.js";

export function registerSystemHealthRoutes(
  app: FastifyInstance,
  clock: Clock,
  dependencies: readonly HealthDependencyPort[] = [],
): void {
  app.get("/health", async () => getSystemHealth({ clock, dependencies }));
}
