import {
  mapConfigToRuntimeEnv,
  safeDefaultReviewConfiguration,
} from "@reviewrouter/features-review-config";
import type { Clock } from "@reviewrouter/shared";
import type {
  CodexRotatingGitHubSecretTokenIssuerPort,
  CodexRotatingOAuthRepositoryPort,
} from "../ports/codex-rotating-oauth-repository-port.js";
import type { ActionControlPlaneRepositoryPort } from "../ports/action-control-plane-repository-port.js";
import type { ActionLedgerKeyPort } from "../ports/action-ledger-key-port.js";

export type FinalizeCodexRotatingOAuthLeaseDependencies = {
  readonly codexRotatingOAuth: CodexRotatingOAuthRepositoryPort;
  readonly codexRotatingSecretsReadTokens: CodexRotatingGitHubSecretTokenIssuerPort;
  readonly repositories: Pick<
    ActionControlPlaneRepositoryPort,
    "findRuntimeReviewConfiguration"
  >;
  readonly ledgerKeys?: ActionLedgerKeyPort;
  readonly clock: Clock;
};

export async function finalizeCodexRotatingOAuthLease(
  input: {
    readonly leaseId: string;
    readonly providerInstanceId: string;
    readonly restoredGenerationHash: string;
  },
  dependencies: FinalizeCodexRotatingOAuthLeaseDependencies,
): Promise<
  {
    readonly protocolVersion: 1;
    readonly leaseId: string;
    readonly nextGeneration: number;
  } & (
    | {
        readonly status: "finalized";
        readonly repositoryOwner: string;
        readonly repositoryName: string;
        readonly publicKeyReadToken: string;
        readonly publicKeyReadTokenExpiresAt: string;
        readonly runtimeConfigVersion: number;
        readonly runtimeEnv: Record<string, string>;
      }
    | {
        readonly status: "stale_queued_secret";
      }
  )
> {
  const result = await dependencies.codexRotatingOAuth.finalizeLease({
    ...input,
    now: dependencies.clock.now(),
  });
  if (result.status !== "finalized") {
    return {
      protocolVersion: 1,
      leaseId: result.leaseId,
      nextGeneration: result.nextGeneration,
      status: result.status,
    };
  }
  if (!result.repository) {
    throw new Error("codex_rotating_repository_context_missing");
  }

  const token =
    await dependencies.codexRotatingSecretsReadTokens.issueSecretsReadToken({
      githubInstallationId: result.repository.githubInstallationId,
      githubRepositoryId: result.repository.githubRepositoryId,
      repositoryFullName: result.repository.fullName,
    });
  const runtimeConfig =
    await dependencies.repositories.findRuntimeReviewConfiguration({
      workspaceId: result.repository.workspaceId,
      repositoryId: result.repository.repositoryId,
    });
  const runtimeEnv = mapConfigToRuntimeEnv(
    runtimeConfig?.config ?? safeDefaultReviewConfiguration,
  );
  const ledgerKey = dependencies.ledgerKeys?.deriveLedgerKey?.({
    workspaceId: result.repository.workspaceId,
    repositoryId: result.repository.repositoryId,
    githubRepositoryId: result.repository.githubRepositoryId,
    repositoryFullName: result.repository.fullName,
  });
  if (ledgerKey) {
    runtimeEnv.REVIEW_ROUTER_LEDGER_KEY = ledgerKey;
  }
  return {
    protocolVersion: 1,
    leaseId: result.leaseId,
    nextGeneration: result.nextGeneration,
    status: result.status,
    repositoryOwner: result.repository.owner,
    repositoryName: result.repository.fullName.slice(
      result.repository.owner.length + 1,
    ),
    publicKeyReadToken: token.token,
    publicKeyReadTokenExpiresAt: token.expiresAt.toISOString(),
    runtimeConfigVersion: runtimeConfig?.version ?? 1,
    runtimeEnv,
  };
}
