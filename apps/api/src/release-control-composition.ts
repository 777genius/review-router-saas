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
  ReleaseControlReadinessPhase,
  releaseControlDatabaseSetIsReady,
  releaseControlMutationDatabaseIsReady,
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
  observeAtomicConnectionAwareReadiness,
  executeSameConnectionFenced,
  type SameConnectionTransactionTiming,
} from "./release-authority/adapters/same-connection-fence.js";
import {
  activationCatalogPolicyDigestsEqual,
  canonicalActivationCatalogPolicies,
  canonicalActivationCatalogPolicyDigests,
  canonicalJson,
  createReleaseMigrationTransition,
  type ReleaseMigrationTransitionV1,
  type PinnedActivationCatalogPolicy,
} from "@reviewrouter/features-release-rollout";

export type TrustedActivationCatalogPolicies = Readonly<{
  preactivation: PinnedActivationCatalogPolicy;
  activated: PinnedActivationCatalogPolicy;
}>;

export type ReleaseControlCredentials = Readonly<{
  controlTokenSha256: string;
  providerAuthorityTokenSha256: string;
}>;

type TargetManifestPhase =
  | "pre_migration"
  | "migration_recovery"
  | "post_migration"
  | "control_only";

const readinessPhaseFor = (
  phase: TargetManifestPhase,
): ReleaseControlReadinessPhase => {
  switch (phase) {
    case "pre_migration":
      return ReleaseControlReadinessPhase.PreMigration;
    case "migration_recovery":
      return ReleaseControlReadinessPhase.MigrationRecovery;
    case "post_migration":
      return ReleaseControlReadinessPhase.PostMigration;
    case "control_only":
      return ReleaseControlReadinessPhase.ControlOnly;
  }
};

export function trustedTargetIdentityForPhase(
  configured: TrustedReleaseControlDatabaseIdentity,
  transition: ReleaseMigrationTransitionV1,
  phase: TargetManifestPhase,
  targetManifestIdentity?: string,
): TrustedReleaseControlDatabaseIdentity {
  const base = { ...configured };
  Reflect.deleteProperty(base, "allowedTargetMigrationEndpoints");
  Reflect.deleteProperty(base, "targetPostCatalogDigest");
  const manifestIdentity =
    targetManifestIdentity ??
    (phase === "post_migration"
      ? transition.postManifestIdentity
      : transition.preManifestIdentity);
  return {
    ...base,
    targetMigrationManifestIdentity: manifestIdentity,
    ...(phase === "migration_recovery"
      ? {
          allowedTargetMigrationEndpoints: [
            {
              manifestIdentity: transition.postManifestIdentity,
              postCatalogDigest: transition.postCatalogDigest,
            },
          ],
        }
      : {}),
    ...(phase === "post_migration"
      ? { targetPostCatalogDigest: transition.postCatalogDigest }
      : {}),
  };
}

const credentialSha256 = /^[a-f0-9]{64}$/u;

