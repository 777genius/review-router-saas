import type { Clock } from "@reviewrouter/shared";
import type { CodexRotatingOAuthRepositoryPort } from "../ports/codex-rotating-oauth-repository-port.js";

export type AbandonCodexRotatingOAuthLeaseDependencies = {
  readonly codexRotatingOAuth: CodexRotatingOAuthRepositoryPort;
  readonly clock: Clock;
};

export async function abandonCodexRotatingOAuthLease(
  input: {
    readonly leaseId: string;
    readonly providerInstanceId: string;
    readonly reason: "needs_reconnect" | "unknown_auth_state";
  },
  dependencies: AbandonCodexRotatingOAuthLeaseDependencies,
): Promise<{
  readonly protocolVersion: 1;
  readonly status: "abandoned" | "lease_not_active";
}> {
  const result = await dependencies.codexRotatingOAuth.abandonLease({
    ...input,
    now: dependencies.clock.now(),
  });
  return {
    protocolVersion: 1,
    status: result.status,
  };
}
