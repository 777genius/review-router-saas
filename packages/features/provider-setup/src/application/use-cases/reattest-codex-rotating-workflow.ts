import type {
  CodexRotatingWorkflowReattestation,
  CodexRotatingWorkflowReattestationPort,
} from "../ports/codex-rotating-workflow-reattestation-port";

export function reattestCodexRotatingWorkflow(
  input: CodexRotatingWorkflowReattestation,
  dependencies: {
    readonly workflowReattestation: CodexRotatingWorkflowReattestationPort;
  },
) {
  return dependencies.workflowReattestation.replaceActiveWorkflowSource(input);
}
