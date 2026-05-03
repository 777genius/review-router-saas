import type { FastifyInstance } from "fastify";
import type { Clock } from "@reviewrouter/shared";
import { getSystemHealth } from "../application/get-system-health.js";

export function registerSystemHealthRoutes(
  app: FastifyInstance,
  clock: Clock,
): void {
  app.get("/health", async () => getSystemHealth({ clock }));
}
