import { createHash } from "node:crypto";
import {
  CodexRotatingT0WorkflowSchemaVersion,
  areWorkflowDocumentsSemanticallyEqual,
  readCanonicalWorkflowDocument,
  readCanonicalAccountGatewayWorkflowSourceMetadata,
  isVersionedSecretNamespaceCodexWorkflowSchemaVersion,
  renderCanonicalCodexRotatingT0WorkflowV1,
  renderCanonicalCodexRotatingT0WorkflowV2,
  renderCanonicalCodexRotatingT0WorkflowV3,
  renderCanonicalCodexRotatingT0WorkflowV4,
  renderCanonicalCodexRotatingT0WorkflowV5,
  type CodexRotatingWorkflowSourceMetadata,
} from "./codex-oauth-rotating";
import {
  assertSameVersionedProviderSecretNamespace,
  createVersionedProviderSecretNamespace,
  parseVersionedProviderSecretNamespaceMetadata,
  serializeVersionedProviderSecretNamespaceMetadata,
  type VersionedProviderSecretNamespace,
} from "./provider-secret-namespace";

export {
  areWorkflowDocumentsSemanticallyEqual,
  workflowDocumentSemanticSha256,
} from "./codex-oauth-rotating";

export enum WorkflowSourceTrust {
  TrustedDefaultBranchRevision = "trusted_default_branch_revision",
  TrustedCanonicalBranchMirrorRevision = "trusted_canonical_branch_mirror_revision",
  MutableOrUntrusted = "mutable_or_untrusted",
}

export const isolatedQualityWorkflowRepositoryId = "1228051727";
export const isolatedQualityWorkflowRepository =
  "777genius/review-router-saas-e2e";
export const isolatedQualityWorkflowPath =
  ".github/workflows/reviewrouter-quality-stand.yml";

export function renderCanonicalIsolatedQualityWorkflow(input: {
  readonly actionRef: string;
  readonly apiUrl: string;
  readonly providerInstanceId: string;
  readonly activeSecretNamespace: VersionedProviderSecretNamespace;
}): string {
  const actionSha = input.actionRef.match(
    /^777genius\/review-router@([a-fA-F0-9]{40})$/u,
  )?.[1];
  if (
    !actionSha ||
    input.providerInstanceId !==
      `codex-rotating:${isolatedQualityWorkflowRepositoryId}`
  ) {
    throw new Error("isolated_quality_workflow_identity_mismatch");
  }
  const namespace = createVersionedProviderSecretNamespace(
    input.activeSecretNamespace,
  );
  if (
    namespace.scope.repositoryId !== isolatedQualityWorkflowRepositoryId ||
    namespace.scope.providerInstanceId !== input.providerInstanceId
  ) {
    throw new Error("isolated_quality_workflow_identity_mismatch");
  }
  const source = `name: ReviewRouter Codex OAuth [${serializeVersionedProviderSecretNamespaceMetadata(namespace)}]

run-name: ReviewRouter review \${{ inputs.review_request_id }}

on:
  workflow_dispatch:
    inputs:
      review_request_id:
        required: true
        type: string
      pr_number:
        required: true
        type: string
      review_head_sha:
        required: true
        type: string

permissions: {}

jobs:
  quality-preflight:
    if: \${{ github.event_name == 'workflow_dispatch' && github.repository_id == '1228051727' && github.ref == 'refs/heads/main' && github.event.repository.default_branch == 'main' && vars.REVIEW_ROUTER_REVIEW_DRAFTS != 'true' && inputs.review_request_id != '' }}
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    permissions:
      contents: read
      pull-requests: read
    steps:
      - name: Verify isolated draft revision
        shell: bash
        env:
          GH_TOKEN: \${{ github.token }}
          GH_REPO: \${{ github.repository }}
          PR_NUMBER: \${{ inputs.pr_number }}
          REVIEW_HEAD_SHA: \${{ inputs.review_head_sha }}
          REVIEW_DRAFTS: \${{ vars.REVIEW_ROUTER_REVIEW_DRAFTS }}
        run: |
          set -euo pipefail
          [[ "$PR_NUMBER" =~ ^[1-9][0-9]*$ ]]
          [[ "$REVIEW_HEAD_SHA" =~ ^[a-fA-F0-9]{40}$ ]]
          [[ "\${REVIEW_DRAFTS,,}" != true ]]
          gh api "repos/$GH_REPO" --jq '.id == 1228051727 and .default_branch == "main"' | grep -qx true
          gh api "repos/$GH_REPO/pulls/$PR_NUMBER" | jq -e --arg sha "$REVIEW_HEAD_SHA" --arg number "$PR_NUMBER" '
            (.number | tostring) == $number and
            .state == "open" and .draft == true and
            .user.type == "User" and
            .head.repo.id == 1228051727 and .base.repo.id == 1228051727 and
            .head.sha == $sha' > /dev/null
  codex-review:
    name: codex-review
    needs: quality-preflight
    if: \${{ github.event_name == 'workflow_dispatch' && inputs.review_request_id != '' && inputs.pr_number != '' && inputs.review_head_sha != '' }}
    concurrency:
      group: reviewrouter-codex-oauth-\${{ github.repository_id }}-codex-rotating-1228051727
      cancel-in-progress: false
    permissions:
      contents: read
      pull-requests: read
      id-token: write
    uses: ${input.actionRef.replace("@", "/.github/workflows/reviewrouter-t0-reusable.yml@")}
    with:
      runtime_ref: ${JSON.stringify(actionSha)}
      api_url: ${JSON.stringify(input.apiUrl)}
      runtime_config_mode: oidc
      pr_number: \${{ inputs.pr_number }}
      review_head_sha: \${{ inputs.review_head_sha }}
      provider_instance_id: ${JSON.stringify(input.providerInstanceId)}
      workflow_schema_version: 5
      max_changed_lines: \${{ vars.REVIEW_ROUTER_MAX_CHANGED_LINES }}
      review_timeout_minutes: \${{ fromJSON(vars.REVIEW_ROUTER_TIMEOUT_MINUTES || '60') }}
    secrets:
      CODEX_AUTH_JSON: \${{ secrets.${namespace.name} }}
`;
  readCanonicalIsolatedQualityWorkflowSourceMetadata(source);
  return source;
}

