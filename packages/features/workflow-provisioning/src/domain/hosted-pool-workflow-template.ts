import { createHash } from "node:crypto";
import { isLoopbackHostname } from "@reviewrouter/shared";

export const hostedPoolWorkflowSchemaVersion = 2 as const;
export const hostedPoolSessionMode =
  "codex_subscription_oauth_hosted_pool" as const;

export function canonicalHostedPoolProviderInstanceId(
  githubRepositoryId: string,
): string {
  if (!/^[1-9][0-9]*$/u.test(githubRepositoryId))
    throw new Error("hosted_github_repository_id_invalid");
  return `hosted-pool:repository:${githubRepositoryId}`;
}

export type HostedPoolWorkflowOptions = Readonly<{
  actionRef: string;
  apiUrl: string;
  providerInstanceId: string;
  bindingId: string;
  bindingRevision: number;
}>;

export type HostedPoolWorkflowScanResult = Readonly<{
  valid: boolean;
  errors: readonly string[];
}>;

export type HostedPoolWorkflowSourceAttestation = Readonly<{
  repositoryId: string;
  workflowPath: string;
  workflowSourceCommitSha: string;
  workflowSourceBlobSha: string;
  workflowSourceSha256: string;
  workflowSemanticSha256: string;
  sourceTrust: "trusted_default_branch_revision";
  bindingId: string;
  bindingRevision: number;
}>;

export type HostedPoolReusableWorkflowIdentity = Readonly<{
  ref: string;
  sha: string;
}>;

const forbiddenHostedWorkflowReferences = [
  /CODEX_AUTH_JSON/iu,
  /auth-json/iu,
  /auth\.json/iu,
  /^\s*secrets\s*:/imu,
  /secrets\./iu,
  /secrets:\s*inherit/iu,
  /toJSON\(\s*secrets\s*\)/iu,
  /^\s*schedule\s*:/imu,
  /codex-refresh/iu,
] as const;

export function renderCanonicalHostedPoolWorkflowV2(
  input: HostedPoolWorkflowOptions,
): string {
  const release = parseImmutableActionRef(input.actionRef);
  assertSafeHostedApiUrl(input.apiUrl);
  assertOpaqueId(
    input.providerInstanceId,
    "hosted_provider_instance_id_invalid",
  );
  assertOpaqueId(input.bindingId, "hosted_binding_id_invalid");
  if (
    !Number.isSafeInteger(input.bindingRevision) ||
    input.bindingRevision < 1
  ) {
    throw new Error("hosted_binding_revision_invalid");
  }
  const reusableWorkflowRef = canonicalHostedPoolReusableWorkflowIdentity(
    input.actionRef,
  ).ref;

  return `name: ReviewRouter Hosted Codex

run-name: \${{ format('ReviewRouter hosted review PR {0} at {1}', github.event.pull_request.number, github.event.pull_request.head.sha) }}

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, converted_to_draft]

permissions: {}

jobs:
  codex-review:
    name: codex-review
    if: \${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && github.event.pull_request.user.type != 'Bot' && (github.event.pull_request.draft == false || vars.REVIEW_ROUTER_REVIEW_DRAFTS == 'true') }}
    permissions:
      contents: read
      pull-requests: read
      id-token: write
    uses: ${reusableWorkflowRef}
    with:
      runtime_ref: ${JSON.stringify(release.commitSha)}
      api_url: ${JSON.stringify(input.apiUrl)}
      runtime_config_mode: oidc
      pr_number: \${{ format('{0}', github.event.pull_request.number) }}
      review_head_sha: \${{ github.event.pull_request.head.sha }}
      provider_instance_id: ${JSON.stringify(input.providerInstanceId)}
      workflow_schema_version: ${hostedPoolWorkflowSchemaVersion}
      max_changed_lines: \${{ vars.REVIEW_ROUTER_MAX_CHANGED_LINES }}
      review_timeout_minutes: \${{ fromJSON(vars.REVIEW_ROUTER_TIMEOUT_MINUTES || '60') }}
      codex_session_mode: ${hostedPoolSessionMode}
      session_binding_id: ${JSON.stringify(input.bindingId)}
      session_binding_version: ${input.bindingRevision}
`;
}

export function canonicalHostedPoolReusableWorkflowIdentity(
  actionRef: string,
): HostedPoolReusableWorkflowIdentity {
  const release = parseImmutableActionRef(actionRef);
  return Object.freeze({
    ref: `${release.repository}/.github/workflows/reviewrouter-t0-reusable.yml@${release.commitSha}`,
    sha: release.commitSha,
  });
}

