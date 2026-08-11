import type { CodexRotatingSetupReadinessTarget } from "../../domain/codex-rotating-setup-readiness";
import type { CodexRotatingWorkflowNamespaceInspection } from "../../domain/codex-rotating-workflow-namespace";

export interface CodexRotatingWorkflowNamespacePort {
  inspectWorkflowNamespace(
    target: CodexRotatingSetupReadinessTarget,
  ): Promise<CodexRotatingWorkflowNamespaceInspection>;
}
