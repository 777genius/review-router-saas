import {
  mapConfigToRuntimeEnv,
  safeDefaultReviewConfiguration,
  type ReviewConfiguration,
} from "@reviewrouter/features-review-config";
import type { Clock } from "@reviewrouter/shared";
import {
  buildActionConflictReviewRuntimeConfig,
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

const codexRotatingRuntimeWorkflowPaths = new Set([
  ".github/workflows/reviewrouter-codex.yml",
  ".github/workflows/reviewrouter-interaction.yml",
]);

export type GetActionRuntimeConfigDependencies = {
  readonly repositories: ActionControlPlaneRepositoryPort;
  readonly sessions: ActionSessionTokenServicePort;
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
  const config = record?.config ?? safeDefaultReviewConfiguration;
  assertStandardRuntimeProviderSupport(config, session);
  if (session.reviewKind === "conflict-head") {
    assertConflictRuntimeProviderSupport(config);
  }
  const version = record?.version ?? 1;
  const runtimeEnv = mapConfigToRuntimeEnv(config);
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
    ...(conflictReviewRuntimeConfig
      ? { conflictReview: conflictReviewRuntimeConfig }
      : {}),
  };
}

function assertStandardRuntimeProviderSupport(
  config: ReviewConfiguration,
  session: ActionSessionClaims,
): void {
  const codexProvider = config.providers.find(
    (provider) => provider.kind === "codex",
  );
  if (!codexProvider) {
    return;
  }
  if (
    codexProvider.authMode === "codex_subscription_oauth_rotating" &&
    session.workflowPath &&
    codexRotatingRuntimeWorkflowPaths.has(session.workflowPath)
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
