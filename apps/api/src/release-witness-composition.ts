import Fastify, { type FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import type { PrismaClient } from "@reviewrouter/platform-db";
import { observeReleaseAuthorityDatabaseReadiness } from "./release-authority/adapters/postgres-readiness.js";
import {
  releaseAuthoritySchemaIsReady,
  type ReleaseAuthorityDatabaseReadiness,
} from "./release-authority/application/readiness.js";
import {
  defaultReadinessTimingPolicy,
  DefinitiveAttestationMismatchError,
  ReleaseAuthorityAttestationCoordinator,
  validateReadinessTimingPolicy,
  type MonotonicScheduler,
  type ReadinessTimingPolicy,
} from "./release-authority/application/attestation-lease.js";
import {
  createReleaseAuthorityAttestationSubject,
  ReleaseAuthorityServiceKind,
} from "./release-authority/domain/attestation-subject.js";
import { releaseAuthorityCatalogVerifier } from "./release-authority/domain/readiness-contract.mjs";
import {
  AttestReleaseWitnessBinding,
  ObserveRunnerCleanup,
} from "./release-witness-application.js";
import type {
  ReleaseAuthorityMutationReadinessPort,
  TrustedReleaseWitnessPolicy,
} from "./release-witness-domain.js";
import {
  runtimeDatabaseIdentityEquals,
  type RuntimeDatabaseIdentity,
} from "./release-authority/domain/database-identity.js";
import {
  PostgresCleanupObservationAdapter,
  PostgresReleaseBindingObservationAdapter,
  GitHubReleaseExecutionObservationAdapter,
  RenderReleaseDeploymentObservationAdapter,
  Ed25519ReleaseWitnessSignerAdapter,
  RenderCleanupObservationAdapter,
} from "./release-witness-adapters.js";
import { registerReleaseWitnessRoutes } from "./release-witness-routes.js";
import { canonicalActivationCatalogPolicyDigests } from "@reviewrouter/features-release-rollout";

export async function createReleaseWitnessApp(input: {
  readonly witnessPrisma: PrismaClient;
  readonly triggerTokenSha256: string;
  readonly renderReadToken: string;
  readonly renderFetch?: typeof fetch;
  readonly readinessObserver?: (
    prisma: PrismaClient,
    options?: Readonly<{
      signal?: AbortSignal;
      poolWaitMilliseconds?: number;
      lockTimeoutMilliseconds?: number;
      statementTimeoutMilliseconds?: number;
      transactionTimeoutMilliseconds?: number;
    }>,
  ) => Promise<ReleaseAuthorityDatabaseReadiness>;
  readonly readinessPolicy?: Partial<ReadinessTimingPolicy>;
  readonly readinessScheduler?: MonotonicScheduler;
  readonly deploymentRevision?: string;
  readonly artifactDigest?: string;
  readonly authorityOwnerRoleName?: string;
  readonly activationGuardRoleName?: string;
  readonly mutationReadiness?: ReleaseAuthorityMutationReadinessPort;
  readonly trustedDatabaseIdentity?: RuntimeDatabaseIdentity;
  readonly sourceWitnessPrisma?: PrismaClient;
  readonly targetWitnessPrisma?: PrismaClient;
  readonly githubReadToken?: string;
  readonly githubFetch?: typeof fetch;
  readonly trustedBindingPolicy?: TrustedReleaseWitnessPolicy;
  readonly signingKeyId?: string;
  readonly signingPrivateKeyPem?: string;
}): Promise<FastifyInstance> {
  if (!/^[a-f0-9]{64}$/u.test(input.triggerTokenSha256))
    throw new Error("release_witness_credential_hash_invalid");
  const readinessPolicyOptions = validateReadinessTimingPolicy({
    ...defaultReadinessTimingPolicy,
    ...input.readinessPolicy,
  });
  const postgres = new PostgresCleanupObservationAdapter(
    input.witnessPrisma,
    input.trustedDatabaseIdentity
      ? {
          roleName: "reviewrouter_release_witness",
          databaseIdentity: input.trustedDatabaseIdentity,
          postgresMajor: 17,
        }
      : undefined,
    {
      maxWaitMilliseconds: readinessPolicyOptions.poolWaitMilliseconds,
      transactionTimeoutMilliseconds:
        readinessPolicyOptions.transactionTimeoutMilliseconds,
    },
  );
  const observeAuthority = async (signal: AbortSignal): Promise<void> => {
    const readiness = await (
      input.readinessObserver ?? observeReleaseAuthorityDatabaseReadiness
    )(input.witnessPrisma, {
      signal,
      poolWaitMilliseconds: readinessPolicyOptions.poolWaitMilliseconds,
      lockTimeoutMilliseconds: readinessPolicyOptions.lockTimeoutMilliseconds,
      statementTimeoutMilliseconds:
        readinessPolicyOptions.statementTimeoutMilliseconds,
      transactionTimeoutMilliseconds:
        readinessPolicyOptions.transactionTimeoutMilliseconds,
    });
    if (
      readiness.roleName !== "reviewrouter_release_witness" ||
      readiness.postgresMajor !== 17 ||
      !input.trustedDatabaseIdentity ||
      !runtimeDatabaseIdentityEquals(
        readiness.databaseIdentity,
        input.trustedDatabaseIdentity,
      ) ||
      !releaseAuthoritySchemaIsReady(readiness)
    )
      throw new DefinitiveAttestationMismatchError();
  };
  const trustedDatabaseIdentity = input.trustedDatabaseIdentity;
  if (!trustedDatabaseIdentity)
    throw new Error("release_witness_trusted_database_identity_missing");
  const policy = input.trustedBindingPolicy;
  const subject = createReleaseAuthorityAttestationSubject({
    serviceKind: ReleaseAuthorityServiceKind.Witness,
    deploymentRevision: input.deploymentRevision ?? "",
    artifactDigest: input.artifactDigest ?? "",
    catalogContractId:
      policy?.authorityCatalogVerifier ?? releaseAuthorityCatalogVerifier,
    expectedDatabases: [
      {
        roleName: "reviewrouter_release_witness",
        identity: trustedDatabaseIdentity,
      },
    ],
    requiredRoles: [
      "reviewrouter_release_control",
      "reviewrouter_provider_authority",
      "reviewrouter_release_witness",
      input.authorityOwnerRoleName ?? "",
      "reviewrouter_activation_permit_installer",
      "reviewrouter_activation_receipt_reader",
      input.activationGuardRoleName ?? "",
    ],
    authorityOwnerRoleName: input.authorityOwnerRoleName ?? "",
    activationGuardRoleName: input.activationGuardRoleName ?? "",
    routineBodyRoots: {
      installerSha256: policy?.installerRoutineBodySha256
        ? `sha256:${policy.installerRoutineBodySha256}`
        : `sha256:${"0".repeat(64)}`,
      readerSha256: policy?.readerRoutineBodySha256
        ? `sha256:${policy.readerRoutineBodySha256}`
        : `sha256:${"0".repeat(64)}`,
    },
    migrationManifestIdentity: policy
      ? `sha256:${createHash("sha256")
          .update(
            JSON.stringify([
              policy.authorityMigrationManifestIdentity,
              policy.activationMigrationManifestIdentity,
            ]),
          )
          .digest("hex")}`
      : `sha256:${createHash("sha256").update(releaseAuthorityCatalogVerifier).digest("hex")}`,
    activationFingerprint:
      policy?.activationNamespaceFingerprint ?? `sha256:${"0".repeat(64)}`,
    activationCatalogPolicies: canonicalActivationCatalogPolicyDigests,
  });
  const readiness = new ReleaseAuthorityAttestationCoordinator(
    (_subject, signal) => observeAuthority(signal),
    () =>
      Object.assign(new Error("release_witness_readiness_unavailable"), {
        statusCode: 503,
      }),
    readinessPolicyOptions,
    input.readinessScheduler,
  );
  const assertAuthorityReady = () => readiness.assertOrdinary(subject);
  const forceNewAuthority = () => readiness.forceNew(subject);
  const observeCleanup = new ObserveRunnerCleanup(
    postgres,
    new RenderCleanupObservationAdapter(
      input.renderReadToken,
      input.renderFetch,
    ),
    postgres,
    input.mutationReadiness ?? {
      assertOrdinary: assertAuthorityReady,
      assertForceNew: forceNewAuthority,
    },
  );
  const bindingInputs = [
    input.sourceWitnessPrisma,
    input.targetWitnessPrisma,
    input.githubReadToken,
    input.trustedBindingPolicy,
    input.signingKeyId,
    input.signingPrivateKeyPem,
  ];
  if (
    bindingInputs.some(Boolean) &&
    !bindingInputs.every((value) => value !== undefined && value !== "")
  )
    throw new Error("release_witness_binding_composition_incomplete");
  const attestBinding =
    input.sourceWitnessPrisma &&
    input.targetWitnessPrisma &&
    input.githubReadToken &&
    input.trustedBindingPolicy
      ? (() => {
          const providerObservation =
            new RenderReleaseDeploymentObservationAdapter(
              input.renderReadToken,
              input.renderFetch,
            );
          return new AttestReleaseWitnessBinding(
            new PostgresReleaseBindingObservationAdapter(
              input.sourceWitnessPrisma,
              input.witnessPrisma,
              input.targetWitnessPrisma,
              input.readinessObserver,
            ),
            new GitHubReleaseExecutionObservationAdapter(
              input.githubReadToken,
              input.githubFetch,
            ),
            providerObservation,
            providerObservation,
            new Ed25519ReleaseWitnessSignerAdapter(
              input.signingKeyId!,
              input.signingPrivateKeyPem!,
            ),
            input.trustedBindingPolicy,
            {
              deploymentRevision: input.deploymentRevision ?? "",
              artifactDigest: input.artifactDigest ?? "",
            },
            undefined,
            {
              assertOrdinary: assertAuthorityReady,
              assertForceNew: forceNewAuthority,
            },
          );
        })()
      : undefined;
  const app = Fastify({ logger: false });
  app.get("/health", async (_request, reply) => {
    if (readiness.state(subject).status === "ready")
      return { status: "ok", service: "release-witness" };
    return reply.code(503).send({
      status: "degraded",
      service: "release-witness",
      reason: "database_unavailable",
    });
  });
  app.addHook("onReady", () => readiness.startInitial(subject));
  app.addHook("onClose", () => readiness.close());
  await registerReleaseWitnessRoutes(app, {
    observeCleanup,
    ...(attestBinding ? { attestBinding } : {}),
    triggerTokenSha256: input.triggerTokenSha256,
  });
  return app;
}
