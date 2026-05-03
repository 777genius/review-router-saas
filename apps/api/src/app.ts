import Fastify, { type FastifyInstance } from "fastify";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import { registerSystemHealthRoutes } from "@reviewrouter/features-system-health";
import { ConsoleLogger } from "@reviewrouter/platform-logger";
import { SystemClock } from "@reviewrouter/shared";
import { appRouter } from "./trpc.js";

export function createApiApp(): FastifyInstance {
  const logger = new ConsoleLogger();
  const app = Fastify({ logger: false });

  registerSystemHealthRoutes(app, new SystemClock());

  app.register(fastifyTRPCPlugin, {
    prefix: "/trpc",
    trpcOptions: { router: appRouter },
  });

  app.addHook("onError", async (_request, _reply, error) => {
    logger.error("API request failed", { message: error.message });
  });

  return app;
}