export function composeReleaseControlDependencies(
  controlPrisma: PrismaClient,
  providerAuthorityPrisma: PrismaClient,
  credentials: ReleaseControlCredentials,
  trustedDatabaseIdentity: TrustedReleaseControlDatabaseIdentity,
  highRiskMutationGate: ReleaseAuthorityHighRiskMutationGate,
  permitInstallerPrisma?: PrismaClient,
  targetReceiptReaderPrisma?: PrismaClient,
  sameConnectionTiming?: SameConnectionTransactionTiming,
  trustedMigrationTransition?: ReleaseMigrationTransitionV1,
): ReleaseControlRouteDependencies {
  if (
    !credentialSha256.test(credentials.controlTokenSha256) ||
    !credentialSha256.test(credentials.providerAuthorityTokenSha256) ||
    credentials.controlTokenSha256 === credentials.providerAuthorityTokenSha256
  )
    throw new Error("release_control_credential_hash_invalid");
  if (!highRiskMutationGate)
    throw new Error("release_authority_high_risk_mutation_gate_missing");
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
              ,${JSON.stringify(canonicalActivationCatalogPolicies.preactivation.policy)}::jsonb
              ,${canonicalActivationCatalogPolicies.preactivation.sha256}
              ,${JSON.stringify(canonicalActivationCatalogPolicies.activated.policy)}::jsonb
              ,${canonicalActivationCatalogPolicies.activated.sha256}
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
                    ${JSON.stringify(canonicalActivationCatalogPolicies.preactivation.policy)}::jsonb,
                    ${canonicalActivationCatalogPolicies.preactivation.sha256},
                    ${JSON.stringify(canonicalActivationCatalogPolicies.activated.policy)}::jsonb,
                    ${canonicalActivationCatalogPolicies.activated.sha256}) AS result
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
          installMigrationPermit: async ({
            permit,
            sourceSystemIdentifier,
            expectedPostManifestIdentity,
            expectedPostCatalogDigest,
          }) => {
            const query = (connection: Prisma.TransactionClient) =>
              connection.$queryRaw<{ result: boolean }[]>(Prisma.sql`
              SELECT reviewrouter_activation.install_migration_permit(
                ${permit.rolloutId}, ${sourceSystemIdentifier},
                ${permit.targetSystemIdentifier},
                ${permit.targetRecoveryWitnessSha256},
                ${permit.transitionSha256},
                ${permit.expectedPreviousReceiptSha256},
                ${expectedPostManifestIdentity},
                ${expectedPostCatalogDigest},
                ${permit.epoch}, ${permit.nonce}) AS result
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
                : await query(permitInstallerPrisma);
            if (
              rows.length !== 1 ||
              (rows[0]?.result !== true && rows[0]?.result !== false)
            )
              throw new Error("release_migration_permit_install_unproven");
            return rows[0].result ? "installed" : "existing";
          },
          terminalizeMigrationPermit: async ({ permit, outcome }) => {
            const query = (connection: Prisma.TransactionClient) =>
              connection.$queryRaw<{ result: boolean }[]>(Prisma.sql`
              SELECT reviewrouter_activation.terminalize_migration_permit(
                ${permit.rolloutId}, ${permit.epoch}, ${permit.nonce},
                ${outcome}) AS result
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
                : await query(permitInstallerPrisma);
            if (
              rows.length !== 1 ||
              (rows[0]?.result !== true && rows[0]?.result !== false)
            )
              throw new Error(
                "release_migration_permit_terminalization_unproven",
              );
            return rows[0].result ? "terminalized" : "existing";
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
      trustedMigrationTransition,
      targetReceiptReader,
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
  const trustedDatabaseIdentity = input.trustedDatabaseIdentity;
  if (!input.trustedActivationCatalogPolicies)
    throw new Error("trusted_activation_catalog_policy_missing");
  if (
    !activationCatalogPolicyDigestsEqual({
      preactivationCatalogPolicySha256:
        input.trustedActivationCatalogPolicies.preactivation.sha256,
      activatedCatalogPolicySha256:
        input.trustedActivationCatalogPolicies.activated.sha256,
    }) ||
    canonicalJson(
      input.trustedActivationCatalogPolicies.preactivation.policy,
    ) !==
      canonicalJson(canonicalActivationCatalogPolicies.preactivation.policy) ||
    canonicalJson(input.trustedActivationCatalogPolicies.activated.policy) !==
      canonicalJson(canonicalActivationCatalogPolicies.activated.policy)
  )
    throw new Error("trusted_activation_catalog_policy_mismatch");
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
  const atomicReadinessObserver =
    input.atomicReadinessObserver ??
    observeReleaseAuthorityDatabaseReadinessOnConnection;
  const observeMutationAuthority = async (
    attestationSubject: import("./release-authority/domain/attestation-subject.js").ReleaseAuthorityAttestationSubject,
    signal: AbortSignal,
  ) => {
    const observationOptions = {
      signal,
      poolWaitMilliseconds: readinessPolicyOptions.poolWaitMilliseconds,
      lockTimeoutMilliseconds: readinessPolicyOptions.lockTimeoutMilliseconds,
      statementTimeoutMilliseconds:
        readinessPolicyOptions.statementTimeoutMilliseconds,
      transactionTimeoutMilliseconds:
        readinessPolicyOptions.transactionTimeoutMilliseconds,
    };
    if (attestationSubject.targetManifestPhase === "control_only") {
      const [control, provider] = await Promise.all([
        observeAtomicConnectionAwareReadiness(
          input.controlPrisma,
          {
            roleName: "reviewrouter_release_control",
            databaseIdentity: trustedDatabaseIdentity.authorityDatabaseIdentity,
            postgresMajor: 17,
          },
          observationOptions,
          readinessObserver,
          atomicReadinessObserver,
        ),
        observeAtomicConnectionAwareReadiness(
          input.providerAuthorityPrisma,
          {
            roleName: "reviewrouter_provider_authority",
            databaseIdentity: trustedDatabaseIdentity.authorityDatabaseIdentity,
            postgresMajor: 17,
          },
          observationOptions,
          readinessObserver,
          atomicReadinessObserver,
        ),
      ]);
      if (
        !releaseControlMutationDatabaseIsReady(
          control,
          trustedDatabaseIdentity,
          ReleaseControlReadinessPhase.ControlOnly,
        ) ||
        !releaseControlMutationDatabaseIsReady(
          provider,
          trustedDatabaseIdentity,
          ReleaseControlReadinessPhase.ControlOnly,
        )
      )
        throw new DefinitiveAttestationMismatchError();
      return;
    }
    const [control, provider, installer, reader] = await Promise.all([
      observeAtomicConnectionAwareReadiness(
        input.controlPrisma,
        {
          roleName: "reviewrouter_release_control",
          databaseIdentity: trustedDatabaseIdentity.authorityDatabaseIdentity,
          postgresMajor: 17,
        },
        observationOptions,
        readinessObserver,
        atomicReadinessObserver,
      ),
      observeAtomicConnectionAwareReadiness(
        input.providerAuthorityPrisma,
        {
          roleName: "reviewrouter_provider_authority",
          databaseIdentity: trustedDatabaseIdentity.authorityDatabaseIdentity,
          postgresMajor: 17,
        },
        observationOptions,
        readinessObserver,
        atomicReadinessObserver,
      ),
      observeAtomicConnectionAwareReadiness(
        input.permitInstallerPrisma,
        {
          roleName: "reviewrouter_activation_permit_installer",
          databaseIdentity: trustedDatabaseIdentity.targetDatabaseIdentity,
          postgresMajor: 17,
        },
        observationOptions,
        readinessObserver,
        atomicReadinessObserver,
      ),
      observeAtomicConnectionAwareReadiness(
        input.targetReceiptReaderPrisma,
        {
          roleName: "reviewrouter_activation_receipt_reader",
          databaseIdentity: trustedDatabaseIdentity.targetDatabaseIdentity,
          postgresMajor: 17,
        },
        observationOptions,
        readinessObserver,
        atomicReadinessObserver,
      ),
    ]);
    if (
      !releaseControlDatabaseSetIsReady(
        {
          control,
          provider,
          installer,
          reader,
        },
        trustedTargetIdentityForPhase(
          trustedDatabaseIdentity,
          trustedMigrationTransition,
          attestationSubject.targetManifestPhase ?? "pre_migration",
          attestationSubject.targetManifestIdentity,
        ),
        readinessPhaseFor(
          attestationSubject.targetManifestPhase ?? "pre_migration",
        ) as Exclude<
          ReleaseControlReadinessPhase,
          ReleaseControlReadinessPhase.ControlOnly
        >,
      )
    )
      throw new DefinitiveAttestationMismatchError();
  };
  const deploymentRevision = input.deploymentRevision ?? "";
  const artifactDigest = input.artifactDigest ?? "";
  const trustedMigrationTransition = createReleaseMigrationTransition({
    commitSha: deploymentRevision,
    releaseImageDigest: artifactDigest,
  });
  if (
    input.trustedDatabaseIdentity.targetMigrationManifestIdentity !==
    trustedMigrationTransition.preManifestIdentity
  )
    throw new Error("release_migration_pre_manifest_identity_mismatch");
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
    targetManifestPhase: "control_only",
    migrationTransitionSha256: trustedMigrationTransition.transitionSha256,
    activationFingerprint:
      input.trustedDatabaseIdentity.activationNamespaceFingerprint,
    activationCatalogPolicies: canonicalActivationCatalogPolicyDigests,
  });
  const readiness = new ReleaseAuthorityAttestationCoordinator(
    (attestationSubject, signal) =>
      observeMutationAuthority(attestationSubject, signal),
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
        sequence((target, mutation, targetManifestPhase) => {
          const targetManifestIdentity =
            targetManifestPhase === "control_only"
              ? undefined
              : targetManifestPhase === "post_migration"
                ? trustedMigrationTransition.postManifestIdentity
                : targetManifestPhase === "migration_recovery"
                  ? trustedMigrationTransition.preManifestIdentity
                  : trustedMigrationTransition.preManifestIdentity;
          const phaseSubjectBase = { ...subject };
          Reflect.deleteProperty(phaseSubjectBase, "targetManifestIdentity");
          const phaseSubject = createReleaseAuthorityAttestationSubject({
            ...phaseSubjectBase,
            ...(targetManifestIdentity === undefined
              ? {}
              : { targetManifestIdentity }),
            targetManifestPhase: targetManifestPhase ?? "pre_migration",
            migrationTransitionSha256:
              trustedMigrationTransition.transitionSha256,
          });
          const phaseTrustedIdentity = trustedTargetIdentityForPhase(
            input.trustedDatabaseIdentity!,
            trustedMigrationTransition,
            targetManifestPhase ?? "pre_migration",
            targetManifestIdentity,
          );
          return executeFresh(
            () =>
              executeAtomicReleaseControlMutation(
                {
                  control: {
                    prisma: input.controlPrisma,
                    expected: {
                      roleName: "reviewrouter_release_control",
                      databaseIdentity:
                        input.trustedDatabaseIdentity!
                          .authorityDatabaseIdentity,
                      postgresMajor: 17,
                    },
                  },
                  provider: {
                    prisma: input.providerAuthorityPrisma,
                    expected: {
                      roleName: "reviewrouter_provider_authority",
                      databaseIdentity:
                        input.trustedDatabaseIdentity!
                          .authorityDatabaseIdentity,
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
                phaseTrustedIdentity,
                readinessPhaseFor(targetManifestPhase ?? "pre_migration"),
                mutation,
                atomicMutationTiming,
                () =>
                  Object.assign(
                    new Error("release_control_readiness_unavailable"),
                    { statusCode: 503 },
                  ),
                input.atomicReadinessObserver,
              ),
            phaseSubject,
          );
        }),
      ),
  };
  const dependencies = composeReleaseControlDependencies(
    input.controlPrisma,
    input.providerAuthorityPrisma,
    input.credentials,
    input.trustedDatabaseIdentity,
    highRiskMutationGate,
    input.permitInstallerPrisma,
    input.targetReceiptReaderPrisma,
    sameConnectionTiming,
    trustedMigrationTransition,
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
  const phaseGated =
    <Arguments extends readonly unknown[], Result>(
      operation: (...args: Arguments) => Result,
      targetManifestPhase: "pre_migration" | "post_migration" | "control_only",
    ) =>
    async (...args: Arguments): Promise<Awaited<Result>> =>
      await highRiskMutationGate.execute((executeFresh) =>
        executeFresh("control", () => operation(...args), targetManifestPhase),
      );
  const controlOnly = <Arguments extends readonly unknown[], Result>(
    operation: (...args: Arguments) => Result,
  ) => phaseGated(operation, "control_only");
  const postMigration = <Arguments extends readonly unknown[], Result>(
    operation: (...args: Arguments) => Result,
  ) => phaseGated(operation, "post_migration");
  const gatedDependencies: ReleaseControlRouteDependencies = {
    ...dependencies,
    authority: {
      claim: ordinary(dependencies.authority.claim),
      beginReleaseMigration: dependencies.authority.beginReleaseMigration,
      completeReleaseMigration: dependencies.authority.completeReleaseMigration,
      failReleaseMigration: dependencies.authority.failReleaseMigration,
      loadReleaseMigrationCheckpoint:
        dependencies.authority.loadReleaseMigrationCheckpoint,
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
      state: controlOnly(dependencies.authority.state),
      authorityState: controlOnly(dependencies.authority.authorityState),
      compensationCheckpoint: controlOnly(
        dependencies.authority.compensationCheckpoint,
      ),
      verifyFinalAuthority: postMigration(
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
      persistProvisioningIntent: controlOnly(
        dependencies.runnerOperations.persistProvisioningIntent,
      ),
      listIntents: controlOnly(dependencies.runnerOperations.listIntents),
      acquireProviderDispatchPermit: controlOnly(
        dependencies.runnerOperations.acquireProviderDispatchPermit,
      ),
      abandonPreparedEffect: controlOnly(
        dependencies.runnerOperations.abandonPreparedEffect,
      ),
      reconcileProvisioningEffect: controlOnly(
        dependencies.runnerOperations.reconcileProvisioningEffect,
      ),
      persistJob: controlOnly(dependencies.runnerOperations.persistJob),
      listOpenJobs: controlOnly(dependencies.runnerOperations.listOpenJobs),
      persistIdentity: controlOnly(
        dependencies.runnerOperations.persistIdentity,
      ),
      currentRunner: controlOnly(dependencies.runnerOperations.currentRunner),
      markTerminal: controlOnly(dependencies.runnerOperations.markTerminal),
      cleanupObservation: controlOnly(
        dependencies.runnerOperations.cleanupObservation,
      ),
      cleanupWitness: controlOnly(dependencies.runnerOperations.cleanupWitness),
      terminalCleanupFact: controlOnly(
        dependencies.runnerOperations.terminalCleanupFact,
      ),
      persistRegistration: controlOnly(
        dependencies.runnerOperations.persistRegistration,
      ),
    },
    reconciliation: {
      reconcile: dependencies.reconciliation.reconcile,
    },
    ...(dependencies.serviceTransition
      ? {
          serviceTransition: {
            begin: controlOnly(dependencies.serviceTransition.begin),
            append: controlOnly(dependencies.serviceTransition.append),
            read: controlOnly(dependencies.serviceTransition.read),
            readContract: controlOnly(
              dependencies.serviceTransition.readContract,
            ),
            complete: controlOnly(dependencies.serviceTransition.complete),
            intendRecoveryEffect: controlOnly(
              dependencies.serviceTransition.intendRecoveryEffect,
            ),
            claimRecoveryEffect: controlOnly(
              dependencies.serviceTransition.claimRecoveryEffect,
            ),
            consumeRecoveryEffectPermit: controlOnly(
              dependencies.serviceTransition.consumeRecoveryEffectPermit,
            ),
            validateRecoveryEffectExecution: controlOnly(
              dependencies.serviceTransition.validateRecoveryEffectExecution,
            ),
            completeRecoveryEffect: controlOnly(
              dependencies.serviceTransition.completeRecoveryEffect,
            ),
            reconcileRecoveryEffect: controlOnly(
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
