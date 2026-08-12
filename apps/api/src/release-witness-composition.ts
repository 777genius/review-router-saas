import { Prisma } from "@prisma/client";
import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "@reviewrouter/platform-db";
import {
  registerReleaseWitnessRoutes,
  RoutineRunnerCleanupWitnessAdapter,
  RunnerCleanupWitnessService,
} from "./release-rollout-ledger.js";

type WitnessDatabaseReadiness = Readonly<{
  roleName: string;
  postgresMajor: number;
  witnessRoutine: boolean;
}>;

export async function createReleaseWitnessApp(input: {
  readonly witnessPrisma: PrismaClient;
  readonly witnessTokenSha256: string;
}): Promise<FastifyInstance> {
  if (!/^[a-f0-9]{64}$/u.test(input.witnessTokenSha256))
    throw new Error("release_witness_credential_hash_invalid");
  const app = Fastify({ logger: false });
  app.get("/health", async (_request, reply) => {
    try {
      const rows = await input.witnessPrisma.$queryRaw<
        WitnessDatabaseReadiness[]
      >(Prisma.sql`
        SELECT current_user AS "roleName",
          current_setting('server_version_num')::integer / 10000 AS "postgresMajor",
          to_regprocedure('release_authority.release_runner_persist_cleanup_witness(text,jsonb)') IS NOT NULL AS "witnessRoutine"
      `);
      if (
        rows.length !== 1 ||
        rows[0]?.roleName !== "reviewrouter_release_witness" ||
        rows[0].postgresMajor !== 17 ||
        !rows[0].witnessRoutine
      )
        throw new Error("release_witness_database_identity_invalid");
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
