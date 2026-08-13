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

export type ReleaseControlCredentials = Readonly<{
  controlTokenSha256: string;
  providerAuthorityTokenSha256: string;
}>;

const credentialSha256 = /^[a-f0-9]{64}$/u;

type DatabaseReadiness = Readonly<{
  roleName: string;
  systemIdentifier: string;
  postgresMajor: number;
  controlRoutine: boolean;
  providerRoutine: boolean;
  installerRoutine: boolean;
  readerRoutine: boolean;
  prepareEffectRoutine: boolean;
  dispatchPermitRoutine: boolean;
  reconcileEffectRoutine: boolean;
  abandonPreparedRoutine: boolean;
  sourceFreezePrepareRoutine: boolean;
  sourceFreezePrepareExecute: boolean;
  sourceFreezeRecordRoutine: boolean;
  sourceFreezeRecordExecute: boolean;
  sourceFreezeCompleteRoutine: boolean;
  sourceFreezeCompleteExecute: boolean;
}>;

async function observeDatabaseReadiness(
  prisma: PrismaClient,
): Promise<DatabaseReadiness> {
  const rows = await prisma.$queryRaw<DatabaseReadiness[]>(Prisma.sql`
    SELECT current_user AS "roleName",
      (SELECT system_identifier::text FROM pg_control_system()) AS "systemIdentifier",
      current_setting('server_version_num')::integer / 10000 AS "postgresMajor",
      to_regprocedure('release_authority.release_rollout_claim(text,text,text,integer,text,text)') IS NOT NULL AS "controlRoutine",
      to_regprocedure('release_authority.release_provider_authority_decide(jsonb)') IS NOT NULL AS "providerRoutine",
      to_regprocedure('reviewrouter_activation.install_activation_permit(text,text,text,integer,text,text,jsonb,bigint,text)') IS NOT NULL AS "installerRoutine",
      to_regprocedure('reviewrouter_activation.read_activation_receipt(text)') IS NOT NULL AS "readerRoutine",
      to_regprocedure('release_authority.release_runner_prepare_effect(jsonb)') IS NOT NULL AS "prepareEffectRoutine",
      to_regprocedure('release_authority.release_runner_acquire_dispatch_permit(jsonb)') IS NOT NULL AS "dispatchPermitRoutine",
      to_regprocedure('release_authority.release_runner_reconcile_effect(jsonb)') IS NOT NULL AS "reconcileEffectRoutine",
      to_regprocedure('release_authority.release_runner_abandon_prepared(text,text,bigint)') IS NOT NULL AS "abandonPreparedRoutine",
      to_regprocedure('release_authority.release_source_freeze_prepare(text,text,text,integer,text,text,text,text,timestamptz,jsonb,boolean)') IS NOT NULL AS "sourceFreezePrepareRoutine",
      coalesce(pg_catalog.has_function_privilege(
        current_user,
        to_regprocedure('release_authority.release_source_freeze_prepare(text,text,text,integer,text,text,text,text,timestamptz,jsonb,boolean)'),
        'EXECUTE'
      ), false) AS "sourceFreezePrepareExecute",
      to_regprocedure('release_authority.release_source_freeze_record(text,text,text,integer,text,text,text,text,timestamptz,jsonb)') IS NOT NULL AS "sourceFreezeRecordRoutine",
      coalesce(pg_catalog.has_function_privilege(
        current_user,
        to_regprocedure('release_authority.release_source_freeze_record(text,text,text,integer,text,text,text,text,timestamptz,jsonb)'),
        'EXECUTE'
      ), false) AS "sourceFreezeRecordExecute",
      to_regprocedure('release_authority.release_source_freeze_complete(text,text,text,integer,text,text,jsonb,timestamptz)') IS NOT NULL AS "sourceFreezeCompleteRoutine",
      coalesce(pg_catalog.has_function_privilege(
        current_user,
        to_regprocedure('release_authority.release_source_freeze_complete(text,text,text,integer,text,text,jsonb,timestamptz)'),
        'EXECUTE'
      ), false) AS "sourceFreezeCompleteExecute"
  `);
  if (rows.length !== 1 || !rows[0])
    throw new Error("release_control_database_identity_unavailable");
  return rows[0];
}

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
  app.get("/health", async (_request, reply) => {
    try {
      const [control, provider, installer, reader] = await Promise.all([
        observeDatabaseReadiness(input.controlPrisma),
        observeDatabaseReadiness(input.providerAuthorityPrisma),
        observeDatabaseReadiness(input.permitInstallerPrisma),
        observeDatabaseReadiness(input.targetReceiptReaderPrisma),
      ]);
      if (
        control.roleName !== "reviewrouter_release_control" ||
        provider.roleName !== "reviewrouter_provider_authority" ||
        installer.roleName !== "reviewrouter_activation_permit_installer" ||
        reader.roleName !== "reviewrouter_activation_receipt_reader" ||
        control.systemIdentifier !== provider.systemIdentifier ||
        control.systemIdentifier === installer.systemIdentifier ||
        installer.systemIdentifier !== reader.systemIdentifier ||
        control.postgresMajor !== 17 ||
        provider.postgresMajor !== 17 ||
        installer.postgresMajor !== 17 ||
        reader.postgresMajor !== 17 ||
        !control.controlRoutine ||
        !control.prepareEffectRoutine ||
        !control.dispatchPermitRoutine ||
        !control.reconcileEffectRoutine ||
        !control.abandonPreparedRoutine ||
        !control.sourceFreezePrepareRoutine ||
        !control.sourceFreezePrepareExecute ||
        !control.sourceFreezeRecordRoutine ||
        !control.sourceFreezeRecordExecute ||
        !control.sourceFreezeCompleteRoutine ||
        !control.sourceFreezeCompleteExecute ||
        !provider.providerRoutine ||
        !installer.installerRoutine ||
        !reader.readerRoutine
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
  await registerReleaseControlRoutes(app, dependencies);
  return app;
}
