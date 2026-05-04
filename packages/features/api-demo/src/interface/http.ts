import type { FastifyInstance, FastifyReply } from "fastify";
import type { Clock } from "@reviewrouter/shared";
import {
  getApiDemo,
  getApiDemoIndex,
  getApiDemoOpenApi,
} from "../application/get-api-demo.js";
import { renderApiDemoHtml } from "./html.js";

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
  app.options("/", async (_request, reply) => sendPublicOptions(reply));
  app.options("/ready", async (_request, reply) => sendPublicOptions(reply));
  app.options("/demo", async (_request, reply) => sendPublicOptions(reply));
  app.options("/docs", async (_request, reply) => sendPublicOptions(reply));
  app.options("/openapi.json", async (_request, reply) =>
    sendPublicOptions(reply),
  );

  app.get("/", async (_request, reply) => {
    setPublicDemoHeaders(reply);
    const input = buildDemoInput(options);
    return getApiDemoIndex(input);
  });

  app.get("/ready", async (_request, reply) => {
    setPublicDemoHeaders(reply);
    return {
      service: "review-router-api" as const,
      status: "ready" as const,
      checkedAt: options.clock.now(),
    };
  });

  app.get("/demo", async (_request, reply) => {
    setPublicDemoHeaders(reply);
    const input = buildDemoInput(options);
    return getApiDemo(input);
  });

  app.get("/openapi.json", async (_request, reply) => {
    setPublicDemoHeaders(reply);
    const input = buildDemoInput(options);
    return getApiDemoOpenApi(input);
  });

  app.get("/docs", async (_request, reply) => {
    setPublicDemoHeaders(reply);
    const input = buildDemoInput(options);
    const index = getApiDemoIndex(input);
    const demo = getApiDemo(input);
    return reply.type("text/html; charset=utf-8").send(
      renderApiDemoHtml({
        index,
        demo,
      }),
    );
  });
}

function sendPublicOptions(reply: FastifyReply): FastifyReply {
  setPublicDemoHeaders(reply);
  return reply
    .header("Access-Control-Allow-Methods", "GET, OPTIONS")
    .header("Access-Control-Allow-Headers", "accept, content-type")
    .code(204)
    .send();
}

function setPublicDemoHeaders(reply: FastifyReply): void {
  reply
    .header("Access-Control-Allow-Origin", "*")
    .header("Cache-Control", "no-store")
    .header("X-ReviewRouter-Demo", "true");
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
