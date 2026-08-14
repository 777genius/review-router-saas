import { createHash, createPrivateKey, sign } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  executeSameConnectionFenced,
  type SameConnectionIdentityExpectation,
  type SameConnectionTransactionTiming,
} from "./release-authority/adapters/same-connection-fence.js";
import type { PrismaClient } from "@reviewrouter/platform-db";
import {
  RenderApiAdapter,
  sha256Canonical,
  type RenderFetch,
} from "@reviewrouter/features-release-rollout";
import type {
  CleanupEvidencePort,
  CleanupObservationSeed,
  CleanupObservationSeedPort,
  NormalizedCleanupEvidence,
  ProviderTerminalStatus,
  RenderCleanupObservationPort,
  ReleaseWitnessDatabaseObservation,
  ReleaseWitnessDatabasePort,
  ReleaseWitnessDeployment,
  ReleaseWitnessDeploymentPort,
  ReleaseWitnessExecution,
  ReleaseWitnessExecutionPort,
  ReleaseWitnessGenerationObservation,
  ReleaseWitnessGeneration,
  ReleaseWitnessGenerationPort,
  ReleaseWitnessSignerPort,
} from "./release-witness-domain.js";
import { assertCleanupProviderTemporalContract } from "./release-witness-domain.js";
import { observeReleaseAuthorityDatabaseReadiness } from "./release-authority/adapters/postgres-readiness.js";
import {
  releaseAuthoritySchemaIsReady,
  type ReleaseAuthorityDatabaseReadiness,
} from "./release-authority/application/readiness.js";

const safePath =
  /^\/runner\/_work\/rr-[A-Za-z0-9][A-Za-z0-9._-]{1,125}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,127})*$/u;
const providerTerminalStatuses = new Set<ProviderTerminalStatus>([
  "succeeded",
  "failed",
  "canceled",
]);
const isProviderTerminalStatus = (
  status: string,
): status is ProviderTerminalStatus =>
  providerTerminalStatuses.has(status as ProviderTerminalStatus);
const timestamp = (value: string): number => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw new Error("release_witness_timestamp_invalid");
  return parsed;
};
const firstValue = (rows: unknown): unknown =>
  Array.isArray(rows) &&
  rows.length === 1 &&
  rows[0] &&
  typeof rows[0] === "object"
    ? (rows[0] as { value?: unknown }).value
    : undefined;

