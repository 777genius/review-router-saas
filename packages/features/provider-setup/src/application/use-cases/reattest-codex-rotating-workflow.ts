import {
  assertSameVersionedProviderSecretNamespace,
  createVersionedSecretWorkflowSourceAttestation,
  WorkflowSourceTrust,
  type VersionedSecretWorkflowSourceAttestation,
} from "@reviewrouter/features-codex-oauth-rotating";
import type {
  CodexRotatingCurrentWorkflowAttestationPort,
  CodexRotatingDefaultWorkflowSourcePort,
  CodexRotatingWorkflowReattestationPersistencePort,
  CodexRotatingWorkflowReattestationRequest,
} from "../ports/codex-rotating-workflow-reattestation-port";

export type CodexRotatingWorkflowReattestationDependencies = Readonly<{
  currentWorkflowAttestation: CodexRotatingCurrentWorkflowAttestationPort;
  defaultWorkflowSource: CodexRotatingDefaultWorkflowSourcePort;
  workflowReattestation: CodexRotatingWorkflowReattestationPersistencePort;
}>;

export async function reattestCodexRotatingWorkflow(
  target: CodexRotatingWorkflowReattestationRequest,
  dependencies: CodexRotatingWorkflowReattestationDependencies,
): Promise<
  Readonly<{
    status: "already_active" | "reattested";
    workflowSourceCommitSha: string;
  }>
> {
  const initialIdentity =
    await dependencies.defaultWorkflowSource.readDefaultSourceIdentity();
  assertRepositoryIdentityMatchesTarget(initialIdentity, target);
  const initialHead = initialIdentity.headCommitSha;
  const replacement = canonicalBoundAttestation(
    await dependencies.defaultWorkflowSource.readVerifiedWorkflowAt({
      commitSha: initialHead,
      expectedSchemaVersion: 5,
    }),
    target,
  );
  if (
    replacement.workflowSourceCommitSha !== initialHead ||
    replacement.workflowSchemaVersion !== 5
  ) {
    throw new Error("codex_rotating_workflow_reattestation_transition_invalid");
  }

  const currentValue =
    await dependencies.currentWorkflowAttestation.readActiveWorkflowAttestation(
      target.namespace,
    );
  if (!currentValue) {
    throw new Error("codex_rotating_workflow_source_attestation_missing");
  }
  const current = canonicalBoundAttestation(currentValue, target);

  if (sameTrustedWorkflowBytes(current, replacement)) {
    if (current.workflowSchemaVersion !== 5) {
      throw new Error(
        "codex_rotating_workflow_reattestation_transition_invalid",
      );
    }
    await assertDefaultSourceIdentityUnchanged(initialIdentity, dependencies);
    return {
      status: "already_active",
      workflowSourceCommitSha: initialHead,
    };
  }
  if (current.workflowSchemaVersion !== 4) {
    throw new Error("codex_rotating_workflow_reattestation_transition_invalid");
  }

  const verifiedCurrent = canonicalBoundAttestation(
    await dependencies.defaultWorkflowSource.readVerifiedWorkflowAt({
      commitSha: current.workflowSourceCommitSha,
      expectedSchemaVersion: 4,
    }),
    target,
  );
  if (!sameExactAttestation(current, verifiedCurrent)) {
    throw new Error("codex_rotating_workflow_previous_attestation_mismatch");
  }
  await assertDefaultSourceIdentityUnchanged(initialIdentity, dependencies);
  await dependencies.workflowReattestation.replaceActiveWorkflowSource({
    target,
    expectedCurrent: current,
    replacement,
  });
  return {
    status: "reattested",
    workflowSourceCommitSha: initialHead,
  };
}

function canonicalBoundAttestation(
  value: VersionedSecretWorkflowSourceAttestation,
  target: CodexRotatingWorkflowReattestationRequest,
): VersionedSecretWorkflowSourceAttestation {
  const attestation = createVersionedSecretWorkflowSourceAttestation(value);
  try {
    assertSameVersionedProviderSecretNamespace({
      expected: target.namespace,
      actual: attestation.secretNamespace,
    });
  } catch {
    throw new Error("codex_rotating_workflow_source_attestation_missing");
  }
  if (
    attestation.repositoryId !== target.repositoryId ||
    attestation.workflowPath !== target.workflowPath ||
    attestation.sourceTrust !== WorkflowSourceTrust.TrustedDefaultBranchRevision
  ) {
    throw new Error("codex_rotating_workflow_source_attestation_missing");
  }
  return attestation;
}

function sameTrustedWorkflowBytes(
  left: VersionedSecretWorkflowSourceAttestation,
  right: VersionedSecretWorkflowSourceAttestation,
): boolean {
  return (
    left.workflowSourceBlobSha === right.workflowSourceBlobSha &&
    left.workflowSourceSha256 === right.workflowSourceSha256 &&
    left.workflowSemanticSha256 === right.workflowSemanticSha256 &&
    left.sourceTrust === right.sourceTrust &&
    left.repositoryId === right.repositoryId &&
    left.workflowPath === right.workflowPath
  );
}

function sameExactAttestation(
  left: VersionedSecretWorkflowSourceAttestation,
  right: VersionedSecretWorkflowSourceAttestation,
): boolean {
  return (
    sameTrustedWorkflowBytes(left, right) &&
    left.workflowSourceCommitSha === right.workflowSourceCommitSha &&
    left.workflowSchemaVersion === right.workflowSchemaVersion
  );
}

type DefaultSourceIdentity = Awaited<
  ReturnType<
    CodexRotatingDefaultWorkflowSourcePort["readDefaultSourceIdentity"]
  >
>;

function assertRepositoryIdentityMatchesTarget(
  identity: DefaultSourceIdentity,
  target: CodexRotatingWorkflowReattestationRequest,
): void {
  if (identity.repositoryId !== target.repositoryId) {
    throw new Error("codex_rotating_workflow_repository_identity_changed");
  }
}

async function assertDefaultSourceIdentityUnchanged(
  expected: DefaultSourceIdentity,
  dependencies: CodexRotatingWorkflowReattestationDependencies,
): Promise<void> {
  const observed =
    await dependencies.defaultWorkflowSource.readDefaultSourceIdentity();
  if (
    observed.repositoryId !== expected.repositoryId ||
    observed.repositoryFullName !== expected.repositoryFullName ||
    observed.defaultBranch !== expected.defaultBranch
  )
    throw new Error("codex_rotating_workflow_repository_identity_changed");
  if (observed.headCommitSha !== expected.headCommitSha)
    throw new Error("codex_rotating_workflow_default_head_changed");
}
