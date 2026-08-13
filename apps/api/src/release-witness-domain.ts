export type CleanupObservationSeed = Readonly<{
  jobId: string;
  serviceId: string;
  cleanupCanary: string;
  observedAt: string;
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
