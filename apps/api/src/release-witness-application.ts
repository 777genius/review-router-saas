import type {
  CleanupEvidencePort,
  CleanupObservationSeedPort,
  ReleaseAuthorityMutationReadinessPort,
  RenderCleanupObservationPort,
  ReleaseWitnessAttestation,
  ReleaseWitnessDatabasePort,
  ReleaseWitnessDeploymentPort,
  ReleaseWitnessExecutionPort,
  ReleaseWitnessGenerationPort,
  ReleaseWitnessRequest,
  ReleaseWitnessRuntimeIdentity,
  ReleaseWitnessSignerPort,
  TrustedReleaseWitnessPolicy,
} from "./release-witness-domain.js";
import {
  releaseWitnessPolicyIsCanonical,
  releaseWitnessRequestIsCanonical,
} from "./release-witness-domain.js";
import { sha256Canonical } from "@reviewrouter/features-release-rollout";
import { runtimeDatabaseIdentityEquals } from "./release-authority/domain/database-identity.js";

export class ObserveRunnerCleanup {
  constructor(
    private readonly seeds: CleanupObservationSeedPort,
    private readonly render: RenderCleanupObservationPort,
    private readonly evidence: CleanupEvidencePort,
    private readonly readiness: ReleaseAuthorityMutationReadinessPort,
  ) {}

  async execute(jobId: string): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(jobId))
      throw Object.assign(new Error("release_witness_job_identity_invalid"), {
        statusCode: 400,
      });
    await this.readiness.assertOrdinary();
    const seed = await this.seeds.load(jobId);
    if (seed.jobId !== jobId)
      throw new Error("release_witness_seed_identity_mismatch");
    const evidence = await this.render.observe(seed);
    // Re-observe immediately before the mutation so degradation during the
    // provider read cannot be bypassed by a request admitted while healthy.
    await this.readiness.assertForceNew();
    await this.evidence.persist(jobId, evidence);
  }
}

const digest = (value: unknown): string => `sha256:${sha256Canonical(value)}`;

/**
 * Independent, read-only decision service. Selectors from the caller never
 * become facts: GitHub, provider and three database sessions re-observe them.
 */
export class AttestReleaseWitnessBinding {
  private readonly runtimeIdentity: ReleaseWitnessRuntimeIdentity;

  constructor(
    private readonly databases: ReleaseWitnessDatabasePort,
    private readonly execution: ReleaseWitnessExecutionPort,
    private readonly deployments: ReleaseWitnessDeploymentPort,
    private readonly generations: ReleaseWitnessGenerationPort,
    private readonly signer: ReleaseWitnessSignerPort,
    private readonly policy: TrustedReleaseWitnessPolicy,
    runtimeIdentity: ReleaseWitnessRuntimeIdentity,
    private readonly now: () => Date = () => new Date(),
    private readonly readiness?: ReleaseAuthorityMutationReadinessPort,
  ) {
    if (!releaseWitnessPolicyIsCanonical(policy))
      throw new Error("release_witness_policy_invalid");
    if (
      !/^[a-f0-9]{40}$/u.test(runtimeIdentity.deploymentRevision) ||
      !/^sha256:[a-f0-9]{64}$/u.test(runtimeIdentity.artifactDigest)
    )
      throw new Error("release_witness_runtime_identity_invalid");
    this.runtimeIdentity = Object.freeze({ ...runtimeIdentity });
  }

