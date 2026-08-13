import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "@reviewrouter/platform-db";
import { observeReleaseAuthorityDatabaseReadiness } from "./release-authority/adapters/postgres-readiness.js";
import { releaseAuthoritySchemaIsReady } from "./release-authority/application/readiness.js";
import { ObserveRunnerCleanup } from "./release-witness-application.js";
import {
  PostgresCleanupObservationAdapter,
  RenderCleanupObservationAdapter,
} from "./release-witness-adapters.js";
import { registerReleaseWitnessRoutes } from "./release-witness-routes.js";

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
      const readiness = await observeReleaseAuthorityDatabaseReadiness(
        input.witnessPrisma,
      );
      if (
        readiness.roleName !== "reviewrouter_release_witness" ||
        readiness.postgresMajor !== 17 ||
        !releaseAuthoritySchemaIsReady(readiness)
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
