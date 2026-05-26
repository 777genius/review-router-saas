import type {
  AgentCapabilities,
  ProviderCapabilities,
} from "@reviewrouter/subscription-runtime-core";

export const codexProviderId = "codex";
export const codexAgentId = "codex-cli";
export const codexAuthJsonFormatVersion = "codex-auth-json-v1";

export const codexSessionCapabilities: ProviderCapabilities = {
  providerId: codexProviderId,
  displayName: "Codex",
  sessionArtifactKinds: ["json-file"],
  supportsRefresh: true,
  refreshMayRotateSession: true,
  supportsNonInteractiveRuntime: true,
  requiresNetwork: true,
  requiresWorkspace: true,
  supportsStructuredOutput: true,
  supportsReadOnlySandbox: true,
  defaultTimeoutMs: 600_000,
  setupModes: ["device-auth", "import-local-session"],
};

export const codexAgentCapabilities: AgentCapabilities = {
  agentId: codexAgentId,
  providerId: codexProviderId,
  supportsReviewTasks: true,
  supportsStructuredOutput: true,
  supportsToolCalling: false,
  supportsRepositoryContext: true,
  supportsInlineFindings: true,
  requiresWritableWorkspace: false,
  maxRuntimeMs: 600_000,
};
