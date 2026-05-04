import type { FastifyInstance } from "fastify";
import type { Clock } from "@reviewrouter/shared";
import {
  getApiDemo,
  getApiDemoIndex,
  getApiDemoOpenApi,
} from "../application/get-api-demo.js";

export type RegisterApiDemoRoutesOptions = {
  readonly clock: Clock;
  readonly webUrl?: string;
  readonly apiUrl?: string;
  readonly actionVersion?: string;
  readonly model?: string;
  readonly effort?: string;
};

export function registerApiDemoRoutes(
  app: FastifyInstance,
  options: RegisterApiDemoRoutesOptions,
): void {
  app.get("/", async () => {
    const input = buildDemoInput(options);
    return getApiDemoIndex(input);
  });

  app.get("/ready", async () => ({
    service: "review-router-api" as const,
    status: "ready" as const,
    checkedAt: options.clock.now(),
  }));

  app.get("/demo", async () => {
    const input = buildDemoInput(options);
    return getApiDemo(input);
  });

  app.get("/openapi.json", async () => {
    const input = buildDemoInput(options);
    return getApiDemoOpenApi(input);
  });
}

function buildDemoInput(options: RegisterApiDemoRoutesOptions) {
  return {
    clock: options.clock,
    ...(options.webUrl ? { webUrl: options.webUrl } : {}),
    ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
    ...(options.actionVersion ? { actionVersion: options.actionVersion } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
  };
}
