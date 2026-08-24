import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import {
  CodexRotatingT0WorkflowSchemaVersion,
  renderCanonicalCodexRotatingT0WorkflowV1,
  renderCanonicalCodexRotatingT0WorkflowV2,
  renderCanonicalCodexRotatingT0WorkflowV3,
  renderCanonicalCodexRotatingT0WorkflowV4,
  type CodexRotatingWorkflowSourceMetadata,
} from "./codex-oauth-rotating";
import {
  assertSameVersionedProviderSecretNamespace,
  createVersionedProviderSecretNamespace,
  parseVersionedProviderSecretNamespaceMetadata,
  type VersionedProviderSecretNamespace,
} from "./provider-secret-namespace";

export enum WorkflowSourceTrust {
  TrustedDefaultBranchRevision = "trusted_default_branch_revision",
  TrustedCanonicalBranchMirrorRevision = "trusted_canonical_branch_mirror_revision",
  MutableOrUntrusted = "mutable_or_untrusted",
}

export type VersionedSecretWorkflowSourceAttestation = Readonly<{
  repositoryId: string;
  workflowPath: string;
  workflowSourceCommitSha: string;
  workflowSourceBlobSha: string;
  workflowSourceSha256: string;
  workflowSemanticSha256: string;
  sourceTrust: WorkflowSourceTrust;
  secretNamespace: VersionedProviderSecretNamespace;
}>;

export function createVersionedSecretWorkflowSourceAttestation(input: {
  readonly repositoryId: string;
  readonly workflowPath: string;
  readonly workflowSourceCommitSha: string;
  readonly workflowSourceBlobSha: string;
  readonly workflowSourceSha256: string;
  readonly workflowSemanticSha256: string;
  readonly sourceTrust: WorkflowSourceTrust;
  readonly secretNamespace: VersionedProviderSecretNamespace;
}): VersionedSecretWorkflowSourceAttestation {
  if (!/^[1-9][0-9]*$/.test(input.repositoryId))
    throw new Error("workflow_source_attestation_repository_id_invalid");
  if (!/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(input.workflowPath))
    throw new Error("workflow_source_attestation_path_invalid");
  if (!/^[a-f0-9]{40}$/i.test(input.workflowSourceCommitSha))
    throw new Error("workflow_source_attestation_commit_sha_invalid");
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(input.workflowSourceBlobSha))
    throw new Error("workflow_source_attestation_blob_sha_invalid");
  if (!/^[a-f0-9]{64}$/i.test(input.workflowSourceSha256))
    throw new Error("workflow_source_attestation_digest_invalid");
  if (!/^[a-f0-9]{64}$/i.test(input.workflowSemanticSha256))
    throw new Error("workflow_source_attestation_semantic_digest_invalid");
  const secretNamespace = createVersionedProviderSecretNamespace(
    input.secretNamespace,
  );
  if (secretNamespace.scope.repositoryId !== input.repositoryId)
    throw new Error("workflow_source_attestation_repository_mismatch");
  return Object.freeze({
    ...input,
    workflowSourceCommitSha: input.workflowSourceCommitSha.toLowerCase(),
    workflowSourceBlobSha: input.workflowSourceBlobSha.toLowerCase(),
    workflowSourceSha256: input.workflowSourceSha256.toLowerCase(),
    workflowSemanticSha256: input.workflowSemanticSha256.toLowerCase(),
    secretNamespace,
  });
}

export function assertActiveVersionedSecretWorkflowAttestation(input: {
  readonly attestation: VersionedSecretWorkflowSourceAttestation;
  readonly repositoryId: string;
  readonly workflowPath: string;
  readonly workflowSourceCommitSha: string;
  readonly activeSecretNamespace: VersionedProviderSecretNamespace;
  readonly expectedWorkflowSource: Readonly<{
    workflowPath: string;
    workflowSourceCommitSha: string;
    workflowSourceBlobSha: string;
    workflowSourceSha256: string;
    workflowSemanticSha256: string;
    sourceTrust: "trusted_default_branch_revision";
    repositoryId: string;
  }>;
}): void {
  const attestation = createVersionedSecretWorkflowSourceAttestation(
    input.attestation,
  );
  if (
    attestation.sourceTrust !==
      WorkflowSourceTrust.TrustedDefaultBranchRevision &&
    attestation.sourceTrust !==
      WorkflowSourceTrust.TrustedCanonicalBranchMirrorRevision
  )
    throw new Error("workflow_source_attestation_untrusted");
  if (attestation.repositoryId !== input.repositoryId)
    throw new Error("workflow_source_attestation_repository_mismatch");
  if (
    attestation.workflowPath !== input.workflowPath ||
    attestation.workflowPath !== input.expectedWorkflowSource.workflowPath
  )
    throw new Error("workflow_source_attestation_path_mismatch");
  if (
    attestation.workflowSourceCommitSha !==
    input.workflowSourceCommitSha.toLowerCase()
  )
    throw new Error("workflow_source_attestation_revision_mismatch");
  if (
    attestation.workflowSemanticSha256 !==
    input.expectedWorkflowSource.workflowSemanticSha256.toLowerCase()
  )
    throw new Error("workflow_source_attestation_semantic_digest_mismatch");
  if (
    attestation.workflowSourceBlobSha !==
    input.expectedWorkflowSource.workflowSourceBlobSha.toLowerCase()
  )
    throw new Error("workflow_source_attestation_blob_mismatch");
  if (
    attestation.workflowSourceSha256 !==
    input.expectedWorkflowSource.workflowSourceSha256.toLowerCase()
  )
    throw new Error("workflow_source_attestation_content_digest_mismatch");
  if (
    input.expectedWorkflowSource.sourceTrust !==
      WorkflowSourceTrust.TrustedDefaultBranchRevision ||
    attestation.repositoryId !== input.expectedWorkflowSource.repositoryId
  )
    throw new Error("workflow_source_attestation_evidence_mismatch");
  assertSameVersionedProviderSecretNamespace({
    expected: input.activeSecretNamespace,
    actual: attestation.secretNamespace,
  });
}

