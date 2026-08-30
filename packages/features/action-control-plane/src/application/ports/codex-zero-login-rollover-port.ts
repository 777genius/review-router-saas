import type { VersionedProviderSecretNamespace } from "@reviewrouter/features-codex-oauth-rotating";
import type { ActionRepositoryContext } from "../../domain/action-control-plane.js";
import type { CodexRotatingEncryptedWritebackRequest } from "@reviewrouter/features-codex-oauth-rotating";
import type { VersionedSecretWorkflowSourceAttestation } from "@reviewrouter/features-codex-oauth-rotating";
import type { CodexRotatingSecretWriteTarget } from "./codex-rotating-oauth-repository-port.js";

export const zeroLoginRolloverSchemaVersion = 1 as const;

export type ZeroLoginRolloverReleaseEvidence = Readonly<{
  evidenceId: string;
  actionCommitSha: string;
  workflowSchemaVersion: 5;
  services: readonly Readonly<{
    service: "web" | "api" | "worker";
    serviceId: string;
    deployId: string;
    liveSaasCommitSha: string;
    observedAllowedActionRefs: readonly string[];
    canonicalEnvironmentDigest: string;
    observedAt: string;
    state: "live";
  }>[];
}>;

export type ZeroLoginRolloverScheduleEvidence = Readonly<{
  runId: string;
  runAttempt: string;
  eventName: "schedule";
  conclusion: "success";
  workflowActionCommitSha: string;
  workflowSourceCommitSha: string;
  sourceDefaultHeadSha: string;
  completedAt: string;
}>;

export type PrepareZeroLoginRolloverInput = Readonly<{
  operationId: string;
  repositoryFullName: string;
  providerInstanceId: string;
  expectedCandidateEpoch?: bigint | undefined;
  expectedCandidateName?: string | undefined;
  expectedRerunAttempt: string;
  schedule: ZeroLoginRolloverScheduleEvidence;
  release: ZeroLoginRolloverReleaseEvidence;
}>;

export interface ZeroLoginRolloverEvidencePort {
  verifyLatestSuccessfulSchedule(
    input: PrepareZeroLoginRolloverInput,
  ): Promise<ZeroLoginRolloverScheduleEvidence>;
  verifyTrustedRenderOverlap(
    input: PrepareZeroLoginRolloverInput,
  ): Promise<ZeroLoginRolloverReleaseEvidence>;
}

export type ZeroLoginRolloverRecord = Readonly<{
  id: string;
  operationId: string;
  repositoryFullName: string;
  providerInstanceId: string;
  state:
    | "prepared"
    | "put_authorized"
    | "provider_confirmed"
    | "setup_pr_open"
    | "activated"
    | "aborted"
    | "provider_outcome_unknown";
  sourceRunId: string;
  sourceRunAttempt: string;
  expectedRerunAttempt: string;
  sourceActionCommitSha: string;
  sourceWorkflowCommitSha: string;
  sourceDefaultHeadSha: string;
  targetActionCommitSha: string;
  targetWorkflowSchemaVersion: 5;
  candidateNamespaceId: string;
  candidateNamespaceEpoch: bigint;
  candidateNamespaceName: string;
  sourceActionRef: string;
  sourceActiveNamespaceId?: string | undefined;
  targetActionRef: string;
  setupPullRequestUrl?: string | undefined;
  setupPullRequestNumber?: number | undefined;
  setupPullRequestHeadSha?: string | undefined;
  setupPullRequestBaseBranch?: string | undefined;
}>;

export interface ZeroLoginRolloverLedgerPort {
  prepare(input: PrepareZeroLoginRolloverInput): Promise<ZeroLoginRolloverRecord>;
  status(operationId: string): Promise<ZeroLoginRolloverRecord | null>;
  loadSetupPullRequestPlan(operationId: string): Promise<{
    intentId: string;
    repository: ActionRepositoryContext;
    providerInstanceId: string;
    candidate: VersionedProviderSecretNamespace;
    targetActionRef: string;
    targetWorkflowSchemaVersion: 5;
    sourceActionRef: string;
    expectedBaseSha: string;
    sourceActiveNamespaceId?: string | undefined;
  }>;
  abort(input: {
    operationId: string;
    reason: string;
  }): Promise<ZeroLoginRolloverRecord>;
  claimWriteback(input: {
    request: CodexRotatingEncryptedWritebackRequest;
    encryptedPayloadDigest: string;
  }): Promise<
    | { status: "no_match" }
    | { status: "idempotent_replay"; generation: number }
    | { status: "in_progress"; retryAfter: Date }
    | { status: "writeback_recovery_required" }
    | ({
        status: "ready_put" | "ready_publish";
        intentId: string;
        executorOwner: string;
        repository: ActionRepositoryContext;
        writeTarget: CodexRotatingSecretWriteTarget;
        candidate: VersionedProviderSecretNamespace;
        targetActionRef: string;
        targetWorkflowSchemaVersion: 5;
        sourceActionRef: string;
        expectedBaseSha: string;
        sourceActiveNamespaceId?: string | undefined;
      })
  >;
  confirmProviderWrite(input: {
    intentId: string;
    executorOwner: string;
    statusCode: 201 | 204;
  }): Promise<void>;
  retirePreDispatch(input: {
    intentId: string;
    executorOwner: string;
  }): Promise<void>;
  retireAmbiguous(input: {
    intentId: string;
    executorOwner: string;
  }): Promise<void>;
  markSetupPullRequest(input: {
    intentId: string;
    executorOwner?: string | undefined;
    url: string;
    number: number;
    headSha: string;
    baseBranch: string;
  }): Promise<{ generation: number }>;
  activateAfterAttestation(input: {
    operationId: string;
    expectedNamespaceEpoch: bigint;
    attestation: VersionedSecretWorkflowSourceAttestation;
  }): Promise<ZeroLoginRolloverRecord>;
}

export interface ZeroLoginRolloverSetupPullRequestPort {
  createOrUpdateExactSetupPullRequest(input: {
    repository: ActionRepositoryContext;
    providerInstanceId: string;
    candidate: VersionedProviderSecretNamespace;
    targetActionRef: string;
    targetWorkflowSchemaVersion: 5;
    sourceActionRef: string;
    expectedBaseSha: string;
    sourceActiveNamespaceId?: string | undefined;
  }): Promise<{
    url: string;
    number: number;
    headSha: string;
    baseBranch: string;
  }>;
}

export interface ZeroLoginConfirmedSetupCandidateActivatorPort {
  activateConfirmedCandidate(input: {
    claimId: string;
    attemptId: string;
    candidateNamespaceId: string;
    attestation: VersionedSecretWorkflowSourceAttestation;
  }): Promise<void>;
}
