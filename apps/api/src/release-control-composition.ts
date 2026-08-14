import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "@reviewrouter/platform-db";
import {
  registerReleaseControlRoutes,
  ProviderAuthorityDecisionService,
  ReleaseAuthorityService,
  ReleaseRolloutReconciliationService,
  RoutineReleaseControlLedgerAdapter,
  RoutineProviderMutationAuthorityAdapter,
  RoutineTargetActivationReceiptReaderAdapter,
  RunnerOperationsService,
  ReleaseServiceTransitionService,
  ProviderMutationAuthorityService,
  type ReleaseAuthorityHighRiskMutationGate,
  type ActivationPermitInstallerPort,
  type ReleaseControlRouteDependencies,
} from "./release-rollout-ledger.js";
import {
  observeReleaseAuthorityDatabaseReadiness,
  observeReleaseAuthorityDatabaseReadinessOnConnection,
} from "./release-authority/adapters/postgres-readiness.js";
import {
  defaultReadinessTimingPolicy,
  DefinitiveAttestationMismatchError,
  ReleaseAuthorityAttestationCoordinator,
  validateReadinessTimingPolicy,
  type MonotonicScheduler,
  type ReadinessTimingPolicy,
} from "./release-authority/application/attestation-lease.js";
import {
  releaseControlDatabaseSetIsReady,
  type TrustedReleaseControlDatabaseIdentity,
} from "./release-authority/application/readiness.js";
import {
  createReleaseAuthorityAttestationSubject,
  ReleaseAuthorityServiceKind,
} from "./release-authority/domain/attestation-subject.js";
import {
  releaseAuthorityCatalogVerifier,
  releaseAuthorityMigrationContract,
} from "./release-authority/domain/readiness-contract.mjs";
import {
  executeAtomicReleaseControlMutation,
  executeSameConnectionFenced,
  type SameConnectionTransactionTiming,
} from "./release-authority/adapters/same-connection-fence.js";
import type { TrustedActivationCatalogPolicy } from "./release-authority/domain/activation-catalog-policy.js";

export type TrustedActivationCatalogPolicies = Readonly<{
  preactivation: TrustedActivationCatalogPolicy;
  activated: TrustedActivationCatalogPolicy;
}>;

export type ReleaseControlCredentials = Readonly<{
  controlTokenSha256: string;
  providerAuthorityTokenSha256: string;
}>;

const credentialSha256 = /^[a-f0-9]{64}$/u;

