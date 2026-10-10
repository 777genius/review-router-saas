import {
  effectiveInlineMaxComments,
  mapConfigToRuntimeEnv,
  parseReviewConfigurationStrict,
  safeDefaultReviewConfiguration,
  type ReviewConfiguration,
} from "@reviewrouter/features-review-config";
import type { Clock } from "@reviewrouter/shared";
import { codexWorkflowPathForRepository } from "@reviewrouter/features-codex-oauth-rotating";
import {
  buildActionConflictReviewRuntimeConfig,
  isManagedV2SessionBootstrapSource,
  managedInteractionWorkflowPath,
  validateActionSessionAgainstRepository,
  type ActionSessionClaims,
  type ActionRuntimeConfigResponse,
} from "../../domain/action-control-plane.js";
import type { ActionEntitlementPolicyPort } from "../ports/action-entitlement-policy-port.js";
import {
  runtimeReviewConfigurationSnapshotId,
  type ActionControlPlaneRepositoryPort,
} from "../ports/action-control-plane-repository-port.js";
import type { ActionConflictReviewRuntimeGatePort } from "../ports/action-conflict-review-runtime-gate-port.js";
import type { ActionRuntimeCompatibilityPolicyPort } from "../ports/action-runtime-compatibility-policy-port.js";
import type { ActionLedgerKeyPort } from "../ports/action-ledger-key-port.js";
import type { ActionSessionTokenServicePort } from "../ports/action-session-token-service-port.js";

export type GetActionRuntimeConfigDependencies = {
  readonly repositories: ActionControlPlaneRepositoryPort;
  readonly sessions: ActionSessionTokenServicePort;
  readonly defaultProvider?: {
    readonly model: string;
    readonly reasoningEffort: ReviewConfiguration["provider"]["reasoningEffort"];
  };
  readonly entitlements?: ActionEntitlementPolicyPort;
  readonly conflictReviewRuntimeGate?: ActionConflictReviewRuntimeGatePort;
  readonly conflictReviewPostingAvailable?: boolean;
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
  if (session.reviewKind === "conflict-head") {
    await dependencies.conflictReviewRuntimeGate?.assertConflictReviewRuntimeEnabled(
      {
        phase: "runtime_config",
        workspaceId: session.workspaceId,
        repositoryId: session.repositoryId,
        repositoryFullName: session.repository,
      },
    );
    assertConflictRuntimeActionVersionAllowed(input.actionVersion);
  }

  const record = await dependencies.repositories.findRuntimeReviewConfiguration(
    {
      workspaceId: session.workspaceId,
      repositoryId: session.repositoryId,
    },
  );
  const snapshotId = runtimeReviewConfigurationSnapshotId(record);
  if (session.reviewKind === "conflict-head") {
    if (!session.configSnapshotId) {
      throw new Error("conflict_review_config_snapshot_required");
    }
    if (session.configSnapshotId !== snapshotId) {
      throw new Error("conflict_review_config_snapshot_mismatch");
    }
  }
  const config =
    record?.config ??
    buildDefaultReviewConfiguration(dependencies.defaultProvider);
  assertStandardRuntimeProviderSupport(config, session, repository);
  if (session.reviewKind === "conflict-head") {
    assertConflictRuntimeProviderSupport(config);
  }
  const version = record?.version ?? 1;
  const runtimeEnv = mapConfigToRuntimeEnv(config);
  const primaryProvider = config.providers[0]!;
  if (primaryProvider.authMode === "codex_account_gateway") {
    // The existing plan emits auth/model settings but only validates references.
    // Carry those references in the extensible nonsecret config environment.
    // Safe saved selection only. Admission still resolves live server authority.
    runtimeEnv.REVIEW_ROUTER_GATEWAY_BINDING_ID =
      primaryProvider.gatewayBindingId;
    runtimeEnv.REVIEW_ROUTER_GATEWAY_PROFILE_REF =
      primaryProvider.gatewayProfileRef;
  }
  const conflictReviewRuntimeConfig =
    session.reviewKind === "conflict-head"
      ? buildActionConflictReviewRuntimeConfig(session, {
          postingMode:
            dependencies.conflictReviewPostingAvailable === true
              ? "proxy"
              : "disabled",
        })
      : undefined;
  await dependencies.compatibility?.assertRuntimeConfigAllowed({
    protocolVersion: 1,
    ...(input.actionVersion ? { actionVersion: input.actionVersion } : {}),
    providerKinds: [
      ...new Set(config.providers.map((provider) => provider.kind)),
    ],
    providerAuthModes: [
      ...new Set(config.providers.map((provider) => provider.authMode)),
    ],
  });
  const ledgerKey = dependencies.ledgerKeys?.deriveLedgerKey({
    workspaceId: repository.workspaceId,
    repositoryId: repository.repositoryId,
    githubRepositoryId: repository.githubRepositoryId,
    repositoryFullName: repository.fullName,
  });
  if (ledgerKey) {
    runtimeEnv.REVIEW_ROUTER_LEDGER_KEY = ledgerKey;
  }
  if (conflictReviewRuntimeConfig) {
    runtimeEnv.REVIEW_ROUTER_REVIEW_KIND = "conflict-head";
    runtimeEnv.REVIEW_ROUTER_CONFLICT_DISPATCH_ID =
      conflictReviewRuntimeConfig.dispatchId;
    runtimeEnv.REVIEW_ROUTER_CONFLICT_PR_NUMBER = String(
      conflictReviewRuntimeConfig.pullRequestNumber,
    );
    runtimeEnv.REVIEW_ROUTER_CONFLICT_HEAD_SHA =
      conflictReviewRuntimeConfig.headSha;
    runtimeEnv.REVIEW_ROUTER_CONFLICT_BASE_REF =
      conflictReviewRuntimeConfig.baseRef;
    runtimeEnv.REVIEW_ROUTER_CONFLICT_BASE_SHA =
      conflictReviewRuntimeConfig.baseSha;
  }
  const providers = config.providers.map((provider) => ({
    kind: provider.kind,
    authMode: provider.authMode,
    model: provider.model,
    reasoningEffort: provider.reasoningEffort,
    agenticContext: provider.agenticContext,
    fastMode: provider.fastMode,
    requiredHealthy: provider.requiredHealthy,
    secretBackedProviderEnabled: provider.authMode !== "codex_account_gateway",
  }));

  return {
    protocolVersion: 1,
    configVersion: version,
    provider: providers[0]!,
    providers,
    execution: config.execution,
    blockingPolicy: { failOnSeverity: config.blockingPolicy.failOnSeverity },
    limits: {
      inlineMaxComments: effectiveInlineMaxComments(
        config.limits.inlineMaxComments,
      ),
      targetTokensPerBatch: config.limits.targetTokensPerBatch,
    },
    runtimeEnv,
    ...(conflictReviewRuntimeConfig
      ? { conflictReview: conflictReviewRuntimeConfig }
      : {}),
  };
}

