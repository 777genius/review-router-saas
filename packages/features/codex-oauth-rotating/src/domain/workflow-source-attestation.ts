import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import {
  codexRotatingCanonicalT0WorkflowSchemaVersions,
  readCodexRotatingWorkflowSourceMetadata,
  renderCanonicalCodexRotatingT0WorkflowV1,
  type CodexRotatingWorkflowSourceMetadata,
} from "./codex-oauth-rotating";

export function readCanonicalCodexRotatingT0WorkflowSourceMetadata(
  workflow: string,
): CodexRotatingWorkflowSourceMetadata {
  const source = readCodexRotatingWorkflowSourceMetadata(workflow);
  if (
    !(
      codexRotatingCanonicalT0WorkflowSchemaVersions as readonly number[]
    ).includes(source.workflowSchemaVersion)
  ) {
    throw new Error("codex_rotating_t0_workflow_metadata_missing");
  }

  const document = readCanonicalWorkflowDocument(workflow);
  const root = requireMapping(document);
  const jobs = requireMapping(root.jobs);
  const reviewJob = requireMapping(jobs["codex-review"]);
  const refreshScheduleCron =
    jobs["codex-refresh"] === undefined
      ? null
      : readCanonicalT0RefreshSchedule(root);
  const reviewSecrets = requireMapping(reviewJob.secrets);
  const expectedWorkflow = renderCanonicalCodexRotatingT0WorkflowV1({
    actionRef: source.actionRef,
    apiUrl: source.apiUrl,
    providerInstanceId: source.providerInstanceId,
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

  return source;
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
