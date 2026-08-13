import { Prisma } from "@prisma/client";
import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "@reviewrouter/platform-db";
import {
  registerReleaseControlRoutes,
  ProviderAuthorityDecisionService,
  ReleaseAuthorityService,
  ReleaseRolloutReconciliationService,
  RoutineReleaseControlLedgerAdapter,
  RoutineTargetActivationReceiptReaderAdapter,
  RunnerOperationsService,
  ReleaseServiceTransitionService,
  type ActivationPermitInstallerPort,
  type ReleaseControlRouteDependencies,
} from "./release-rollout-ledger.js";
import { observeReleaseAuthorityDatabaseReadiness } from "./release-authority/adapters/postgres-readiness.js";
import { releaseControlDatabaseSetIsReady } from "./release-authority/application/readiness.js";

export type ReleaseControlCredentials = Readonly<{
  controlTokenSha256: string;
  providerAuthorityTokenSha256: string;
}>;

const readinessGate = <Service extends object>(
  service: Service,
  assertReady: () => Promise<void>,
): Service =>
  new Proxy(service, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      return async (...args: readonly unknown[]) => {
        await assertReady();
        return Reflect.apply(value, target, args);
      };
    },
  });

const credentialSha256 = /^[a-f0-9]{64}$/u;

export function composeReleaseControlDependencies(
  controlPrisma: PrismaClient,
  providerAuthorityPrisma: PrismaClient,
  credentials: ReleaseControlCredentials,
  permitInstallerPrisma?: PrismaClient,
  targetReceiptReaderPrisma?: PrismaClient,
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
  const targetReceiptReader = targetReceiptReaderPrisma
    ? new RoutineTargetActivationReceiptReaderAdapter(targetReceiptReaderPrisma)
    : undefined;
  return {
    authority: new ReleaseAuthorityService(
      adapter,
      permitInstaller,
      targetReceiptReader,
    ),
    providerAuthority: new ProviderAuthorityDecisionService(
      providerAuthorityAdapter,
    ),
    runnerOperations: new RunnerOperationsService(adapter),
    reconciliation: new ReleaseRolloutReconciliationService(
      adapter,
      targetReceiptReader,
    ),
    serviceTransition: new ReleaseServiceTransitionService(adapter),
    ...credentials,
  };
}

export async function createReleaseControlApp(input: {
  readonly controlPrisma: PrismaClient;
  readonly providerAuthorityPrisma: PrismaClient;
  readonly permitInstallerPrisma: PrismaClient;
  readonly targetReceiptReaderPrisma: PrismaClient;
  readonly credentials: ReleaseControlCredentials;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const dependencies = composeReleaseControlDependencies(
    input.controlPrisma,
    input.providerAuthorityPrisma,
    input.credentials,
    input.permitInstallerPrisma,
    input.targetReceiptReaderPrisma,
  );
  const assertMutationAuthorityReady = async () => {
    const [control, provider, installer, reader] = await Promise.all([
      observeReleaseAuthorityDatabaseReadiness(input.controlPrisma),
      observeReleaseAuthorityDatabaseReadiness(input.providerAuthorityPrisma),
      observeReleaseAuthorityDatabaseReadiness(input.permitInstallerPrisma),
      observeReleaseAuthorityDatabaseReadiness(input.targetReceiptReaderPrisma),
    ]);
    if (
      !releaseControlDatabaseSetIsReady({
        control,
        provider,
        installer,
        reader,
      })
    )
      throw new Error("release_control_mutation_authority_degraded");
  };
  const gatedDependencies: ReleaseControlRouteDependencies = {
    ...dependencies,
    authority: readinessGate(
      dependencies.authority,
      assertMutationAuthorityReady,
    ),
    ...(dependencies.providerAuthority
      ? {
          providerAuthority: readinessGate(
            dependencies.providerAuthority,
            assertMutationAuthorityReady,
          ),
        }
      : {}),
    runnerOperations: readinessGate(
      dependencies.runnerOperations,
      assertMutationAuthorityReady,
    ),
    reconciliation: readinessGate(
      dependencies.reconciliation,
      assertMutationAuthorityReady,
    ),
    ...(dependencies.serviceTransition
      ? {
          serviceTransition: readinessGate(
            dependencies.serviceTransition,
            assertMutationAuthorityReady,
          ),
        }
      : {}),
  };
  app.get("/health", async (_request, reply) => {
    try {
      const [control, provider, installer, reader] = await Promise.all([
        observeReleaseAuthorityDatabaseReadiness(input.controlPrisma),
        observeReleaseAuthorityDatabaseReadiness(input.providerAuthorityPrisma),
        observeReleaseAuthorityDatabaseReadiness(input.permitInstallerPrisma),
        observeReleaseAuthorityDatabaseReadiness(
          input.targetReceiptReaderPrisma,
        ),
      ]);
      if (
        !releaseControlDatabaseSetIsReady({
          control,
          provider,
          installer,
          reader,
        })
      )
        throw new Error("release_control_database_identity_invalid");
      return { status: "ok", service: "release-control" };
    } catch {
      return reply.code(503).send({
        status: "degraded",
        service: "release-control",
        reason: "database_unavailable",
      });
    }
  });
  await registerReleaseControlRoutes(app, gatedDependencies);
  return app;
}
