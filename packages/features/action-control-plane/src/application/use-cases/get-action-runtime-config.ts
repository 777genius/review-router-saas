import {
  mapConfigToRuntimeEnv,
  safeDefaultReviewConfiguration,
} from "@reviewrouter/features-review-config";
import type { Clock } from "@reviewrouter/shared";
import {
  validateActionSessionAgainstRepository,
  type ActionRuntimeConfigResponse,
} from "../../domain/action-control-plane.js";
import type { ActionEntitlementPolicyPort } from "../ports/action-entitlement-policy-port.js";
import type { ActionControlPlaneRepositoryPort } from "../ports/action-control-plane-repository-port.js";
import type { ActionRuntimeCompatibilityPolicyPort } from "../ports/action-runtime-compatibility-policy-port.js";
import type { ActionLedgerKeyPort } from "../ports/action-ledger-key-port.js";
import type { ActionSessionTokenServicePort } from "../ports/action-session-token-service-port.js";

export type GetActionRuntimeConfigDependencies = {
  readonly repositories: ActionControlPlaneRepositoryPort;
  readonly sessions: ActionSessionTokenServicePort;
  readonly entitlements?: ActionEntitlementPolicyPort;
  readonly compatibility?: ActionRuntimeCompatibilityPolicyPort;
  readonly ledgerKeys?: ActionLedgerKeyPort;
  readonly clock: Clock;
};

export async function getActionRuntimeConfig(
  input: { readonly sessionToken: string; readonly actionVersion?: string },
  dependencies: GetActionRuntimeConfigDependencies,
): Promise<ActionRuntimeConfigResponse> {
  const session = await dependencies.sessions.verify({
    token: input.sessionToken,
    now: dependencies.clock.now(),
  });
  const repository =
    await dependencies.repositories.findSelectedRepositoryByGithubId(
      session.githubRepositoryId,
    );
  if (!repository) {
    throw new Error("repository_not_registered");
  }
  validateActionSessionAgainstRepository({ session, repository });

  await dependencies.entitlements?.assertActionControlPlaneAllowed({
    workspaceId: session.workspaceId,
    repositoryId: session.repositoryId,
    repositoryFullName: session.repository,
  });
  await dependencies.compatibility?.assertRuntimeConfigAllowed({
    protocolVersion: 1,
    ...(input.actionVersion ? { actionVersion: input.actionVersion } : {}),
  });

  const record = await dependencies.repositories.findRuntimeReviewConfiguration(
    {
      workspaceId: session.workspaceId,
      repositoryId: session.repositoryId,
    },
  );
  const config = record?.config ?? safeDefaultReviewConfiguration;
  const version = record?.version ?? 1;
  const runtimeEnv = mapConfigToRuntimeEnv(config);
  const ledgerKey = dependencies.ledgerKeys?.deriveLedgerKey({
    workspaceId: repository.workspaceId,
    repositoryId: repository.repositoryId,
    githubRepositoryId: repository.githubRepositoryId,
    repositoryFullName: repository.fullName,
  });
  if (ledgerKey) {
    runtimeEnv.REVIEW_ROUTER_LEDGER_KEY = ledgerKey;
  }
  const providers = config.providers.map((provider) => ({
    kind: provider.kind,
    authMode: provider.authMode,
    model: provider.model,
    reasoningEffort: provider.reasoningEffort,
    agenticContext: provider.agenticContext,
    fastMode: provider.fastMode,
    secretBackedProviderEnabled: true,
  }));

  return {
    protocolVersion: 1,
    configVersion: version,
    provider: providers[0]!,
    providers,
    execution: config.execution,
    blockingPolicy: { failOnSeverity: config.blockingPolicy.failOnSeverity },
    limits: {
      inlineMaxComments: config.limits.inlineMaxComments,
      targetTokensPerBatch: config.limits.targetTokensPerBatch,
    },
    runtimeEnv,
  };
}