function buildDefaultReviewConfiguration(
  providerDefaults: GetActionRuntimeConfigDependencies["defaultProvider"],
): ReviewConfiguration {
  if (!providerDefaults) {
    return safeDefaultReviewConfiguration;
  }
  const provider = {
    ...safeDefaultReviewConfiguration.provider,
    model: providerDefaults.model,
    reasoningEffort: providerDefaults.reasoningEffort,
  };
  return parseReviewConfigurationStrict({
    ...safeDefaultReviewConfiguration,
    provider,
    providers: [provider],
  });
}

function assertStandardRuntimeProviderSupport(
  config: ReviewConfiguration,
  session: ActionSessionClaims,
  repository: Readonly<{
    githubRepositoryId: string;
    fullName: string;
  }>,
): void {
  const gatewayProvider = config.providers.find(
    (provider) => provider.authMode === "codex_account_gateway",
  );
  if (gatewayProvider) {
    // Keep conflict consumers on their existing adapters. A gateway selection
    // cannot authorize a legacy workflow or a different event/runtime kind.
    if (
      session.reviewKind === "conflict-head" ||
      !session.workflowPath ||
      !isManagedV2SessionBootstrapSource({
        eventName: session.eventName,
        workflowPath: session.workflowPath,
        githubRepositoryId: repository.githubRepositoryId,
        repositoryFullName: repository.fullName,
      })
    ) {
      throw new Error("codex_provider_requires_rotating_workflow");
    }
    // The effective auth mode is primary-only and downstream admission owns
    // one gateway profile. Mixed providers could select static credentials.
    if (config.providers.length !== 1) {
      throw new Error("codex_gateway_single_provider_required");
    }
    // Reuse the saved configuration validator; never accept client selectors,
    // secret-shaped references or an incompatible provider kind as authority.
    parseReviewConfigurationStrict(config);
    return;
  }
  const codexProvider = config.providers.find(
    (provider) => provider.kind === "codex",
  );
  if (!codexProvider) {
    return;
  }
  if (
    codexProvider.authMode === "codex_subscription_oauth_rotating" &&
    session.workflowPath &&
    (session.workflowPath === managedInteractionWorkflowPath ||
      session.workflowPath ===
        codexWorkflowPathForRepository({
          repositoryId: repository.githubRepositoryId,
          repositoryFullName: repository.fullName,
        }))
  ) {
    return;
  }
  throw new Error(
    codexProvider.authMode === "codex_subscription_oauth"
      ? "codex_legacy_auth_requires_reconnect"
      : "codex_provider_requires_rotating_workflow",
  );
}

function assertConflictRuntimeActionVersionAllowed(
  actionVersion: string | undefined,
): void {
  const version = actionVersion?.trim();
  if (!version) {
    throw new Error("conflict_runtime_version_required");
  }
  if (!/^(?:v1(?:\.[0-9]+\.[0-9]+)?|[a-fA-F0-9]{40})$/.test(version)) {
    throw new Error(`conflict_runtime_version_unsupported:${version}`);
  }
}

function assertConflictRuntimeProviderSupport(
  config: ReviewConfiguration,
): void {
  const unsupportedProvider = config.providers.find(
    (provider) => provider.kind !== "codex",
  );
  if (unsupportedProvider) {
    throw new Error(
      `conflict_runtime_provider_unsupported:${unsupportedProvider.kind}`,
    );
  }
  if (
    config.providers.length !== 1 ||
    config.execution.providerLimit !== 1 ||
    config.execution.providerMaxParallel !== 1 ||
    config.execution.inlineMinAgreement !== 1
  ) {
    throw new Error("conflict_runtime_provider_unsupported:multi_provider");
  }
}
