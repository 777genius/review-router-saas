import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "@reviewrouter/platform-db";
import { observeReleaseAuthorityDatabaseReadiness } from "./release-authority/adapters/postgres-readiness.js";
import {
  releaseAuthoritySchemaIsReady,
  type ReleaseAuthorityDatabaseReadiness,
} from "./release-authority/application/readiness.js";
import {
  createBoundedReadinessPolicy,
  type BoundedReadinessPolicyOptions,
} from "./release-authority/application/bounded-readiness.js";
import { ObserveRunnerCleanup } from "./release-witness-application.js";
import type { ReleaseAuthorityMutationReadinessPort } from "./release-witness-domain.js";
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
  readonly readinessObserver?: (
    prisma: PrismaClient,
  ) => Promise<ReleaseAuthorityDatabaseReadiness>;
  readonly readinessPolicy?: Partial<BoundedReadinessPolicyOptions>;
  readonly mutationReadiness?: ReleaseAuthorityMutationReadinessPort;
}): Promise<FastifyInstance> {
  if (!/^[a-f0-9]{64}$/u.test(input.triggerTokenSha256))
    throw new Error("release_witness_credential_hash_invalid");
  const postgres = new PostgresCleanupObservationAdapter(input.witnessPrisma);
  const observeAuthority = async (): Promise<void> => {
    const readiness = await (
      input.readinessObserver ?? observeReleaseAuthorityDatabaseReadiness
    )(input.witnessPrisma);
    if (
      readiness.roleName !== "reviewrouter_release_witness" ||
      readiness.postgresMajor !== 17 ||
      !releaseAuthoritySchemaIsReady(readiness)
    )
      throw new Error("release_witness_authority_readiness_degraded");
  };
  const readiness = createBoundedReadinessPolicy(
    observeAuthority,
    () =>
      Object.assign(new Error("release_witness_readiness_unavailable"), {
        statusCode: 503,
      }),
    {
      deadlineMilliseconds: 5_000,
      successfulLeaseMilliseconds: 0,
      ...input.readinessPolicy,
    },
  );
  const assertAuthorityReady = () => readiness.assertReady();
  const observeCleanup = new ObserveRunnerCleanup(
    postgres,
    new RenderCleanupObservationAdapter(
      input.renderReadToken,
      input.renderFetch,
    ),
    postgres,
    input.mutationReadiness ?? { assertReady: assertAuthorityReady },
  );
  const app = Fastify({ logger: false });
  app.get("/health", async (_request, reply) => {
    try {
      await assertAuthorityReady();
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
