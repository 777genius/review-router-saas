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
import type { ActionSessionTokenServicePort } from "../ports/action-session-token-service-port.js";

export type GetActionRuntimeConfigDependencies = {
  readonly repositories: ActionControlPlaneRepositoryPort;
  readonly sessions: ActionSessionTokenServicePort;
  readonly entitlements?: ActionEntitlementPolicyPort;
  readonly clock: Clock;
};

export async function getActionRuntimeConfig(
  input: { readonly sessionToken: string },
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

  const record = await dependencies.repositories.findRuntimeReviewConfiguration(
    {
      workspaceId: session.workspaceId,
      repositoryId: session.repositoryId,
    },
  );
  const config = record?.config ?? safeDefaultReviewConfiguration;
  const version = record?.version ?? 1;

  return {
    protocolVersion: 1,
    configVersion: version,
    provider: {
      kind: config.provider.kind,
      authMode: config.provider.authMode,
      model: config.provider.model,
      reasoningEffort: config.provider.reasoningEffort,
      agenticContext: config.provider.agenticContext,
      secretBackedProviderEnabled: true,
    },
    blockingPolicy: { failOnSeverity: config.blockingPolicy.failOnSeverity },
    limits: {
      inlineMaxComments: config.limits.inlineMaxComments,
      targetTokensPerBatch: config.limits.targetTokensPerBatch,
    },
    runtimeEnv: mapConfigToRuntimeEnv(config),
  };
}