export function readCanonicalCodexRotatingT0WorkflowSourceMetadata(
  workflow: string,
): CodexRotatingWorkflowSourceMetadata {
  const document = readCanonicalWorkflowDocument(workflow);
  const root = requireMapping(document);
  const jobs = requireMapping(root.jobs);
  const reviewJob = requireMapping(jobs["codex-review"]);
  const reviewInputs = requireMapping(reviewJob.with);
  const workflowSchemaVersion = reviewInputs.workflow_schema_version;
  if (
    workflowSchemaVersion !==
      CodexRotatingT0WorkflowSchemaVersion.DurableDispatchV1 &&
    workflowSchemaVersion !==
      CodexRotatingT0WorkflowSchemaVersion.ClientTriggeredV2 &&
    workflowSchemaVersion !==
      CodexRotatingT0WorkflowSchemaVersion.ClientTriggeredLifecycleV3 &&
    workflowSchemaVersion !==
      CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV4
  ) {
    throw new Error("codex_rotating_t0_workflow_metadata_missing");
  }

  const actionRef = readCanonicalT0ActionRef(reviewJob.uses);
  const apiUrl = requireNonEmptyString(reviewInputs.api_url);
  const providerInstanceId = requireNonEmptyString(
    reviewInputs.provider_instance_id,
  );
  const secretNamespace =
    workflowSchemaVersion ===
    CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV4
      ? readVersionedSecretNamespace(root.name, providerInstanceId)
      : undefined;
  const refreshScheduleCron =
    jobs["codex-refresh"] === undefined
      ? null
      : readCanonicalT0RefreshSchedule(root);
  const reviewSecrets = requireMapping(reviewJob.secrets);
  const commonRenderInput = {
    actionRef,
    apiUrl,
    providerInstanceId,
    refreshScheduleCron,
    claudeCodeOAuthTokenSecret: Object.hasOwn(
      reviewSecrets,
      "CLAUDE_CODE_OAUTH_TOKEN",
    ),
    openRouterApiKeySecret: Object.hasOwn(reviewSecrets, "OPENROUTER_API_KEY"),
  };
  const expectedWorkflow =
    workflowSchemaVersion ===
    CodexRotatingT0WorkflowSchemaVersion.DurableDispatchV1
      ? renderCanonicalCodexRotatingT0WorkflowV1(commonRenderInput)
      : workflowSchemaVersion ===
          CodexRotatingT0WorkflowSchemaVersion.ClientTriggeredV2
        ? renderCanonicalCodexRotatingT0WorkflowV2(commonRenderInput)
        : workflowSchemaVersion ===
            CodexRotatingT0WorkflowSchemaVersion.ClientTriggeredLifecycleV3
          ? renderCanonicalCodexRotatingT0WorkflowV3(commonRenderInput)
          : renderCanonicalCodexRotatingT0WorkflowV4({
              ...commonRenderInput,
              activeSecretNamespace: secretNamespace!,
            });
  if (!areWorkflowDocumentsSemanticallyEqual(workflow, expectedWorkflow)) {
    throw new Error("codex_rotating_t0_workflow_source_not_canonical");
  }

  return {
    actionRef,
    apiUrl,
    providerInstanceId,
    workflowSchemaVersion,
    ...(secretNamespace ? { secretNamespace } : {}),
  };
}

