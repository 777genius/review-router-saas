import { Prisma } from "@prisma/client";
import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "@reviewrouter/platform-db";
import { ObserveRunnerCleanup } from "./release-witness-application.js";
import {
  PostgresCleanupObservationAdapter,
  RenderCleanupObservationAdapter,
} from "./release-witness-adapters.js";
import { registerReleaseWitnessRoutes } from "./release-witness-routes.js";

type WitnessDatabaseReadiness = Readonly<{
  roleName: string;
  postgresMajor: number;
  seedRoutine: boolean;
  persistRoutine: boolean;
  externalEffectRoutine: boolean;
}>;

export async function createReleaseWitnessApp(input: {
  readonly witnessPrisma: PrismaClient;
  readonly triggerTokenSha256: string;
  readonly renderReadToken: string;
  readonly renderFetch?: typeof fetch;
}): Promise<FastifyInstance> {
  if (!/^[a-f0-9]{64}$/u.test(input.triggerTokenSha256))
    throw new Error("release_witness_credential_hash_invalid");
  const postgres = new PostgresCleanupObservationAdapter(input.witnessPrisma);
  const observeCleanup = new ObserveRunnerCleanup(
    postgres,
    new RenderCleanupObservationAdapter(
      input.renderReadToken,
      input.renderFetch,
    ),
    postgres,
  );
  const app = Fastify({ logger: false });
  app.get("/health", async (_request, reply) => {
    try {
      const rows = await input.witnessPrisma.$queryRaw<
        WitnessDatabaseReadiness[]
      >(Prisma.sql`
        SELECT current_user AS "roleName",
          current_setting('server_version_num')::integer / 10000 AS "postgresMajor",
          to_regprocedure('release_authority.release_runner_cleanup_observation_seed(text)') IS NOT NULL AS "seedRoutine",
          to_regprocedure('release_authority.release_runner_persist_cleanup_witness(text,jsonb)') IS NOT NULL AS "persistRoutine",
          to_regprocedure('release_authority.release_runner_effect_snapshot(release_authority.runner_intent)') IS NOT NULL AS "externalEffectRoutine"
      `);
      if (
        rows.length !== 1 ||
        rows[0]?.roleName !== "reviewrouter_release_witness" ||
        rows[0].postgresMajor !== 17 ||
        !rows[0].seedRoutine ||
        !rows[0].persistRoutine ||
        !rows[0].externalEffectRoutine
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
    observeCleanup,
    triggerTokenSha256: input.triggerTokenSha256,
  });
  return app;
}