export function scanCanonicalHostedPoolWorkflowV2(
  workflow: string,
): HostedPoolWorkflowScanResult {
  const errors: string[] = [];
  if (
    forbiddenHostedWorkflowReferences.some((pattern) => pattern.test(workflow))
  ) {
    errors.push("hosted_workflow_auth_secret_reference_forbidden");
  }
  if (!/^permissions: \{\}$/mu.test(workflow)) {
    errors.push("hosted_workflow_top_level_permissions_invalid");
  }
  if (
    !workflow.includes("      contents: read") ||
    !workflow.includes("      pull-requests: read") ||
    !workflow.includes("      id-token: write")
  ) {
    errors.push("hosted_workflow_oidc_permissions_required");
  }
  if (
    !workflow.includes("github.event_name == 'pull_request'") ||
    !workflow.includes(
      "github.event.pull_request.head.repo.full_name == github.repository",
    ) ||
    !workflow.includes("github.event.pull_request.user.type != 'Bot'") ||
    !/^ {2}pull_request:/mu.test(workflow) ||
    /^ {2}(?:pull_request_target|workflow_dispatch):/mu.test(workflow)
  ) {
    errors.push("hosted_workflow_trusted_ingress_required");
  }
  if (
    !workflow.includes(
      `workflow_schema_version: ${hostedPoolWorkflowSchemaVersion}`,
    ) ||
    !workflow.includes(`codex_session_mode: ${hostedPoolSessionMode}`) ||
    !/^ {6}session_binding_id: "[^"\n]+"$/mu.test(workflow) ||
    !/^ {6}session_binding_version: [1-9][0-9]*$/mu.test(workflow)
  ) {
    errors.push("hosted_workflow_binding_inputs_required");
  }

  try {
    const metadata = readCanonicalHostedPoolWorkflowMetadata(workflow);
    const canonical = renderCanonicalHostedPoolWorkflowV2(metadata);
    if (normalizeWorkflow(canonical) !== normalizeWorkflow(workflow)) {
      errors.push("hosted_workflow_source_not_canonical");
    }
  } catch {
    errors.push("hosted_workflow_metadata_invalid");
  }

  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

export function readCanonicalHostedPoolWorkflowMetadata(
  workflow: string,
): HostedPoolWorkflowOptions {
  const actionRef = requireMatch(
    workflow,
    /^ {4}uses: ([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/reviewrouter-t0-reusable\.yml@[a-f0-9]{40})$/imu,
    "hosted_workflow_action_ref_missing",
  );
  const parsed =
    /^([^/]+\/[^/]+)\/\.github\/workflows\/reviewrouter-t0-reusable\.yml@([a-f0-9]{40})$/iu.exec(
      actionRef,
    );
  if (!parsed) throw new Error("hosted_workflow_action_ref_invalid");
  const apiUrl = parseJsonString(
    requireMatch(
      workflow,
      /^ {6}api_url: (.+)$/mu,
      "hosted_workflow_api_url_missing",
    ),
  );
  const providerInstanceId = parseJsonString(
    requireMatch(
      workflow,
      /^ {6}provider_instance_id: (.+)$/mu,
      "hosted_workflow_provider_instance_missing",
    ),
  );
  const bindingId = parseJsonString(
    requireMatch(
      workflow,
      /^ {6}session_binding_id: (.+)$/mu,
      "hosted_workflow_binding_id_missing",
    ),
  );
  const bindingRevision = Number(
    requireMatch(
      workflow,
      /^ {6}session_binding_version: ([1-9][0-9]*)$/mu,
      "hosted_workflow_binding_revision_missing",
    ),
  );

  return {
    actionRef: `${parsed[1]}@${parsed[2]}`,
    apiUrl,
    providerInstanceId,
    bindingId,
    bindingRevision,
  };
}

export function createHostedPoolWorkflowSourceAttestation(
  input: HostedPoolWorkflowSourceAttestation,
): HostedPoolWorkflowSourceAttestation {
  if (!/^[1-9][0-9]*$/u.test(input.repositoryId))
    throw new Error("hosted_workflow_attestation_repository_id_invalid");
  if (
    !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u.test(input.workflowPath)
  )
    throw new Error("hosted_workflow_attestation_path_invalid");
  if (!/^[a-f0-9]{40}$/iu.test(input.workflowSourceCommitSha))
    throw new Error("hosted_workflow_attestation_commit_sha_invalid");
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(input.workflowSourceBlobSha))
    throw new Error("hosted_workflow_attestation_blob_sha_invalid");
  if (!/^[a-f0-9]{64}$/iu.test(input.workflowSourceSha256))
    throw new Error("hosted_workflow_attestation_digest_invalid");
  if (!/^[a-f0-9]{64}$/iu.test(input.workflowSemanticSha256))
    throw new Error("hosted_workflow_attestation_semantic_digest_invalid");
  assertOpaqueId(input.bindingId, "hosted_binding_id_invalid");
  if (!Number.isSafeInteger(input.bindingRevision) || input.bindingRevision < 1)
    throw new Error("hosted_binding_revision_invalid");
  return Object.freeze({
    ...input,
    workflowSourceCommitSha: input.workflowSourceCommitSha.toLowerCase(),
    workflowSourceBlobSha: input.workflowSourceBlobSha.toLowerCase(),
    workflowSourceSha256: input.workflowSourceSha256.toLowerCase(),
    workflowSemanticSha256: input.workflowSemanticSha256.toLowerCase(),
  });
}

