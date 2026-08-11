import type { CodexRotatingSetupReadinessTarget } from "../../domain/codex-rotating-setup-readiness";
import type { CodexRotatingWorkflowNamespacePort } from "../ports/codex-rotating-workflow-namespace-port";

export function inspectCodexRotatingWorkflowNamespace(
  target: CodexRotatingSetupReadinessTarget,
  dependencies: {
    readonly workflowNamespace: CodexRotatingWorkflowNamespacePort;
  },
) {
  return dependencies.workflowNamespace.inspectWorkflowNamespace(target);
}
