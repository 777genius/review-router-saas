export type HostedCodexCanaryFault =
  | "synthetic_unauthorized"
  | "synthetic_rate_limited"
  | "drop_after_response_started";

export type HostedCodexCanaryFaultInjectionPoint =
  | "before_provider_fetch"
  | "after_response_started";

export const hostedCodexCanaryFaultPlanTokenMaxBytes = 8_192;
export const hostedCodexCanaryFaultPlanMaxLifetimeMs = 60 * 60_000;

export type HostedCodexCanaryFaultScope = Readonly<{
  workspaceId: string;
  githubRepositoryId: bigint;
  runId: string;
  runAttempt: number;
  actionRef: string;
  repositoryBindingId: string;
  bindingRevision: bigint;
  requestOrdinal: number;
  attemptOrdinal: number;
  injectionPoint: HostedCodexCanaryFaultInjectionPoint;
}>;

/**
 * Operator-control-plane authority for a single production-canary fault.
 *
 * Implementations must fail closed, authenticate independently of repository
 * inputs, and atomically consume a matching plan before returning a fault.
 */
export interface HostedCodexCanaryFaultPlanPort {
  consume(
    scope: HostedCodexCanaryFaultScope,
  ): Promise<HostedCodexCanaryFault | null>;
}

export const noHostedCodexCanaryFaultPlan: HostedCodexCanaryFaultPlanPort =
  Object.freeze({
    async consume() {
      return null;
    },
  });
