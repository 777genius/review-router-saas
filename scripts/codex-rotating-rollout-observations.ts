export type Sha256Digest = `sha256:${string}`;

export type ProductionWriterObservation = Readonly<{
  observationVersion: 2;
  source: "production-postgresql-writer";
  captureKind: "database-query";
  rehearsal: false;
  databaseIdentity: Readonly<{
    currentDatabase: string;
    serverAddress: string;
    systemIdentifier: string;
  }>;
  callerIdentity: Readonly<{
    id: "release-migration";
    kind: "immutable-release-migration";
    commit: string;
    imageDigest: Sha256Digest;
    databaseRole: string;
    sessionUser: string;
    applicationName: "reviewrouter-release-migration";
  }>;
  drainObservations: readonly Readonly<{
    activeLeases: number;
    fetchedSetups: number;
    pendingIntents: number;
    writerInFlight: number;
    observedAt: string;
  }>[];
}>;

export type WorkflowRunInventoryObservation = Readonly<{
  observationVersion: 1;
  source: "github-actions-api";
  observations: readonly Readonly<{
    observedAt: string;
    runs: readonly Readonly<{
      runId: string;
      status: "queued" | "in_progress";
      workflowSchemaVersion: 1 | 2;
      workflowPath: string;
      headSha: string;
    }>[];
  }>[];
}>;

export type CanaryRuntimeObservation = Readonly<{
  observationVersion: 1;
  source: "canary-runtime";
  disposable: true;
  repositoryFullName: string;
  approvedRepositories: readonly [string];
  flags: Readonly<{
    runtime: "1";
    newWorkAdmission: "1";
    setupIssuance: "1";
  }>;
  runtimeCommit: string;
  runtimeImageDigest: Sha256Digest;
  installerV1Digest: Sha256Digest;
  installerV2Digest: Sha256Digest;
  workflowV2Digest: Sha256Digest;
  runtimePublicationDigest: Sha256Digest;
}>;

export type RolloutObservationBundle = Readonly<{
  version: 2;
  artifacts: Readonly<{
    database: SourceBoundArtifactDescriptor;
    compatibilityProbe: SourceBoundArtifactDescriptor;
    deployments: ArtifactDescriptor;
    events: ArtifactDescriptor;
    canaryRuntime: ArtifactDescriptor;
    workflowRuns: ArtifactDescriptor;
  }>;
}>;

type ArtifactDescriptor = Readonly<{ path: string; sha256: string }>;
type SourceBoundArtifactDescriptor = ArtifactDescriptor &
  Readonly<{ sourceFile: string; sourceFileSha256: string }>;