export function assertActiveHostedPoolWorkflowAttestation(input: {
  readonly attestation: HostedPoolWorkflowSourceAttestation;
  readonly repositoryId: string;
  readonly workflowPath: string;
  readonly workflowSourceCommitSha: string;
  readonly expectedBindingId: string;
  readonly expectedBindingRevision: number;
  readonly expectedWorkflow: string;
  readonly expectedWorkflowSourceBlobSha: string;
}): void {
  const attestation = createHostedPoolWorkflowSourceAttestation(
    input.attestation,
  );
  if (
    attestation.repositoryId !== input.repositoryId ||
    attestation.workflowPath !== input.workflowPath
  ) {
    throw new Error("hosted_workflow_attestation_scope_mismatch");
  }
  if (
    attestation.workflowSourceCommitSha !==
    input.workflowSourceCommitSha.toLowerCase()
  )
    throw new Error("hosted_workflow_attestation_revision_mismatch");
  if (
    attestation.bindingId !== input.expectedBindingId ||
    attestation.bindingRevision !== input.expectedBindingRevision
  ) {
    throw new Error("hosted_workflow_attestation_binding_mismatch");
  }
  if (
    attestation.workflowSourceBlobSha !==
    input.expectedWorkflowSourceBlobSha.toLowerCase()
  )
    throw new Error("hosted_workflow_attestation_blob_mismatch");
  const contentDigest = createHash("sha256")
    .update(input.expectedWorkflow)
    .digest("hex");
  const semanticDigest = hostedPoolWorkflowSemanticSha256(
    input.expectedWorkflow,
  );
  if (
    attestation.workflowSourceSha256 !== contentDigest ||
    attestation.workflowSemanticSha256 !== semanticDigest
  ) {
    throw new Error("hosted_workflow_attestation_digest_mismatch");
  }
  const scan = scanCanonicalHostedPoolWorkflowV2(input.expectedWorkflow);
  if (!scan.valid)
    throw new Error("hosted_workflow_attestation_source_invalid");
}

export function hostedPoolWorkflowSemanticSha256(workflow: string): string {
  return createHash("sha256").update(normalizeWorkflow(workflow)).digest("hex");
}

function parseImmutableActionRef(actionRef: string): {
  readonly repository: string;
  readonly commitSha: string;
} {
  const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([a-f0-9]{40})$/iu.exec(
    actionRef,
  );
  if (!match) throw new Error("hosted_workflow_action_ref_must_be_full_sha");
  return { repository: match[1]!, commitSha: match[2]!.toLowerCase() };
}

function assertSafeHostedApiUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("hosted_workflow_api_url_invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    isLoopbackHostname(url.hostname)
  ) {
    throw new Error("hosted_workflow_api_url_invalid");
  }
}

function assertOpaqueId(value: string, code: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/u.test(value))
    throw new Error(code);
}

function requireMatch(value: string, pattern: RegExp, code: string): string {
  const match = pattern.exec(value);
  if (!match?.[1]) throw new Error(code);
  return match[1];
}

function parseJsonString(value: string): string {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "string" || parsed.length === 0)
    throw new Error("hosted_workflow_string_input_invalid");
  return parsed;
}

function normalizeWorkflow(value: string): string {
  return value.replace(/\r\n/gu, "\n").trimEnd();
}