  async execute(
    request: ReleaseWitnessRequest,
  ): Promise<ReleaseWitnessAttestation> {
    if (!releaseWitnessRequestIsCanonical(request))
      throw Object.assign(
        new Error("release_witness_binding_request_invalid"),
        {
          statusCode: 400,
        },
      );
    if (
      request.execution.repository !== this.policy.repository ||
      request.execution.workflowPath !== this.policy.workflowPath ||
      digest(request.source) !== digest(this.policy.sourceGeneration) ||
      digest(request.target) !== digest(this.policy.targetGeneration)
    )
      throw new Error("release_witness_execution_policy_mismatch");

    const startedAt = this.now().getTime();
    const [execution, deployments, generations] = await Promise.all([
      this.execution.observe(request.execution, request.rolloutId),
      this.deployments.observe(request.deployments),
      this.generations.observe(request.source, request.target),
    ]);
    // This is the publication boundary: the independent witness gate may not
    // reuse evidence which began before the provider facts above were read.
    await this.readiness?.assertForceNew();
    const [source, authority, target] = await Promise.all([
      this.databases.observeSource(),
      this.databases.observeAuthority(),
      this.databases.observeTarget(),
    ]);
    const observedAtMilliseconds = this.now().getTime();
    if (
      !Number.isFinite(startedAt) ||
      !Number.isFinite(observedAtMilliseconds) ||
      observedAtMilliseconds < startedAt ||
      observedAtMilliseconds - startedAt > this.policy.maximumAgeMilliseconds
    )
      throw new Error("release_witness_observation_stale");
    if (
      digest(execution) !== digest(request.execution) ||
      digest(deployments) !== digest(request.deployments) ||
      digest(generations) !== digest([request.source, request.target])
    )
      throw new Error("release_witness_provider_binding_mismatch");
    if (
      source.roleName !== "reviewrouter_release_witness" ||
      authority.roleName !== "reviewrouter_release_witness" ||
      target.roleName !== "reviewrouter_activation_receipt_reader" ||
      !runtimeDatabaseIdentityEquals(
        source.databaseIdentity,
        this.policy.sourceDatabaseIdentity,
      ) ||
      !runtimeDatabaseIdentityEquals(
        authority.databaseIdentity,
        this.policy.authorityDatabaseIdentity,
      ) ||
      !runtimeDatabaseIdentityEquals(
        target.databaseIdentity,
        this.policy.targetDatabaseIdentity,
      ) ||
      source.systemIdentifier !== request.source.systemIdentifier ||
      source.postgresMajor !== request.source.majorVersion ||
      source.databaseIdentity.databaseName !== request.source.databaseName ||
      authority.systemIdentifier !==
        this.policy.authorityDatabaseIdentity.serverIdentity ||
      target.systemIdentifier !== request.target.systemIdentifier ||
      target.postgresMajor !== request.target.majorVersion ||
      target.databaseIdentity.databaseName !== request.target.databaseName ||
      !authority.exact ||
      !target.exact ||
      authority.catalogFingerprint !==
        this.policy.authorityCatalogFingerprint ||
      authority.catalogVerifier !== this.policy.authorityCatalogVerifier ||
      authority.migrationManifestIdentity !==
        this.policy.authorityMigrationManifestIdentity ||
      target.activationMigrationManifestIdentity !==
        this.policy.activationMigrationManifestIdentity ||
      target.activationNamespaceFingerprint !==
        this.policy.activationNamespaceFingerprint ||
      target.installerRoutineBodySha256 !==
        this.policy.installerRoutineBodySha256 ||
      target.readerRoutineBodySha256 !== this.policy.readerRoutineBodySha256
    )
      throw new Error("release_witness_database_binding_mismatch");

    const observedAt = new Date(observedAtMilliseconds).toISOString();
    const expiresAt = new Date(
      observedAtMilliseconds + this.policy.maximumAgeMilliseconds,
    ).toISOString();
    const unsigned = Object.freeze({
      schemaVersion: 2 as const,
      rolloutId: request.rolloutId,
      deploymentRevision: this.runtimeIdentity.deploymentRevision,
      artifactDigest: this.runtimeIdentity.artifactDigest,
      execution,
      sourceDatabaseIdentity: source.databaseIdentity,
      authorityDatabaseIdentity: authority.databaseIdentity,
      targetDatabaseIdentity: target.databaseIdentity,
      releaseAuthority: Object.freeze({
        schemaVersion: authority.schemaVersion,
        migrationManifestIdentity: authority.migrationManifestIdentity,
        catalogFingerprint: authority.catalogFingerprint,
        catalogVerifier: authority.catalogVerifier,
      }),
      activation: Object.freeze({
        migrationManifestIdentity: target.activationMigrationManifestIdentity,
        namespaceFingerprint: target.activationNamespaceFingerprint,
        installerRoutineBodySha256: target.installerRoutineBodySha256,
        readerRoutineBodySha256: target.readerRoutineBodySha256,
      }),
      source: request.source,
      target: request.target,
      deployments: Object.freeze([...deployments]),
      observedAt,
      expiresAt,
    });
    const bindingSha256 = digest(unsigned);
    return Object.freeze({
      ...unsigned,
      bindingSha256,
      signature: Object.freeze(this.signer.sign(bindingSha256)),
    });
  }
}
