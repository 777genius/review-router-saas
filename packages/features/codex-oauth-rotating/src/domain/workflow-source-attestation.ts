import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import {
  CodexRotatingT0WorkflowSchemaVersion,
  renderCanonicalCodexRotatingT0WorkflowV1,
  renderCanonicalCodexRotatingT0WorkflowV2,
  renderCanonicalCodexRotatingT0WorkflowV3,
  type CodexRotatingWorkflowSourceMetadata,
} from "./codex-oauth-rotating";

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
      CodexRotatingT0WorkflowSchemaVersion.ClientTriggeredLifecycleV3
  ) {
    throw new Error("codex_rotating_t0_workflow_metadata_missing");
  }

  const actionRef = readCanonicalT0ActionRef(reviewJob.uses);
  const apiUrl = requireNonEmptyString(reviewInputs.api_url);
  const providerInstanceId = requireNonEmptyString(
    reviewInputs.provider_instance_id,
  );
  const refreshScheduleCron =
    jobs["codex-refresh"] === undefined
      ? null
      : readCanonicalT0RefreshSchedule(root);
  const reviewSecrets = requireMapping(reviewJob.secrets);
  const renderExpected =
    workflowSchemaVersion ===
    CodexRotatingT0WorkflowSchemaVersion.DurableDispatchV1
      ? renderCanonicalCodexRotatingT0WorkflowV1
      : workflowSchemaVersion ===
          CodexRotatingT0WorkflowSchemaVersion.ClientTriggeredV2
        ? renderCanonicalCodexRotatingT0WorkflowV2
        : renderCanonicalCodexRotatingT0WorkflowV3;
  const expectedWorkflow = renderExpected({
    actionRef,
    apiUrl,
    providerInstanceId,
    refreshScheduleCron,
    claudeCodeOAuthTokenSecret: Object.hasOwn(
      reviewSecrets,
      "CLAUDE_CODE_OAUTH_TOKEN",
    ),
    openRouterApiKeySecret: Object.hasOwn(reviewSecrets, "OPENROUTER_API_KEY"),
  });
  if (!areWorkflowDocumentsSemanticallyEqual(workflow, expectedWorkflow)) {
    throw new Error("codex_rotating_t0_workflow_source_not_canonical");
  }

  return {
    actionRef,
    apiUrl,
    providerInstanceId,
    workflowSchemaVersion,
  };
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
