export type CleanupObservationSeed = Readonly<{
  jobId: string;
  serviceId: string;
  cleanupCanary: string;
  observedAt: string;
  providerCreationNotBefore: string;
}>;

export type ProviderTerminalStatus = "succeeded" | "failed" | "canceled";

export type NormalizedCleanupEvidence = Readonly<{
  jobId: string;
  canary: string;
  providerStatus: ProviderTerminalStatus;
  containerTerminated: true;
  logSha256: string;
  removedPaths: readonly string[];
  remainingPaths: readonly [];
  providerLogId: string;
  providerCreatedAt: string;
  providerObservedAt: string;
}>;

export interface CleanupObservationSeedPort {
  load(jobId: string): Promise<CleanupObservationSeed>;
}

export interface CleanupEvidencePort {
  persist(jobId: string, evidence: NormalizedCleanupEvidence): Promise<void>;
}

export interface RenderCleanupObservationPort {
  observe(seed: CleanupObservationSeed): Promise<NormalizedCleanupEvidence>;
}

/** Application-facing authority fence; infrastructure owns how readiness is observed. */
export interface ReleaseAuthorityMutationReadinessPort {
  assertReady(): Promise<void>;
}

const instant = (value: string): number => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw new Error("release_witness_timestamp_invalid");
  return parsed;
};

/**
 * Domain temporal contract: the authority's pre-dispatch boundary is the
 * lower bound for provider creation. The later durable observation is only an
 * ordering assertion and never replaces that lower bound.
 */
export function assertCleanupProviderTemporalContract(input: {
  seed: CleanupObservationSeed;
  providerCreatedAt: string;
  providerFinishedAt: string;
}): Readonly<{ createdAt: number; finishedAt: number }> {
  const notBefore = instant(input.seed.providerCreationNotBefore);
  const persistedObservation = instant(input.seed.observedAt);
  const createdAt = instant(input.providerCreatedAt);
  const finishedAt = instant(input.providerFinishedAt);
  if (
    persistedObservation < notBefore ||
    createdAt < notBefore ||
    finishedAt < createdAt
  )
    throw new Error("release_witness_terminal_window_invalid");
  return Object.freeze({ createdAt, finishedAt });
}
