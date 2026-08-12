import { Prisma } from "@prisma/client";
import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "@reviewrouter/platform-db";
import {
  registerReleaseWitnessRoutes,
  RoutineRunnerCleanupWitnessAdapter,
  RunnerCleanupWitnessService,
} from "./release-rollout-ledger.js";

export async function createReleaseWitnessApp(input: {
  readonly witnessPrisma: PrismaClient;
  readonly witnessTokenSha256: string;
}): Promise<FastifyInstance> {
  if (!/^[a-f0-9]{64}$/u.test(input.witnessTokenSha256))
    throw new Error("release_witness_credential_hash_invalid");
  const app = Fastify({ logger: false });
  app.get("/health", async (_request, reply) => {
    try {
      await input.witnessPrisma.$queryRaw(Prisma.sql`SELECT 1`);
      return { status: "ok", service: "release-witness" };
    } catch {
      return reply.code(503).send({
        status: "degraded",
        service: "release-witness",
        reason: "database_unavailable",
      });
    }
  });
  await registerReleaseWitnessRoutes(app, {
    cleanupWitness: new RunnerCleanupWitnessService(
      new RoutineRunnerCleanupWitnessAdapter(input.witnessPrisma),
    ),
    witnessTokenSha256: input.witnessTokenSha256,
  });
  return app;
}
