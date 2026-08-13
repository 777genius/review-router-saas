export type Sha256Digest = `sha256:${string}`;

export const supportedWorkflowSchemaVersions = [1, 2, 3, 4] as const;
export type SupportedWorkflowSchemaVersion =
  (typeof supportedWorkflowSchemaVersions)[number];

type ProductionDatabaseIdentity = Readonly<{
  currentDatabase: string;
  currentSchema: "public";
  serverAddress: string;
  systemIdentifier: string;
}>;

type HistoricalMigrationReceipt = Readonly<{
  receiptVersion: 2;
  artifactDigest: Sha256Digest;
  artifactId: string;
  rolloutId: string;
  runId: string;
  claimedAt: string;
}>;

type GenerationBoundMigrationReceipt = Readonly<{
  receiptVersion: 4;
  artifactDigest: Sha256Digest;
  artifactId: string;
  rolloutId: string;
  runId: string;
  runAttempt: number;
  jobId: string;
  workflowPath: ".github/workflows/codex-rotating-release-migration.yml";
  commit: string;
  imageDigest: Sha256Digest;
  systemIdentifier: string;
  recoveryWitnessSha256: string;
  claimedAt: string;
}>;

type AdmittedRecoveryEvidenceSource = Readonly<{
  totalRows: number;
  witnessPresentRows: number;
  incarnationPresentRows: number;
  witnessFingerprints: readonly string[];
  databaseIncarnations: readonly string[];
}> &
  (
    | Readonly<{
        source: "CodexOAuthSetupPayloadClaim" | "CodexOAuthWritebackIntent";
        incarnationRequired: true;
      }>
    | Readonly<{
        source:
          | "CodexOAuthSecretNamespace"
          | "CodexOAuthSetupManifest"
          | "CodexOAuthSetupRecoveryRequest";
        incarnationRequired: false;
      }>
  );

type PriorTrustedMigrationReceipt = Readonly<{
  receiptVersion: 3;
  artifactDigest: Sha256Digest;
  artifactId: string;
  rolloutId: string;
  runId: string;
  runAttempt: number;
  jobId: string;
  workflowPath: ".github/workflows/codex-rotating-release-migration.yml";
  commit: string;
  imageDigest: Sha256Digest;
  claimedAt: string;
}>;

export type ProductionWriterObservation = Readonly<{
  observationVersion: 5;
  source: "production-postgresql-writer";
  captureKind: "database-query";
  rehearsal: false;
  databaseIdentity: ProductionDatabaseIdentity;
  isWriter: true;
  recoveryWitnessSha256: string;
  databaseGenerationBinding: Readonly<{
    version: 4;
    systemIdentifier: string;
    recoveryWitnessSha256: string;
    consumedMigrationEvidence: readonly (
      | HistoricalMigrationReceipt
      | PriorTrustedMigrationReceipt
      | GenerationBoundMigrationReceipt
    )[];
  }>;
  admittedRecoveryEvidence: Readonly<{
    sources: readonly AdmittedRecoveryEvidenceSource[];
  }>;
  callerIdentity: Readonly<{
    id: "release-migration";
    kind: "trusted-github-release-migration";
    commit: string;
    imageDigest: Sha256Digest;
    databaseRole: "reviewrouter_release_migration";
    sessionUser: "reviewrouter_release_migration";
    platform: "github-actions";
    receiptVersion: 4;
    artifactDigest: Sha256Digest;
    artifactId: string;
    rolloutId: string;
    runId: string;
    runAttempt: number;
    workflowPath: ".github/workflows/codex-rotating-release-migration.yml";
    jobId: string;
    systemIdentifier: string;
    recoveryWitnessSha256: string;
    claimedAt: string;
  }>;
  drainObservations: readonly Readonly<{
    databaseIdentity: ProductionDatabaseIdentity;
    isWriter: true;
    recoveryWitnessSha256: string;
    activeLeases: number;
    fetchedSetups: number;
    pendingIntents: number;
    writerInFlight: number;
    observedAt: string;
  }>[];
}>;

export type WorkflowRunInventoryObservation = Readonly<{
  observationVersion: 2;
  source: "github-actions-api";
  supportedWorkflowSchemaVersions: typeof supportedWorkflowSchemaVersions;
  captureIdentity: CaptureIdentity;
  cohort: Readonly<{
    repositoryId: string;
    repositoryFullName: string;
    workflow: string;
    statuses: readonly ["queued", "in_progress"];
    perPage: 100;
  }>;
  rawResponses: readonly RawApiResponse[];
  observations: readonly Readonly<{
    captureIdentity: CaptureIdentity;
    cohort: WorkflowRunInventoryObservation["cohort"];
    rawResponses: readonly RawApiResponse[];
    observedAt: string;
    inventoriedWorkflowSchemaVersions: typeof supportedWorkflowSchemaVersions;
    runs: readonly Readonly<{
      runId: string;
      status: "queued" | "in_progress";
      workflowSchemaVersion: SupportedWorkflowSchemaVersion;
      workflowPath: string;
      headSha: string;
      event: string;
      repositoryId: string;
      workflowBlobSha: string;
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
    deployments: SourceBoundArtifactDescriptor;
    events: ArtifactDescriptor;
    canaryRuntime: ArtifactDescriptor;
    workflowRuns: SourceBoundArtifactDescriptor;
  }>;
}>;

export type TrustedGitHubExecutionIdentity = Readonly<{
  repositoryId: string;
  repositoryFullName: string;
  workflowPath: `.github/workflows/${string}.yml`;
  workflowSha: string;
  workflowRef: string;
  runId: string;
  runAttempt: number;
  jobId: string;
  jobName: "trusted-release-migration" | "trusted-rollout-evidence";
  artifactName: string;
  headSha: string;
}>;

export type TrustedRolloutArtifact = Readonly<{
  version: 3;
  rolloutId: string;
  execution: TrustedGitHubExecutionIdentity;
  rollout: RolloutObservationBundle;
}>;

type ArtifactDescriptor = Readonly<{ path: string; sha256: string }>;
type SourceBoundArtifactDescriptor = ArtifactDescriptor &
  Readonly<{ sourceFile: string; sourceFileSha256: string }>;

type CaptureIdentity = Readonly<{
  apiHost: string;
  authenticated: true;
  observedAt: string;
  rawResponsesSha256: string;
}> &
  Readonly<Record<string, unknown>>;

type RawApiResponse = Readonly<{
  url: string;
  status: number;
  bodySha256: string;
  body: unknown;
}>;
