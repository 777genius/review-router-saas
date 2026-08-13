import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@reviewrouter/platform-db";
import {
  RenderApiAdapter,
  type RenderFetch,
} from "@reviewrouter/features-release-rollout";
import type {
  CleanupEvidencePort,
  CleanupObservationSeed,
  CleanupObservationSeedPort,
  NormalizedCleanupEvidence,
  ProviderTerminalStatus,
  RenderCleanupObservationPort,
} from "./release-witness-domain.js";

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
  constructor(private readonly prisma: PrismaClient) {}

  async load(jobId: string): Promise<CleanupObservationSeed> {
    const value = firstValue(
      await this.prisma.$queryRaw(
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
      typeof seed.observedAt !== "string"
    )
      throw new Error("release_witness_seed_invalid");
    return seed as CleanupObservationSeed;
  }

  async persist(
    jobId: string,
    evidence: NormalizedCleanupEvidence,
  ): Promise<void> {
    const value = firstValue(
      await this.prisma.$queryRaw(
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
    const createdAt = timestamp(job.createdAt);
    const finishedAt = timestamp(job.finishedAt);
    if (
      createdAt < timestamp(seed.observedAt) ||
      finishedAt < createdAt ||
      finishedAt > Date.now() + 5 * 60_000
    )
      throw new Error("release_witness_terminal_window_invalid");

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
      providerObservedAt: receipt.log.timestamp,
    });
  }
}