export function assertTrustedCanonicalVersionedWorkflow(input: {
  readonly metadata: CodexRotatingWorkflowSourceMetadata;
  readonly observedRepositoryId: string;
  readonly observedRepositoryFullName: string;
  readonly expectedRepositoryId: string;
  readonly expectedRepositoryFullName: string;
  readonly trustedActionRefs: readonly string[];
  readonly expectedApiUrl: string;
  readonly expectedProviderInstanceId: string;
  readonly expectedSecretNamespace: VersionedProviderSecretNamespace;
}): void {
  if (!/^[1-9][0-9]*$/u.test(input.observedRepositoryId)) {
    throw new Error("codex_rotating_workflow_repository_id_invalid");
  }
  if (
    input.observedRepositoryId !== input.expectedRepositoryId ||
    input.observedRepositoryFullName !== input.expectedRepositoryFullName
  ) {
    throw new Error("codex_rotating_workflow_repository_identity_mismatch");
  }
  if (
    input.trustedActionRefs.length === 0 ||
    input.trustedActionRefs.some(
      (ref) => !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/iu.test(ref),
    ) ||
    !input.trustedActionRefs
      .map((ref) => ref.toLowerCase())
      .includes(input.metadata.actionRef.toLowerCase())
  ) {
    throw new Error("codex_rotating_workflow_action_ref_not_trusted");
  }
  if (input.metadata.apiUrl !== input.expectedApiUrl) {
    throw new Error("codex_rotating_workflow_api_url_not_trusted");
  }
  if (input.metadata.providerInstanceId !== input.expectedProviderInstanceId) {
    throw new Error("codex_rotating_workflow_provider_instance_mismatch");
  }
  if (
    input.metadata.workflowSchemaVersion !==
      CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV4 ||
    !input.metadata.secretNamespace
  ) {
    throw new Error("codex_rotating_workflow_v4_required");
  }
  assertSameVersionedProviderSecretNamespace({
    expected: input.expectedSecretNamespace,
    actual: input.metadata.secretNamespace,
  });
}

function readVersionedSecretNamespace(
  workflowName: unknown,
  providerInstanceId: string,
): VersionedProviderSecretNamespace {
  const name = requireNonEmptyString(workflowName);
  const prefix = "ReviewRouter Codex OAuth [";
  if (!name.startsWith(prefix) || !name.endsWith("]"))
    throw new Error("codex_rotating_t0_secret_namespace_metadata_invalid");
  return parseVersionedProviderSecretNamespaceMetadata({
    metadata: name.slice(prefix.length, -1),
    providerInstanceId,
  });
}

export function areWorkflowDocumentsSemanticallyEqual(
  actual: string,
  expected: string,
): boolean {
  try {
    return (
      JSON.stringify(readCanonicalWorkflowDocument(actual)) ===
      JSON.stringify(readCanonicalWorkflowDocument(expected))
    );
  } catch {
    return false;
  }
}

export function workflowDocumentSemanticSha256(source: string): string {
  return createHash("sha256")
    .update(JSON.stringify(readCanonicalWorkflowDocument(source)), "utf8")
    .digest("hex");
}

function readCanonicalWorkflowDocument(source: string): unknown {
  const document = parseDocument(source, {
    schema: "core",
    strict: true,
    stringKeys: true,
    uniqueKeys: true,
    prettyErrors: false,
  });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new Error("codex_rotating_workflow_yaml_invalid");
  }
  return canonicalizeWorkflowDocument(document.toJS({ maxAliasCount: 0 }));
}

function canonicalizeWorkflowDocument(value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("codex_rotating_workflow_non_finite_number");
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeWorkflowDocument);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalizeWorkflowDocument(entry)]),
    );
  }
  return value;
}

function readCanonicalT0RefreshSchedule(root: Record<string, unknown>): string {
  const triggers = requireMapping(root.on);
  const schedule = triggers.schedule;
  if (!Array.isArray(schedule) || schedule.length !== 1) {
    throw new Error("codex_rotating_t0_refresh_schedule_not_canonical");
  }
  const cron = requireMapping(schedule[0]).cron;
  if (typeof cron !== "string" || cron.length === 0) {
    throw new Error("codex_rotating_t0_refresh_schedule_not_canonical");
  }
  return cron;
}

function requireMapping(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("codex_rotating_workflow_mapping_required");
  }
  return value as Record<string, unknown>;
}

function readCanonicalT0ActionRef(value: unknown): string {
  const reusableWorkflow = requireNonEmptyString(value);
  const match =
    /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/\.github\/workflows\/reviewrouter-t0-reusable\.yml@([a-f0-9]{40})$/i.exec(
      reusableWorkflow,
    );
  if (!match) {
    throw new Error("codex_rotating_t0_action_ref_invalid");
  }
  return `${match[1]}@${match[2]!.toLowerCase()}`;
}

function requireNonEmptyString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("codex_rotating_workflow_string_required");
  }
  return value;
}
