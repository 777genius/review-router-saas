import {
  readCanonicalHostedPoolWorkflowMetadata,
  readCanonicalCodexRotatingT0WorkflowSourceMetadata,
} from "@reviewrouter/features-workflow-provisioning";

/** Read compatibility for migration only: the writer always emits the current Hosted template. */
export function classifyHostedPoolSetupSource(
  workflow: string,
  expected: {
    readonly actionRef: string;
    readonly trustedPriorActionRefs?: readonly string[];
    readonly apiUrl: string;
    readonly providerInstanceId: string;
    readonly bindingId: string;
    readonly bindingRevision: number;
  },
): "hosted" | "repository_owned" {
  if (/session_binding_id\s*:/u.test(workflow)) {
    const metadata = readCanonicalHostedPoolWorkflowMetadata(workflow);
    if (
      metadata.bindingId !== expected.bindingId ||
      metadata.bindingRevision !== expected.bindingRevision ||
      metadata.actionRef !== expected.actionRef ||
      metadata.apiUrl !== expected.apiUrl ||
      metadata.providerInstanceId !== expected.providerInstanceId
    ) {
      throw new Error("hosted_pool_setup_conflict");
    }
    return "hosted";
  }
  // This existing parser checks the entire canonical document, not just metadata strings.
  const previous = readCanonicalCodexRotatingT0WorkflowSourceMetadata(workflow);
  if (
    previous.workflowSchemaVersion < 2 ||
    previous.apiUrl !== expected.apiUrl ||
    !(expected.trustedPriorActionRefs ?? [expected.actionRef]).includes(
      previous.actionRef,
    )
  ) {
    throw new Error("hosted_pool_setup_conflict");
  }
  return "repository_owned";
}

export function decodeHostedPoolWorkflowFile(data: unknown): string {
  const file = data as { content?: unknown; encoding?: unknown } | null;
  if (
    !file ||
    file.encoding !== "base64" ||
    typeof file.content !== "string" ||
    file.content.length > 2 * 1024 * 1024
  ) {
    throw new Error("hosted_pool_setup_conflict");
  }
  return Buffer.from(file.content, "base64").toString("utf8");
}
