import {
  assertSameVersionedProviderSecretNamespace,
  WorkflowSourceTrust,
  type VersionedSecretWorkflowSourceAttestation,
} from "@reviewrouter/features-codex-oauth-rotating";

// GitHub cancels jobs that remain queued for 24 hours. The extra hour keeps
// every V4 run admitted before activation bindable through that platform
// boundary while making retirement finite and deterministic.
export const codexRotatingV4CompatibilityWindowSeconds = 25 * 60 * 60;

export function assertCodexRotatingWorkflowV4ToV5Transition(input: {
  readonly current: VersionedSecretWorkflowSourceAttestation;
  readonly replacement: VersionedSecretWorkflowSourceAttestation;
  readonly compatibilityWindowSeconds: number;
}): void {
  const { current, replacement } = input;
  assertSameVersionedProviderSecretNamespace({
    expected: current.secretNamespace,
    actual: replacement.secretNamespace,
  });
  if (
    input.compatibilityWindowSeconds !==
      codexRotatingV4CompatibilityWindowSeconds ||
    current.workflowSchemaVersion !== 4 ||
    replacement.workflowSchemaVersion !== 5 ||
    current.sourceTrust !== WorkflowSourceTrust.TrustedDefaultBranchRevision ||
    replacement.sourceTrust !== current.sourceTrust ||
    current.repositoryId !== replacement.repositoryId ||
    current.workflowPath !== replacement.workflowPath ||
    current.workflowSourceSha256 === replacement.workflowSourceSha256 ||
    current.workflowSemanticSha256 === replacement.workflowSemanticSha256
  ) {
    throw new Error("codex_rotating_workflow_reattestation_transition_invalid");
  }
}

export function assertCodexRotatingWorkflowAlreadyActiveTransition(input: {
  readonly persisted: VersionedSecretWorkflowSourceAttestation;
  readonly verified: VersionedSecretWorkflowSourceAttestation;
}): void {
  const { persisted, verified } = input;
  assertSameVersionedProviderSecretNamespace({
    expected: persisted.secretNamespace,
    actual: verified.secretNamespace,
  });
  if (
    persisted.workflowSchemaVersion !== 5 ||
    verified.workflowSchemaVersion !== 5 ||
    persisted.sourceTrust !==
      WorkflowSourceTrust.TrustedDefaultBranchRevision ||
    verified.sourceTrust !== persisted.sourceTrust ||
    persisted.repositoryId !== verified.repositoryId ||
    persisted.workflowPath !== verified.workflowPath ||
    persisted.workflowSourceBlobSha !== verified.workflowSourceBlobSha ||
    persisted.workflowSourceSha256 !== verified.workflowSourceSha256 ||
    persisted.workflowSemanticSha256 !== verified.workflowSemanticSha256
  ) {
    throw new Error("codex_rotating_workflow_reattestation_stale");
  }
}
