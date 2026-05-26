import { RuntimeConfigurationError } from "../domain/errors";
import type {
  AgentCapabilities,
  CompiledRuntimePolicy,
  ProviderCapabilities,
  RuntimePolicy,
  RuntimeWarning,
  RunnerCapabilities,
  SessionStoreCapabilities,
} from "../domain/types";

export type CapabilityDecision =
  | {
      readonly status: "accepted";
      readonly compiledPolicy: CompiledRuntimePolicy;
      readonly warnings: readonly RuntimeWarning[];
    }
  | {
      readonly status: "rejected";
      readonly code:
        | "provider_store_incompatible"
        | "runner_provider_incompatible"
        | "custody_mode_forbidden"
        | "interactive_runtime_forbidden"
        | "missing_required_capability";
      readonly safeMessage: string;
      readonly details: Readonly<Record<string, string>>;
    };

export function assertRuntimeCapabilities(input: {
  readonly provider: ProviderCapabilities;
  readonly agent: AgentCapabilities;
  readonly store: SessionStoreCapabilities;
  readonly runner: RunnerCapabilities;
  readonly policy: RuntimePolicy;
}): void {
  const decision = negotiateCapabilities(input);
  if (decision.status === "rejected") {
    throw new RuntimeConfigurationError(decision.code);
  }
}

export function negotiateCapabilities(input: {
  readonly requested: RuntimePolicy;
  readonly provider: ProviderCapabilities;
  readonly agent: AgentCapabilities;
  readonly store: SessionStoreCapabilities;
  readonly runner: RunnerCapabilities;
}): CapabilityDecision;
export function negotiateCapabilities(input: {
  readonly policy: RuntimePolicy;
  readonly provider: ProviderCapabilities;
  readonly agent: AgentCapabilities;
  readonly store: SessionStoreCapabilities;
  readonly runner: RunnerCapabilities;
}): CapabilityDecision;
export function negotiateCapabilities(input: {
  readonly requested?: RuntimePolicy;
  readonly policy?: RuntimePolicy;
  readonly provider: ProviderCapabilities;
  readonly agent: AgentCapabilities;
  readonly store: SessionStoreCapabilities;
  readonly runner: RunnerCapabilities;
}): CapabilityDecision {
  const policy = input.requested ?? input.policy;
  if (!policy) {
    throw new RuntimeConfigurationError("runtime_policy_missing");
  }

  if (input.provider.providerId !== input.agent.providerId) {
    return rejected("provider_store_incompatible", "Agent/provider mismatch.", {
      providerId: input.provider.providerId,
      agentProviderId: input.agent.providerId,
    });
  }

  if (!policy.allowedProviderIds.includes(input.provider.providerId)) {
    return rejected("missing_required_capability", "Provider is not allowed.", {
      providerId: input.provider.providerId,
    });
  }

  if (!policy.allowedAgentIds.includes(input.agent.agentId)) {
    return rejected("missing_required_capability", "Agent is not allowed.", {
      agentId: input.agent.agentId,
    });
  }

  if (!policy.allowedStoreIds.includes(input.store.storeId)) {
    return rejected("missing_required_capability", "Store is not allowed.", {
      storeId: input.store.storeId,
    });
  }

  if (!policy.allowedRunnerIds.includes(input.runner.runnerId)) {
    return rejected("missing_required_capability", "Runner is not allowed.", {
      runnerId: input.runner.runnerId,
    });
  }

  if (policy.allowInteractiveSetupInRuntime !== false) {
    return rejected(
      "interactive_runtime_forbidden",
      "Interactive setup is forbidden in runtime jobs.",
      {},
    );
  }

  if (policy.custodyMode === "no-plaintext-backend") {
    if (input.store.custody !== "no-plaintext-backend") {
      return rejected(
        "custody_mode_forbidden",
        "Selected store is not compatible with no-custody mode.",
        { storeId: input.store.storeId },
      );
    }
    if (input.store.plaintextAvailableToBackend) {
      return rejected(
        "custody_mode_forbidden",
        "Selected store exposes plaintext to backend.",
        { storeId: input.store.storeId },
      );
    }
  }

  if (policy.requireNoBackendPlaintext && input.store.plaintextAvailableToBackend) {
    return rejected(
      "custody_mode_forbidden",
      "Runtime policy forbids backend plaintext.",
      { storeId: input.store.storeId },
    );
  }

  if (policy.requireCompareAndSwap && !input.store.supportsCompareAndSwap) {
    return rejected(
      "missing_required_capability",
      "Runtime policy requires compare-and-swap writes.",
      { storeId: input.store.storeId },
    );
  }

  if (input.provider.refreshMayRotateSession) {
    if (!input.store.supportsWriteback) {
      return rejected(
        "provider_store_incompatible",
        "Provider can rotate sessions, but store cannot write back.",
        { providerId: input.provider.providerId },
      );
    }
    if (!input.store.supportsIdempotency) {
      return rejected(
        "provider_store_incompatible",
        "Provider can rotate sessions, but store cannot deduplicate writes.",
        { storeId: input.store.storeId },
      );
    }
  }

  if (!input.runner.supportsEnvAllowlist) {
    return rejected(
      "missing_required_capability",
      "Runner must support environment allowlisting.",
      { runnerId: input.runner.runnerId },
    );
  }

  if (
    (input.provider.requiresWorkspace || input.agent.supportsRepositoryContext) &&
    !input.runner.supportsWorkingDirectory
  ) {
    return rejected(
      "runner_provider_incompatible",
      "Provider or agent requires workspace support.",
      { runnerId: input.runner.runnerId },
    );
  }

  if (input.agent.requiresWritableWorkspace && input.runner.readOnlyFilesystem) {
    return rejected(
      "runner_provider_incompatible",
      "Agent requires writable workspace, but runner is read-only.",
      { agentId: input.agent.agentId },
    );
  }

  return {
    status: "accepted",
    compiledPolicy: compileRuntimePolicy({
      requested: policy,
      provider: input.provider,
      agent: input.agent,
      store: input.store,
      runner: input.runner,
    }),
    warnings: [],
  };
}

export function compileRuntimePolicy(input: {
  readonly requested: RuntimePolicy;
  readonly provider: ProviderCapabilities;
  readonly agent: AgentCapabilities;
  readonly store: SessionStoreCapabilities;
  readonly runner: RunnerCapabilities;
}): CompiledRuntimePolicy {
  return {
    trustMode: input.store.custody,
    providerId: input.provider.providerId,
    agentId: input.agent.agentId,
    storeId: input.store.storeId,
    runnerId: input.runner.runnerId,
    requiresDurableWriteback: input.provider.refreshMayRotateSession,
    requiresLease: input.provider.refreshMayRotateSession,
    requiresCas: input.store.supportsCompareAndSwap,
    allowsInteractiveRuntime: false,
    maxSessionBytes: input.store.maxArtifactBytes,
    maxTaskOutputBytes: input.requested.maxTaskOutputBytes ?? 1024 * 1024,
    timeoutMs: Math.min(
      input.provider.defaultTimeoutMs,
      input.agent.maxRuntimeMs,
    ),
  };
}

function rejected(
  code: Exclude<CapabilityDecision, { readonly status: "accepted" }>["code"],
  safeMessage: string,
  details: Readonly<Record<string, string>>,
): CapabilityDecision {
  return {
    status: "rejected",
    code,
    safeMessage,
    details,
  };
}
