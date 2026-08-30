import type {
  VersionedProviderSecretNamespace,
  VersionedSecretWorkflowSourceAttestation,
} from "@reviewrouter/features-codex-oauth-rotating";

export type CodexRotatingWorkflowReattestationRequest = Readonly<{
  claimId: string;
  attemptId: string;
  expectedGenerationHash: string;
  repositoryId: string;
  workflowPath: string;
  namespace: VersionedProviderSecretNamespace;
}>;

export type CodexRotatingWorkflowReattestationTransition = Readonly<{
  target: CodexRotatingWorkflowReattestationRequest;
  expectedCurrent: VersionedSecretWorkflowSourceAttestation;
  replacement: VersionedSecretWorkflowSourceAttestation;
  compatibilityWindowSeconds: number;
}>;

/** Reads the durable evidence currently bound to the active namespace. */
export interface CodexRotatingCurrentWorkflowAttestationPort {
  readActiveWorkflowAttestation(
    namespace: VersionedProviderSecretNamespace,
  ): Promise<VersionedSecretWorkflowSourceAttestation | null>;
}

/** Reads and verifies workflow evidence at the repository's default branch. */
export interface CodexRotatingDefaultWorkflowSourcePort {
  /** Re-reads repository identity and the exact default-branch ref head. */
  readDefaultSourceIdentity(): Promise<
    Readonly<{
      repositoryId: string;
      repositoryFullName: string;
      defaultBranch: string;
      headCommitSha: string;
    }>
  >;
  readVerifiedWorkflowAt(input: {
    readonly commitSha: string;
    readonly expectedSchemaVersion: 4 | 5;
  }): Promise<VersionedSecretWorkflowSourceAttestation>;
}

/** Performs the final compare-and-swap under the provider transaction lock. */
export interface CodexRotatingWorkflowReattestationPersistencePort {
  /** Linearizes an idempotent V5 success under the provider mutation fence. */
  validateActiveWorkflowSource(
    input: Readonly<{
      target: CodexRotatingWorkflowReattestationRequest;
      expectedCurrent: VersionedSecretWorkflowSourceAttestation;
      verifiedActive: VersionedSecretWorkflowSourceAttestation;
    }>,
  ): Promise<{ readonly status: "active" }>;

  replaceActiveWorkflowSource(
    transition: CodexRotatingWorkflowReattestationTransition,
  ): Promise<{ readonly status: "active" }>;
}
