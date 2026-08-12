import { Prisma } from "@prisma/client";
import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "@reviewrouter/platform-db";
import {
  registerReleaseControlRoutes,
  ProviderAuthorityDecisionService,
  ReleaseAuthorityService,
  ReleaseRolloutReconciliationService,
  RoutineReleaseControlLedgerAdapter,
  RunnerOperationsService,
  type ActivationPermitInstallerPort,
  type ReleaseControlRouteDependencies,
} from "./release-rollout-ledger.js";

export type ReleaseControlCredentials = Readonly<{
  controlTokenSha256: string;
  providerAuthorityTokenSha256: string;
}>;

const credentialSha256 = /^[a-f0-9]{64}$/u;

export function composeReleaseControlDependencies(
  controlPrisma: PrismaClient,
  providerAuthorityPrisma: PrismaClient,
  credentials: ReleaseControlCredentials,
  permitInstallerPrisma?: PrismaClient,
): ReleaseControlRouteDependencies {
  if (
    !credentialSha256.test(credentials.controlTokenSha256) ||
    !credentialSha256.test(credentials.providerAuthorityTokenSha256) ||
    credentials.controlTokenSha256 === credentials.providerAuthorityTokenSha256
  )
    throw new Error("release_control_credential_hash_invalid");
  const adapter = new RoutineReleaseControlLedgerAdapter(controlPrisma);
  const providerAuthorityAdapter = new RoutineReleaseControlLedgerAdapter(
    providerAuthorityPrisma,
  );
  const permitInstaller: ActivationPermitInstallerPort | undefined =
    permitInstallerPrisma
      ? {
          install: async (authorization) => {
            const rows = await permitInstallerPrisma.$queryRaw<
              { result: boolean }[]
            >(Prisma.sql`
            SELECT reviewrouter_activation.install_activation_permit(
              ${authorization.rolloutId},
              ${authorization.sourceSystemIdentifier},
              ${authorization.targetSystemIdentifier},
              ${authorization.postgresMajor},
              ${authorization.expectedCommitSha},
              ${authorization.migrationChecksum},
              ${JSON.stringify(authorization.targetDeployIds)}::jsonb,
              ${authorization.epoch},
              ${authorization.nonce}
            ) AS result
          `);
            if (
              rows.length !== 1 ||
              (rows[0]?.result !== true && rows[0]?.result !== false)
            )
              throw new Error("activation_permit_install_unproven");
            return rows[0].result
              ? ("installed" as const)
              : ("existing" as const);
          },
        }
      : undefined;
  return {
    authority: new ReleaseAuthorityService(adapter, permitInstaller),
    providerAuthority: new ProviderAuthorityDecisionService(
      providerAuthorityAdapter,
    ),
    runnerOperations: new RunnerOperationsService(adapter),
    reconciliation: new ReleaseRolloutReconciliationService(adapter),
    ...credentials,
  };
}

export async function createReleaseControlApp(input: {
  readonly controlPrisma: PrismaClient;
  readonly providerAuthorityPrisma: PrismaClient;
  readonly permitInstallerPrisma: PrismaClient;
  readonly credentials: ReleaseControlCredentials;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const dependencies = composeReleaseControlDependencies(
    input.controlPrisma,
    input.providerAuthorityPrisma,
    input.credentials,
    input.permitInstallerPrisma,
  );
  app.get("/health", async (_request, reply) => {
    try {
      await Promise.all([
        input.controlPrisma.$queryRaw(Prisma.sql`SELECT 1`),
        input.providerAuthorityPrisma.$queryRaw(Prisma.sql`SELECT 1`),
        input.permitInstallerPrisma.$queryRaw(Prisma.sql`SELECT 1`),
      ]);
      return { status: "ok", service: "release-control" };
    } catch {
      return reply.code(503).send({
        status: "degraded",
        service: "release-control",
        reason: "database_unavailable",
      });
    }
  });
  await registerReleaseControlRoutes(app, dependencies);
  return app;
}