export class PostgresCleanupObservationAdapter
  implements CleanupObservationSeedPort, CleanupEvidencePort
{
  constructor(
    private readonly prisma: PrismaClient,
    private readonly fence?: SameConnectionIdentityExpectation,
    private readonly timing?: SameConnectionTransactionTiming,
  ) {}

  private query<T>(query: Prisma.Sql): Promise<T> {
    return this.fence && typeof this.prisma.$transaction === "function"
      ? executeSameConnectionFenced(
          this.prisma,
          this.fence,
          (connection) => connection.$queryRaw<T>(query),
          this.timing,
        )
      : this.prisma.$queryRaw<T>(query);
  }

  async load(jobId: string): Promise<CleanupObservationSeed> {
    const value = firstValue(
      await this.query(
        Prisma.sql`SELECT release_authority.release_runner_cleanup_observation_seed(${jobId}) AS value`,
      ),
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("release_witness_seed_missing");
    const seed = value as Record<string, unknown>;
    if (
      typeof seed.jobId !== "string" ||
      typeof seed.serviceId !== "string" ||
      typeof seed.cleanupCanary !== "string" ||
      typeof seed.observedAt !== "string" ||
      typeof seed.providerCreationNotBefore !== "string"
    )
      throw new Error("release_witness_seed_invalid");
    return seed as CleanupObservationSeed;
  }

  async persist(
    jobId: string,
    evidence: NormalizedCleanupEvidence,
  ): Promise<void> {
    const value = firstValue(
      await this.query(
        Prisma.sql`SELECT release_authority.release_runner_persist_cleanup_witness(
          ${jobId}, ${JSON.stringify(evidence)}::jsonb
        ) AS value`,
      ),
    );
    if (value !== true)
      throw new Error("release_witness_evidence_persist_failed");
  }
}

export class RenderCleanupObservationAdapter implements RenderCleanupObservationPort {
  private readonly api: RenderApiAdapter;

  constructor(token: string, fetchImpl: RenderFetch = fetch) {
    if (!token) throw new Error("release_witness_render_credential_missing");
    this.api = new RenderApiAdapter(token, fetchImpl);
  }

  async observe(
    seed: CleanupObservationSeed,
  ): Promise<NormalizedCleanupEvidence> {
    const job = await this.api.getJob(seed.serviceId, seed.jobId);
    if (
      job.id !== seed.jobId ||
      job.serviceId !== seed.serviceId ||
      !isProviderTerminalStatus(job.status) ||
      !job.createdAt ||
      !job.finishedAt
    )
      throw new Error("release_witness_terminal_job_invalid");
    const { createdAt, finishedAt } = assertCleanupProviderTemporalContract({
      seed,
      providerCreatedAt: job.createdAt,
      providerFinishedAt: job.finishedAt,
    });

    const service = await this.api.getService(seed.serviceId);
    if (service.id !== seed.serviceId)
      throw new Error("release_witness_service_identity_mismatch");
    const logs = await this.api.listLogs({
      ownerId: service.ownerId,
      resourceId: seed.serviceId,
      startTime: job.createdAt,
      endTime: job.finishedAt,
    });
    const receipts = logs.flatMap((log) => {
      try {
        const parsed = JSON.parse(log.message) as {
          canary?: unknown;
          cleanup?: { removedPaths?: unknown; remainingPaths?: unknown };
        };
        return parsed.canary === seed.cleanupCanary && parsed.cleanup
          ? [{ log, cleanup: parsed.cleanup }]
          : [];
      } catch {
        return [];
      }
    });
    if (receipts.length !== 1)
      throw new Error("release_witness_cleanup_log_ambiguous");
    const receipt = receipts[0]!;
    const removedPaths = receipt.cleanup.removedPaths;
    const remainingPaths = receipt.cleanup.remainingPaths;
    const observedAt = timestamp(receipt.log.timestamp);
    if (
      observedAt < createdAt ||
      observedAt > finishedAt ||
      !Array.isArray(removedPaths) ||
      removedPaths.length === 0 ||
      removedPaths.some(
        (path) => typeof path !== "string" || !safePath.test(path),
      ) ||
      !Array.isArray(remainingPaths) ||
      remainingPaths.length !== 0
    )
      throw new Error("release_witness_cleanup_log_invalid");

    return Object.freeze({
      jobId: seed.jobId,
      canary: seed.cleanupCanary,
      providerStatus: job.status,
      containerTerminated: true,
      logSha256: `sha256:${createHash("sha256")
        .update(receipt.log.message)
        .digest("hex")}`,
      removedPaths: Object.freeze([...removedPaths]) as readonly string[],
      remainingPaths: Object.freeze([]) as readonly [],
      providerLogId: receipt.log.id,
      providerCreatedAt: job.createdAt,
      providerObservedAt: receipt.log.timestamp,
    });
  }
}

type TransactionalPrisma = PrismaClient & {
  $transaction<T>(
    callback: (transaction: PrismaClient) => Promise<T>,
  ): Promise<T>;
};

const manifestIdentity = (value: unknown): string =>
  `sha256:${sha256Canonical(value)}`;

/** Every observation is pinned to one transaction/session to prevent pool mixing. */
export class PostgresReleaseBindingObservationAdapter implements ReleaseWitnessDatabasePort {
  constructor(
    private readonly sourcePrisma: PrismaClient,
    private readonly authorityPrisma: PrismaClient,
    private readonly targetPrisma: PrismaClient,
    private readonly readinessObserver = observeReleaseAuthorityDatabaseReadiness,
  ) {}

  async observeSource(): Promise<ReleaseWitnessGenerationObservation> {
    return (this.sourcePrisma as TransactionalPrisma).$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
        );
        const rows = await tx.$queryRaw<ReleaseWitnessGenerationObservation[]>(
          Prisma.sql`SELECT current_user AS "roleName",
          jsonb_build_object(
            'serverIdentity', (SELECT system_identifier::text FROM pg_control_system()),
            'databaseIdentity', (SELECT oid::text FROM pg_database WHERE datname=current_database()),
            'databaseName', current_database()
          ) AS "databaseIdentity",
          (SELECT system_identifier::text FROM pg_control_system()) AS "systemIdentifier",
          current_setting('server_version_num')::integer / 10000 AS "postgresMajor"`,
        );
        if (rows.length !== 1 || !rows[0])
          throw new Error("release_witness_source_observation_unavailable");
        return Object.freeze(rows[0]);
      },
    );
  }

  observeAuthority(): Promise<ReleaseWitnessDatabaseObservation> {
    return this.observeReadiness(this.authorityPrisma, "authority");
  }

  observeTarget(): Promise<ReleaseWitnessDatabaseObservation> {
    return this.observeReadiness(this.targetPrisma, "target");
  }

  private async observeReadiness(
    prisma: PrismaClient,
    kind: "authority" | "target",
  ): Promise<ReleaseWitnessDatabaseObservation> {
    const readiness = await this.readinessObserver(prisma);
    return normalizeDatabaseObservation(readiness, kind);
  }
}

const normalizeDatabaseObservation = (
  value: ReleaseAuthorityDatabaseReadiness,
  kind: "authority" | "target",
): ReleaseWitnessDatabaseObservation =>
  Object.freeze({
    roleName: value.roleName,
    databaseIdentity: value.databaseIdentity,
    systemIdentifier: value.systemIdentifier,
    postgresMajor: value.postgresMajor,
    schemaVersion: value.schemaVersion,
    migrationManifestIdentity: manifestIdentity(value.migrationManifest),
    catalogFingerprint: value.catalogFingerprint,
    catalogVerifier: value.catalogVerifier,
    activationMigrationManifestIdentity:
      value.applicationMigrationManifestIdentity,
    activationNamespaceFingerprint: value.activationNamespaceFingerprint,
    installerRoutineBodySha256: value.installerRoutineBodySha256,
    readerRoutineBodySha256: value.readerRoutineBodySha256,
    exact:
      kind === "authority"
        ? releaseAuthoritySchemaIsReady(value)
        : value.postgresMajor === 17 &&
          value.readerRoutine &&
          value.installerRoutine &&
          value.activationGuardExact &&
          value.activationRuntimePrivilegesExact,
  });