export function composeReleaseControlDependencies(
  controlPrisma: PrismaClient,
  providerAuthorityPrisma: PrismaClient,
  credentials: ReleaseControlCredentials,
  trustedDatabaseIdentity: TrustedReleaseControlDatabaseIdentity,
  permitInstallerPrisma?: PrismaClient,
  targetReceiptReaderPrisma?: PrismaClient,
  sameConnectionTiming?: SameConnectionTransactionTiming,
  highRiskMutationGate?: ReleaseAuthorityHighRiskMutationGate,
  trustedActivationCatalogPolicies?: TrustedActivationCatalogPolicies,
): ReleaseControlRouteDependencies {
  if (
    !credentialSha256.test(credentials.controlTokenSha256) ||
    !credentialSha256.test(credentials.providerAuthorityTokenSha256) ||
    credentials.controlTokenSha256 === credentials.providerAuthorityTokenSha256
  )
    throw new Error("release_control_credential_hash_invalid");
  const adapter = new RoutineReleaseControlLedgerAdapter(
    controlPrisma,
    trustedDatabaseIdentity
      ? {
          roleName: "reviewrouter_release_control",
          databaseIdentity: trustedDatabaseIdentity.authorityDatabaseIdentity,
          postgresMajor: 17,
        }
      : undefined,
    sameConnectionTiming,
  );
  const providerAuthorityAdapter = new RoutineReleaseControlLedgerAdapter(
    providerAuthorityPrisma,
    trustedDatabaseIdentity
      ? {
          roleName: "reviewrouter_provider_authority",
          databaseIdentity: trustedDatabaseIdentity.authorityDatabaseIdentity,
          postgresMajor: 17,
        }
      : undefined,
    sameConnectionTiming,
  );
  const permitInstaller: ActivationPermitInstallerPort | undefined =
    permitInstallerPrisma
      ? {
          install: async (authorization) => {
            if (!trustedActivationCatalogPolicies)
              throw new Error("trusted_activation_catalog_policy_missing");
            const query = (connection: Prisma.TransactionClient) =>
              connection.$queryRaw<{ result: boolean }[]>(Prisma.sql`
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
              ,${JSON.stringify(trustedActivationCatalogPolicies.preactivation.policy)}::jsonb
              ,${trustedActivationCatalogPolicies.preactivation.sha256}
              ,${JSON.stringify(trustedActivationCatalogPolicies.activated.policy)}::jsonb
              ,${trustedActivationCatalogPolicies.activated.sha256}
            ) AS result
          `);
            const rows =
              trustedDatabaseIdentity &&
              typeof permitInstallerPrisma.$transaction === "function"
                ? await executeSameConnectionFenced(
                    permitInstallerPrisma,
                    {
                      roleName: "reviewrouter_activation_permit_installer",
                      databaseIdentity:
                        trustedDatabaseIdentity.targetDatabaseIdentity,
                      postgresMajor: 17,
                    },
                    query,
                    sameConnectionTiming,
                  )
                : await permitInstallerPrisma.$queryRaw<
                    { result: boolean }[]
                  >(Prisma.sql`
                  SELECT reviewrouter_activation.install_activation_permit(
                    ${authorization.rolloutId}, ${authorization.sourceSystemIdentifier},
                    ${authorization.targetSystemIdentifier}, ${authorization.postgresMajor},
                    ${authorization.expectedCommitSha}, ${authorization.migrationChecksum},
                    ${JSON.stringify(authorization.targetDeployIds)}::jsonb,
                    ${authorization.epoch}, ${authorization.nonce},
                    ${JSON.stringify(trustedActivationCatalogPolicies.preactivation.policy)}::jsonb,
                    ${trustedActivationCatalogPolicies.preactivation.sha256},
                    ${JSON.stringify(trustedActivationCatalogPolicies.activated.policy)}::jsonb,
                    ${trustedActivationCatalogPolicies.activated.sha256}) AS result
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
    ? new RoutineTargetActivationReceiptReaderAdapter(
        targetReceiptReaderPrisma,
        trustedDatabaseIdentity &&
          typeof targetReceiptReaderPrisma.$transaction === "function"
          ? {
              roleName: "reviewrouter_activation_receipt_reader",
              databaseIdentity: trustedDatabaseIdentity.targetDatabaseIdentity,
              postgresMajor: 17,
            }
          : undefined,
        sameConnectionTiming,
      )
    : undefined;
  return {
    authority: new ReleaseAuthorityService(
      adapter,
      permitInstaller,
      targetReceiptReader,
      highRiskMutationGate,
    ),
    providerAuthority: new ProviderAuthorityDecisionService(
      providerAuthorityAdapter,
      highRiskMutationGate,
    ),
    runnerOperations: new RunnerOperationsService(adapter),
    reconciliation: new ReleaseRolloutReconciliationService(
      adapter,
      targetReceiptReader,
      highRiskMutationGate,
    ),
    serviceTransition: new ReleaseServiceTransitionService(adapter),
    providerMutationAuthority: new ProviderMutationAuthorityService(
      new RoutineProviderMutationAuthorityAdapter(
        controlPrisma,
        trustedDatabaseIdentity
          ? {
              roleName: "reviewrouter_release_control",
              databaseIdentity:
                trustedDatabaseIdentity.authorityDatabaseIdentity,
              postgresMajor: 17,
            }
          : undefined,
        sameConnectionTiming,
      ),
      highRiskMutationGate,
    ),
    ...credentials,
  };
}

export async function createReleaseControlApp(input: {
  readonly controlPrisma: PrismaClient;
  readonly providerAuthorityPrisma: PrismaClient;
  readonly permitInstallerPrisma: PrismaClient;
  readonly targetReceiptReaderPrisma: PrismaClient;
  readonly credentials: ReleaseControlCredentials;
  readonly readinessPolicy?: Partial<ReadinessTimingPolicy>;
  readonly readinessScheduler?: MonotonicScheduler;
  readonly deploymentRevision?: string;
  readonly artifactDigest?: string;
  readonly trustedDatabaseIdentity?: TrustedReleaseControlDatabaseIdentity;
  readonly readinessObserver?: typeof observeReleaseAuthorityDatabaseReadiness;
  readonly atomicReadinessObserver?: typeof observeReleaseAuthorityDatabaseReadinessOnConnection;
  readonly trustedActivationCatalogPolicies?: TrustedActivationCatalogPolicies;
}): Promise<FastifyInstance> {
  if (!input.trustedDatabaseIdentity)
    throw new Error("release_control_trusted_database_identity_missing");
  if (!input.trustedActivationCatalogPolicies)
    throw new Error("trusted_activation_catalog_policy_missing");
  const app = Fastify({ logger: false });
  const readinessPolicyOptions = validateReadinessTimingPolicy({
    ...defaultReadinessTimingPolicy,
    ...input.readinessPolicy,
  });
  const sameConnectionTiming = {
    maxWaitMilliseconds: readinessPolicyOptions.poolWaitMilliseconds,
    transactionTimeoutMilliseconds:
      readinessPolicyOptions.transactionTimeoutMilliseconds,
  };
  const atomicMutationTiming = {
    ...sameConnectionTiming,
    lockTimeoutMilliseconds: readinessPolicyOptions.lockTimeoutMilliseconds,
    statementTimeoutMilliseconds:
      readinessPolicyOptions.statementTimeoutMilliseconds,
  };
  const readinessObserver =
    input.readinessObserver ?? observeReleaseAuthorityDatabaseReadiness;
  const observeMutationAuthority = async (signal: AbortSignal) => {
    const observationOptions = {
      signal,
      poolWaitMilliseconds: readinessPolicyOptions.poolWaitMilliseconds,
      lockTimeoutMilliseconds: readinessPolicyOptions.lockTimeoutMilliseconds,
      statementTimeoutMilliseconds:
        readinessPolicyOptions.statementTimeoutMilliseconds,
      transactionTimeoutMilliseconds:
        readinessPolicyOptions.transactionTimeoutMilliseconds,
    };
    const [control, provider, installer, reader] = await Promise.all([
      readinessObserver(input.controlPrisma, observationOptions),
      readinessObserver(input.providerAuthorityPrisma, observationOptions),
      readinessObserver(input.permitInstallerPrisma, observationOptions),
      readinessObserver(input.targetReceiptReaderPrisma, observationOptions),
    ]);
    if (
      !input.trustedDatabaseIdentity ||
      !releaseControlDatabaseSetIsReady(
        {
          control,
          provider,
          installer,
          reader,
        },
        input.trustedDatabaseIdentity,
      )
    )
      throw new DefinitiveAttestationMismatchError();
  };
  const deploymentRevision = input.deploymentRevision ?? "";
  const artifactDigest = input.artifactDigest ?? "";
  const manifestIdentity = `sha256:${createHash("sha256")
    .update(
      JSON.stringify([
        releaseAuthorityMigrationContract,
        input.trustedDatabaseIdentity.targetMigrationManifestIdentity,
      ]),
    )
    .digest("hex")}`;
  const subject = createReleaseAuthorityAttestationSubject({
    serviceKind: ReleaseAuthorityServiceKind.Control,
    deploymentRevision,
    artifactDigest,
    catalogContractId: releaseAuthorityCatalogVerifier,
    expectedDatabases: [
      {
        roleName: "reviewrouter_release_control",
        identity: input.trustedDatabaseIdentity.authorityDatabaseIdentity,
      },
      {
        roleName: "reviewrouter_provider_authority",
        identity: input.trustedDatabaseIdentity.authorityDatabaseIdentity,
      },
      {
        roleName: "reviewrouter_activation_permit_installer",
        identity: input.trustedDatabaseIdentity.targetDatabaseIdentity,
      },
      {
        roleName: "reviewrouter_activation_receipt_reader",
        identity: input.trustedDatabaseIdentity.targetDatabaseIdentity,
      },
    ],
    requiredRoles: [
      "reviewrouter_release_control",
      "reviewrouter_provider_authority",
      "reviewrouter_release_witness",
      input.trustedDatabaseIdentity.authorityOwnerRoleName,
      "reviewrouter_activation_permit_installer",
      "reviewrouter_activation_receipt_reader",
      input.trustedDatabaseIdentity.activationGuardRoleName,
    ],
    authorityOwnerRoleName:
      input.trustedDatabaseIdentity.authorityOwnerRoleName,
    activationGuardRoleName:
      input.trustedDatabaseIdentity.activationGuardRoleName,
    routineBodyRoots: {
      installerSha256: `sha256:${input.trustedDatabaseIdentity.installerRoutineBodySha256}`,
      readerSha256: `sha256:${input.trustedDatabaseIdentity.readerRoutineBodySha256}`,
    },
    migrationManifestIdentity: manifestIdentity,
    activationFingerprint:
      input.trustedDatabaseIdentity.activationNamespaceFingerprint,
  });
  const readiness = new ReleaseAuthorityAttestationCoordinator(
    (_subject, signal) => observeMutationAuthority(signal),
    () =>
      Object.assign(new Error("release_control_readiness_unavailable"), {
        statusCode: 503,
      }),
    readinessPolicyOptions,
    input.readinessScheduler,
  );
  const highRiskMutationGate: ReleaseAuthorityHighRiskMutationGate = {
    execute: (sequence) =>
      readiness.executeHighRiskMutationSequence(subject, (executeFresh) =>
        sequence((target, mutation) =>
          executeFresh(() =>
            executeAtomicReleaseControlMutation(
              {
                control: {
                  prisma: input.controlPrisma,
                  expected: {
                    roleName: "reviewrouter_release_control",
                    databaseIdentity:
                      input.trustedDatabaseIdentity!.authorityDatabaseIdentity,
                    postgresMajor: 17,
                  },
                },
                provider: {
                  prisma: input.providerAuthorityPrisma,
                  expected: {
                    roleName: "reviewrouter_provider_authority",
                    databaseIdentity:
                      input.trustedDatabaseIdentity!.authorityDatabaseIdentity,
                    postgresMajor: 17,
                  },
                },
                installer: {
                  prisma: input.permitInstallerPrisma,
                  expected: {
                    roleName: "reviewrouter_activation_permit_installer",
                    databaseIdentity:
                      input.trustedDatabaseIdentity!.targetDatabaseIdentity,
                    postgresMajor: 17,
                  },
                },
                reader: {
                  prisma: input.targetReceiptReaderPrisma,
                  expected: {
                    roleName: "reviewrouter_activation_receipt_reader",
                    databaseIdentity:
                      input.trustedDatabaseIdentity!.targetDatabaseIdentity,
                    postgresMajor: 17,
                  },
                },
              },
              target,
              input.trustedDatabaseIdentity!,
              mutation,
              atomicMutationTiming,
              () =>
                Object.assign(
                  new Error("release_control_readiness_unavailable"),
                  { statusCode: 503 },
                ),
              input.atomicReadinessObserver,
            ),
          ),
        ),
      ),
  };
  const dependencies = composeReleaseControlDependencies(
    input.controlPrisma,
    input.providerAuthorityPrisma,
    input.credentials,
    input.trustedDatabaseIdentity,
    input.permitInstallerPrisma,
    input.targetReceiptReaderPrisma,
    sameConnectionTiming,
    highRiskMutationGate,
    input.trustedActivationCatalogPolicies,
  );
  const assertMutationAuthorityReady = () => readiness.assertOrdinary(subject);
  const ordinary =
    <Arguments extends readonly unknown[], Result>(
      operation: (...args: Arguments) => Result,
    ) =>
    async (...args: Arguments): Promise<Awaited<Result>> => {
      await assertMutationAuthorityReady();
      return await operation(...args);
    };
  const gatedDependencies: ReleaseControlRouteDependencies = {
    ...dependencies,
    authority: {
      claim: ordinary(dependencies.authority.claim),
      completeSourceFreeze: ordinary(
        dependencies.authority.completeSourceFreeze,
      ),
      prepareSourceFreezeMutation: ordinary(
        dependencies.authority.prepareSourceFreezeMutation,
      ),
      recordSourceFreezeMutation: ordinary(
        dependencies.authority.recordSourceFreezeMutation,
      ),
      cas: dependencies.authority.cas,
      markUncertain: dependencies.authority.markUncertain,
      fenceTargetSwitch: dependencies.authority.fenceTargetSwitch,
      authorizeActivation: dependencies.authority.authorizeActivation,
      authorizeAndInstall: dependencies.authority.authorizeAndInstall,
      finalize: dependencies.authority.finalize,
      state: ordinary(dependencies.authority.state),
      authorityState: ordinary(dependencies.authority.authorityState),
      compensationCheckpoint: ordinary(
        dependencies.authority.compensationCheckpoint,
      ),
      verifyFinalAuthority: ordinary(
        dependencies.authority.verifyFinalAuthority,
      ),
    },
    ...(dependencies.providerAuthority
      ? {
          providerAuthority: {
            decide: dependencies.providerAuthority.decide,
          },
        }
      : {}),
    runnerOperations: {
      persistProvisioningIntent: ordinary(
        dependencies.runnerOperations.persistProvisioningIntent,
      ),
      listIntents: ordinary(dependencies.runnerOperations.listIntents),
      acquireProviderDispatchPermit: ordinary(
        dependencies.runnerOperations.acquireProviderDispatchPermit,
      ),
      abandonPreparedEffect: ordinary(
        dependencies.runnerOperations.abandonPreparedEffect,
      ),
      reconcileProvisioningEffect: ordinary(
        dependencies.runnerOperations.reconcileProvisioningEffect,
      ),
      persistJob: ordinary(dependencies.runnerOperations.persistJob),
      listOpenJobs: ordinary(dependencies.runnerOperations.listOpenJobs),
      persistIdentity: ordinary(dependencies.runnerOperations.persistIdentity),
      currentRunner: ordinary(dependencies.runnerOperations.currentRunner),
      markTerminal: ordinary(dependencies.runnerOperations.markTerminal),
      cleanupObservation: ordinary(
        dependencies.runnerOperations.cleanupObservation,
      ),
      cleanupWitness: ordinary(dependencies.runnerOperations.cleanupWitness),
      terminalCleanupFact: ordinary(
        dependencies.runnerOperations.terminalCleanupFact,
      ),
      persistRegistration: ordinary(
        dependencies.runnerOperations.persistRegistration,
      ),
    },
    reconciliation: {
      reconcile: dependencies.reconciliation.reconcile,
    },
    ...(dependencies.serviceTransition
      ? {
          serviceTransition: {
            begin: ordinary(dependencies.serviceTransition.begin),
            append: ordinary(dependencies.serviceTransition.append),
            read: ordinary(dependencies.serviceTransition.read),
            readContract: ordinary(dependencies.serviceTransition.readContract),
            complete: ordinary(dependencies.serviceTransition.complete),
            intendRecoveryEffect: ordinary(
              dependencies.serviceTransition.intendRecoveryEffect,
            ),
            claimRecoveryEffect: ordinary(
              dependencies.serviceTransition.claimRecoveryEffect,
            ),
            consumeRecoveryEffectPermit: ordinary(
              dependencies.serviceTransition.consumeRecoveryEffectPermit,
            ),
            validateRecoveryEffectExecution: ordinary(
              dependencies.serviceTransition.validateRecoveryEffectExecution,
            ),
            completeRecoveryEffect: ordinary(
              dependencies.serviceTransition.completeRecoveryEffect,
            ),
            reconcileRecoveryEffect: ordinary(
              dependencies.serviceTransition.reconcileRecoveryEffect,
            ),
          },
        }
      : {}),
    ...(dependencies.providerMutationAuthority
      ? {
          providerMutationAuthority: {
            recover: dependencies.providerMutationAuthority.recover,
            issue: dependencies.providerMutationAuthority.issue,
            consume: dependencies.providerMutationAuthority.consume,
            validateExecution:
              dependencies.providerMutationAuthority.validateExecution,
            complete: dependencies.providerMutationAuthority.complete,
            reconcile: dependencies.providerMutationAuthority.reconcile,
          },
        }
      : {}),
  };
  app.get("/health", async (_request, reply) => {
    if (readiness.state(subject).status === "ready")
      return { status: "ok", service: "release-control" };
    return reply.code(503).send({
      status: "degraded",
      service: "release-control",
      reason: "database_unavailable",
    });
  });
  app.addHook("onReady", () => readiness.startInitial(subject));
  app.addHook("onClose", () => readiness.close());
  await registerReleaseControlRoutes(app, gatedDependencies);
  return app;
}
