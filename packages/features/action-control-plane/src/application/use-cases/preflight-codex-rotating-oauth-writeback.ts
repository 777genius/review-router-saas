import type { Clock } from "@reviewrouter/shared";
import type {
  CodexRotatingGitHubSecretWriterPort,
  CodexRotatingOAuthRepositoryPort,
} from "../ports/codex-rotating-oauth-repository-port.js";

export type PreflightCodexRotatingOAuthWritebackDependencies = {
  readonly codexRotatingOAuth: CodexRotatingOAuthRepositoryPort;
  readonly codexRotatingSecretWriter: CodexRotatingGitHubSecretWriterPort;
  readonly clock: Clock;
};

export async function preflightCodexRotatingOAuthWriteback(
  input: {
    readonly leaseId: string;
    readonly providerInstanceId: string;
    readonly githubKeyId: string;
  },
  dependencies: PreflightCodexRotatingOAuthWritebackDependencies,
): Promise<
  | { readonly protocolVersion: 1; readonly status: "ready" }
  | {
      readonly protocolVersion: 1;
      readonly status: "skipped";
      readonly reason:
        | "lease_not_active"
        | "stale_queued_secret"
        | "permission_required";
    }
> {
  const preflight = await dependencies.codexRotatingOAuth.preflightWriteback({
    ...input,
    now: dependencies.clock.now(),
  });
  if (preflight.status !== "ready") {
    return {
      protocolVersion: 1,
      status: "skipped",
      reason: preflight.status,
    };
  }

  await dependencies.codexRotatingSecretWriter.assertCanWriteRepositorySecret(
    preflight.writeTarget,
  );
  return { protocolVersion: 1, status: "ready" };
}