export class GitHubReleaseExecutionObservationAdapter implements ReleaseWitnessExecutionPort {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!token) throw new Error("release_witness_github_credential_missing");
  }

  async observe(
    expected: ReleaseWitnessExecution,
    rolloutId: string,
  ): Promise<ReleaseWitnessExecution> {
    const response = await this.fetchImpl(
      `https://api.github.com/repos/${expected.repository}/actions/runs/${expected.runId}`,
      {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!response.ok)
      throw new Error("release_witness_github_observation_unavailable");
    const run = (await response.json()) as Record<string, unknown>;
    if (
      String(run.id) !== expected.runId ||
      (run.repository as { full_name?: unknown } | undefined)?.full_name !==
        expected.repository ||
      run.path !== expected.workflowPath ||
      run.head_sha !== expected.commitSha ||
      `refs/heads/${String(run.head_branch)}` !== expected.workflowRef ||
      run.run_attempt !== expected.runAttempt ||
      run.event !== "workflow_dispatch" ||
      run.status !== "in_progress" ||
      run.conclusion != null ||
      run.display_title !== `private-pg17:${rolloutId}`
    )
      throw new Error("release_witness_github_execution_mismatch");
    return Object.freeze({ ...expected });
  }
}

export class RenderReleaseDeploymentObservationAdapter
  implements ReleaseWitnessDeploymentPort, ReleaseWitnessGenerationPort
{
  private readonly api: RenderApiAdapter;
  constructor(token: string, fetchImpl: RenderFetch = fetch) {
    if (!token) throw new Error("release_witness_render_credential_missing");
    this.api = new RenderApiAdapter(token, fetchImpl);
  }

  async observe(
    source: ReleaseWitnessGeneration,
    target: ReleaseWitnessGeneration,
  ): Promise<readonly [ReleaseWitnessGeneration, ReleaseWitnessGeneration]>;
  async observe(
    expected: readonly ReleaseWitnessDeployment[],
  ): Promise<readonly ReleaseWitnessDeployment[]>;

  async observe(
    first: readonly ReleaseWitnessDeployment[] | ReleaseWitnessGeneration,
    second?: ReleaseWitnessGeneration,
  ): Promise<
    | readonly ReleaseWitnessDeployment[]
    | readonly [ReleaseWitnessGeneration, ReleaseWitnessGeneration]
  > {
    if (!Array.isArray(first) && second) {
      const generations = [first as ReleaseWitnessGeneration, second] as const;
      const observed = await Promise.all(
        generations.map(async (expected) => {
          const database = await (
            this.api as RenderApiAdapter & {
              getPostgres(id: string): Promise<{
                id: string;
                version: string;
              }>;
            }
          ).getPostgres(expected.renderResourceId);
          if (
            database.id !== expected.renderResourceId ||
            String(database.version).split(".")[0] !==
              String(expected.majorVersion)
          )
            throw new Error("release_witness_render_generation_mismatch");
          return Object.freeze({ ...expected });
        }),
      );
      return Object.freeze(observed) as readonly [
        ReleaseWitnessGeneration,
        ReleaseWitnessGeneration,
      ];
    }
    if (!Array.isArray(first))
      throw new Error("release_witness_render_generation_invalid");
    const expected = first;
    return Object.freeze(
      await Promise.all(
        expected.map(async (item) => {
          const [service, deploy] = await Promise.all([
            this.api.getService(item.serviceId),
            this.api.getDeploy(item.serviceId, item.deployId),
          ]);
          if (
            service.id !== item.serviceId ||
            deploy.id !== item.deployId ||
            deploy.status !== "live" ||
            !(
              (deploy.commit?.id === item.revision &&
                deploy.image === undefined) ||
              (deploy.image?.sha === item.revision &&
                deploy.commit === undefined)
            )
          )
            throw new Error("release_witness_render_deployment_mismatch");
          return Object.freeze({ ...item });
        }),
      ),
    );
  }
}

export class Ed25519ReleaseWitnessSignerAdapter implements ReleaseWitnessSignerPort {
  private readonly key;
  constructor(
    private readonly keyId: string,
    privateKeyPem: string,
  ) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(keyId))
      throw new Error("release_witness_signing_key_id_invalid");
    this.key = createPrivateKey(privateKeyPem);
    if (this.key.asymmetricKeyType !== "ed25519")
      throw new Error("release_witness_signing_key_invalid");
  }

  sign(bindingSha256: string) {
    return Object.freeze({
      algorithm: "Ed25519" as const,
      keyId: this.keyId,
      value: sign(null, Buffer.from(bindingSha256, "utf8"), this.key).toString(
        "base64",
      ),
    });
  }
}