export function isCodexWorkflowRepositoryIdentityAdmitted(input: {
  readonly repositoryId: string;
  readonly repositoryFullName: string;
}): boolean {
  return (
    input.repositoryId !== isolatedQualityWorkflowRepositoryId ||
    input.repositoryFullName === isolatedQualityWorkflowRepository
  );
}

export function codexWorkflowPathForRepository(input: {
  readonly repositoryId: string;
  readonly repositoryFullName: string;
}): string {
  return input.repositoryId === isolatedQualityWorkflowRepositoryId
    ? isolatedQualityWorkflowPath
    : ".github/workflows/reviewrouter-codex.yml";
}

export type VersionedSecretWorkflowSourceAttestation = Readonly<{
  repositoryId: string;
  workflowPath: string;
  workflowSourceCommitSha: string;
  workflowSourceBlobSha: string;
  workflowSourceSha256: string;
  workflowSemanticSha256: string;
  workflowSchemaVersion: 4 | 5;
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
  readonly workflowSchemaVersion: number;
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
  const workflowSchemaVersion = input.workflowSchemaVersion;
  if (
    !isVersionedSecretNamespaceCodexWorkflowSchemaVersion(workflowSchemaVersion)
  )
    throw new Error("workflow_source_attestation_schema_version_invalid");
  const secretNamespace = createVersionedProviderSecretNamespace(
    input.secretNamespace,
  );
  if (secretNamespace.scope.repositoryId !== input.repositoryId)
    throw new Error("workflow_source_attestation_repository_mismatch");
  return Object.freeze({
    ...input,
    workflowSchemaVersion,
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
  if (Object.hasOwn(reviewInputs, "codex_session_mode")) {
    return readCanonicalAccountGatewayWorkflowSourceMetadata(workflow);
  }
  const workflowSchemaVersion = reviewInputs.workflow_schema_version;
  if (
    workflowSchemaVersion !==
      CodexRotatingT0WorkflowSchemaVersion.DurableDispatchV1 &&
    workflowSchemaVersion !==
      CodexRotatingT0WorkflowSchemaVersion.ClientTriggeredV2 &&
    workflowSchemaVersion !==
      CodexRotatingT0WorkflowSchemaVersion.ClientTriggeredLifecycleV3 &&
    workflowSchemaVersion !==
      CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV4 &&
    workflowSchemaVersion !==
      CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV5
  ) {
    throw new Error("codex_rotating_t0_workflow_metadata_missing");
  }

  const actionRef = readCanonicalT0ActionRef(reviewJob.uses);
  const apiUrl = requireNonEmptyString(reviewInputs.api_url);
  const providerInstanceId = requireNonEmptyString(
    reviewInputs.provider_instance_id,
  );
  const secretNamespace = isVersionedSecretNamespaceCodexWorkflowSchemaVersion(
    workflowSchemaVersion,
  )
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
          : workflowSchemaVersion ===
              CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV4
            ? renderCanonicalCodexRotatingT0WorkflowV4({
                ...commonRenderInput,
                activeSecretNamespace: secretNamespace!,
              })
            : renderCanonicalCodexRotatingT0WorkflowV5({
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

/** Exact, repository-bound schema-5 source used only by the disposable quality stand. */
export function readCanonicalIsolatedQualityWorkflowSourceMetadata(
  workflow: string,
): CodexRotatingWorkflowSourceMetadata {
  const document = readCanonicalWorkflowDocument(workflow);
  const root = requireMapping(document);
  const jobs = requireMapping(root.jobs);
  const reviewJob = requireMapping(jobs["codex-review"]);
  const reviewInputs = requireMapping(reviewJob.with);
  const actionRef = readCanonicalT0ActionRef(reviewJob.uses);
  const apiUrl = requireNonEmptyString(reviewInputs.api_url);
  const providerInstanceId = requireNonEmptyString(
    reviewInputs.provider_instance_id,
  );
  const workflowSchemaVersion = reviewInputs.workflow_schema_version;
  if (workflowSchemaVersion !== 5) {
    throw new Error("codex_rotating_t0_workflow_metadata_missing");
  }
  const namespace = readVersionedSecretNamespace(root.name, providerInstanceId);
  const reviewSecrets = requireMapping(reviewJob.secrets);
  if (reviewSecrets.CODEX_AUTH_JSON !== `\${{ secrets.${namespace.name} }}`) {
    throw new Error("codex_rotating_t0_workflow_source_not_canonical");
  }
  const actionSha = actionRef.split("@")[1]!;
  const qualityStandBaselineNamespace = createVersionedProviderSecretNamespace({
    scope: {
      repositoryId: isolatedQualityWorkflowRepositoryId,
      providerInstanceId: `codex-rotating:${isolatedQualityWorkflowRepositoryId}`,
    },
    namespaceId: "sns_e9c2956ba412321fa27816e6cee3bd06",
    epoch: 2n,
    name: "REVIEWROUTER_CODEX_AUTH_JSON_R1228051727_P01cfca27f31e5f85_E2_e9c2956ba412321fa27816e6cee3bd06",
  });
  const normalizedSourceSha256 = createHash("sha256")
    .update(
      workflow
        .replace(
          serializeVersionedProviderSecretNamespaceMetadata(namespace),
          serializeVersionedProviderSecretNamespaceMetadata(
            qualityStandBaselineNamespace,
          ),
        )
        .replaceAll(namespace.name, qualityStandBaselineNamespace.name)
        .replaceAll(actionSha, "__ACTION_SHA__")
        .replaceAll(apiUrl, "__API_URL__"),
      "utf8",
    )
    .digest("hex");
  if (
    normalizedSourceSha256 !==
    "4e44ec0322513825695b4ddc4bdadaa6d755ce08c8770aa750e73abf6dc313d9"
  ) {
    throw new Error("codex_rotating_t0_workflow_source_not_canonical");
  }
  return {
    actionRef,
    apiUrl,
    providerInstanceId,
    workflowSchemaVersion,
    secretNamespace: namespace,
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
  readonly expectedWorkflowSchemaVersion: CodexRotatingT0WorkflowSchemaVersion;
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
    !isVersionedSecretNamespaceCodexWorkflowSchemaVersion(
      input.metadata.workflowSchemaVersion,
    ) ||
    input.metadata.workflowSchemaVersion !==
      input.expectedWorkflowSchemaVersion ||
    !input.metadata.secretNamespace
  ) {
    throw new Error("codex_rotating_workflow_schema_version_mismatch");
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
