import type { ScmProvider } from "@reviewrouter/shared";
import { isCodexBackedProvider } from "@reviewrouter/features-review-providers";
import type {
  ReviewConfiguration,
  ReviewInvestigationRolloutConfiguration,
} from "../../domain/review-configuration";
import { ReviewReasoningEffort } from "../../domain/review-reasoning-effort";
import {
  isReviewConfigurationWriteConflictError,
  type ReviewConfigurationRepositoryPort,
} from "../ports/review-configuration-repository-port";
import {
  ReviewConfigurationOperatorOperation,
  type ReviewConfigurationOperatorAuditPort,
  type ReviewConfigurationOperatorAuthorizationPort,
  type ReviewConfigurationOperatorPrincipal,
  type ReviewConfigurationOperatorRateLimitPort,
  type ReviewConfigurationOperatorMutationPort,
  type ReviewConfigurationOperatorRepository,
  type ReviewConfigurationOperatorRepositoryPort,
} from "../ports/review-configuration-operator-ports";
import {
  resolveReviewConfiguration,
  type ResolvedReviewConfigurationSource,
} from "./resolve-review-configuration";

export enum ReviewConfigurationOperatorErrorCode {
  Unauthorized = "unauthorized",
  RepositoryNotFound = "repository_not_found",
  RepositoryAmbiguous = "repository_ambiguous",
  InvalidRepository = "invalid_repository",
  RateLimited = "rate_limited",
  ReviewProviderNotFound = "review_provider_not_found",
  ConfigurationChanged = "configuration_changed",
  InvalidInvestigationRollout = "invalid_investigation_rollout",
}

export class ReviewConfigurationOperatorError extends Error {
  constructor(readonly code: ReviewConfigurationOperatorErrorCode) {
    super(`review_configuration_operator_${code}`);
    this.name = "ReviewConfigurationOperatorError";
  }
}

export type OperatorReviewConfiguration = Readonly<{
  repository: string;
  provider: ScmProvider;
  sourceBaseUrl: string;
  workspaceId: string;
  workspaceSlug: string;
  source: ResolvedReviewConfigurationSource;
  version: number;
  repositoryVersion: number | null;
  reasoningEffort: ReviewReasoningEffort | null;
  investigationRollout: ReviewInvestigationRolloutConfiguration;
  providers: number;
}>;

export type SetOperatorReviewReasoningEffortResult =
  OperatorReviewConfiguration &
    Readonly<{
      changed: boolean;
      previousSource: ResolvedReviewConfigurationSource;
      previousVersion: number;
    }>;

export type SetOperatorReviewInvestigationRolloutResult =
  OperatorReviewConfiguration &
    Readonly<{
      previousSource: ResolvedReviewConfigurationSource;
      previousVersion: number;
      previousRepositoryVersion: number | null;
      previousInvestigationRollout: ReviewInvestigationRolloutConfiguration;
    }>;

export type OperatorReviewConfigurationDependencies = Readonly<{
  authorization: ReviewConfigurationOperatorAuthorizationPort;
  rateLimits: ReviewConfigurationOperatorRateLimitPort;
  repositories: ReviewConfigurationOperatorRepositoryPort;
  configurations: ReviewConfigurationRepositoryPort;
  mutations: ReviewConfigurationOperatorMutationPort;
  audit: ReviewConfigurationOperatorAuditPort;
}>;

type OperatorReviewConfigurationInput = Readonly<{
  credential: string;
  repositoryFullName: string;
  provider: ScmProvider;
  workspace?: string;
  sourceBaseUrl?: string;
  reason?: string;
}>;

export async function getOperatorReviewConfiguration(
  input: OperatorReviewConfigurationInput,
  dependencies: OperatorReviewConfigurationDependencies,
): Promise<OperatorReviewConfiguration> {
  const principal = await authorize(
    input.credential,
    ReviewConfigurationOperatorOperation.Read,
    dependencies.authorization,
  );
  await assertRateLimit(
    input,
    principal,
    ReviewConfigurationOperatorOperation.Read,
    dependencies,
  );
  const repository = await resolveRepository(input, dependencies.repositories);
  const target = repositoryTarget(repository);
  const resolved = await resolveReviewConfiguration(target, dependencies);

  await dependencies.audit.record({
    workspaceId: repository.workspaceId,
    actor: principal.operatorId,
    action: "review_config.operator_read",
    targetType: "repository",
    targetId: repository.id,
    metadata: {
      repository: repository.fullName,
      provider: repository.provider,
      source: resolved.source,
      version: resolved.version,
    },
  });

  return toOperatorReviewConfiguration(repository, resolved);
}

export async function setOperatorReviewReasoningEffort(
  input: OperatorReviewConfigurationInput &
    Readonly<{ effort: ReviewReasoningEffort }>,
  dependencies: OperatorReviewConfigurationDependencies,
): Promise<SetOperatorReviewReasoningEffortResult> {
  const principal = await authorize(
    input.credential,
    ReviewConfigurationOperatorOperation.SetReasoningEffort,
    dependencies.authorization,
  );
  await assertRateLimit(
    input,
    principal,
    ReviewConfigurationOperatorOperation.SetReasoningEffort,
    dependencies,
  );
  const repository = await resolveRepository(input, dependencies.repositories);
  const target = repositoryTarget(repository);
  const previous = await resolveReviewConfiguration(target, dependencies);
  const updatedConfig = withReasoningEffort(previous.config, input.effort);
  const currentProvider = previous.config.providers.find(isCodexBackedProvider);
  const alreadyExplicitAndEqual =
    previous.source === "repository" &&
    currentProvider?.reasoningEffort === input.effort;
  const auditEvent = {
    workspaceId: repository.workspaceId,
    actor: principal.operatorId,
    action: "review_config.operator_reasoning_effort_set",
    targetType: "repository",
    targetId: repository.id,
    metadata: {
      repository: repository.fullName,
      provider: repository.provider,
      effort: input.effort,
      changed: !alreadyExplicitAndEqual,
      previousSource: previous.source,
      previousVersion: previous.version,
      providers: updatedConfig.providers.length,
      reviewProvider: "codex-backed",
      reason: normalizeReason(input.reason),
    },
  } as const;
  let saved: { readonly version: number; readonly config: ReviewConfiguration };
  try {
    saved = alreadyExplicitAndEqual
      ? { version: previous.version, config: previous.config }
      : await dependencies.mutations.commit({
          target,
          expectedRevisionToken: previous.revisionToken,
          config: updatedConfig,
          auditEvent,
        });
  } catch (error) {
    if (isReviewConfigurationWriteConflictError(error)) {
      throw new ReviewConfigurationOperatorError(
        ReviewConfigurationOperatorErrorCode.ConfigurationChanged,
      );
    }
    throw error;
  }

  if (alreadyExplicitAndEqual) {
    await dependencies.audit.record({
      ...auditEvent,
      metadata: { ...auditEvent.metadata, version: saved.version },
    });
  }

  return {
    ...toOperatorReviewConfiguration(repository, {
      source: "repository",
      version: saved.version,
      config: saved.config,
    }),
    changed: !alreadyExplicitAndEqual,
    previousSource: previous.source,
    previousVersion: previous.version,
  };
}

export async function setOperatorReviewInvestigationRollout(
  input: OperatorReviewConfigurationInput &
    Readonly<{
      expectedCurrentVersion: number | null;
      investigationRollout: ReviewInvestigationRolloutConfiguration;
    }>,
  dependencies: OperatorReviewConfigurationDependencies,
): Promise<SetOperatorReviewInvestigationRolloutResult> {
  const principal = await authorize(
    input.credential,
    ReviewConfigurationOperatorOperation.SetInvestigationRollout,
    dependencies.authorization,
  );
  await assertRateLimit(
    input,
    principal,
    ReviewConfigurationOperatorOperation.SetInvestigationRollout,
    dependencies,
  );
  const repository = await resolveRepository(input, dependencies.repositories);
  const target = repositoryTarget(repository);
  const previous = await resolveReviewConfiguration(target, dependencies);
  const previousRepositoryVersion =
    previous.source === "repository" ? previous.version : null;
  if (previousRepositoryVersion !== input.expectedCurrentVersion) {
    throw new ReviewConfigurationOperatorError(
      ReviewConfigurationOperatorErrorCode.ConfigurationChanged,
    );
  }
  assertValidInvestigationRollout(input.investigationRollout);

  const auditEvent = {
    workspaceId: repository.workspaceId,
    actor: principal.operatorId,
    action: "review_config.operator_investigation_rollout_set",
    targetType: "repository",
    targetId: repository.id,
    metadata: {
      repository: repository.fullName,
      provider: repository.provider,
      expectedCurrentVersion: input.expectedCurrentVersion,
      previousSource: previous.source,
      previousVersion: previous.version,
      previousRepositoryVersion,
      previousInvestigationRollout: previous.config.investigationRollout,
      investigationRollout: input.investigationRollout,
      reason: normalizeReason(
        input.reason,
        "operator_investigation_rollout_set",
      ),
    },
  } as const;

  let saved: { readonly version: number; readonly config: ReviewConfiguration };
  try {
    saved = await dependencies.mutations.commit({
      target,
      expectedRevisionToken: previous.revisionToken,
      config: {
        ...previous.config,
        investigationRollout: { ...input.investigationRollout },
      },
      auditEvent,
    });
  } catch (error) {
    if (isReviewConfigurationWriteConflictError(error)) {
      throw new ReviewConfigurationOperatorError(
        ReviewConfigurationOperatorErrorCode.ConfigurationChanged,
      );
    }
    throw error;
  }

  return {
    ...toOperatorReviewConfiguration(repository, {
      source: "repository",
      version: saved.version,
      config: saved.config,
    }),
    previousSource: previous.source,
    previousVersion: previous.version,
    previousRepositoryVersion,
    previousInvestigationRollout: previous.config.investigationRollout,
  };
}

function assertValidInvestigationRollout(
  rollout: ReviewInvestigationRolloutConfiguration,
): void {
  const valid =
    (!rollout.shadowEnabled || rollout.recordingEnabled) &&
    (!rollout.contextCriticEnabled || rollout.shadowEnabled) &&
    (!rollout.productionEffectsEnabled ||
      (rollout.shadowEnabled && rollout.contextCriticEnabled)) &&
    (!rollout.verifiedCleanEnabled ||
      (rollout.contextCriticEnabled && rollout.productionEffectsEnabled)) &&
    (!rollout.crossRevisionReplayEnabled || rollout.shadowEnabled);
  if (!valid) {
    throw new ReviewConfigurationOperatorError(
      ReviewConfigurationOperatorErrorCode.InvalidInvestigationRollout,
    );
  }
}

function normalizeReason(
  reason: string | undefined,
  fallback = "operator_cli_config_set",
): string {
  const normalized = reason?.trim() || fallback;
  return normalized.slice(0, 120);
}

async function assertRateLimit(
  input: OperatorReviewConfigurationInput,
  principal: ReviewConfigurationOperatorPrincipal,
  operation: ReviewConfigurationOperatorOperation,
  dependencies: Pick<OperatorReviewConfigurationDependencies, "rateLimits">,
): Promise<void> {
  const repositoryFullName = normalizeRepositoryFullName(
    input.repositoryFullName,
  );
  const allowed = await dependencies.rateLimits.consume({
    operatorId: principal.operatorId,
    operation,
    repositoryFullName: repositoryFullName.toLowerCase(),
  });
  if (!allowed) {
    throw new ReviewConfigurationOperatorError(
      ReviewConfigurationOperatorErrorCode.RateLimited,
    );
  }
}

async function authorize(
  credential: string,
  operation: ReviewConfigurationOperatorOperation,
  authorization: ReviewConfigurationOperatorAuthorizationPort,
): Promise<ReviewConfigurationOperatorPrincipal> {
  if (credential.length < 1 || credential.length > 8_192) {
    throw new ReviewConfigurationOperatorError(
      ReviewConfigurationOperatorErrorCode.Unauthorized,
    );
  }
  const principal = await authorization.authenticate({ credential, operation });
  if (!principal) {
    throw new ReviewConfigurationOperatorError(
      ReviewConfigurationOperatorErrorCode.Unauthorized,
    );
  }
  return principal;
}

async function resolveRepository(
  input: OperatorReviewConfigurationInput,
  repositories: ReviewConfigurationOperatorRepositoryPort,
): Promise<ReviewConfigurationOperatorRepository> {
  const repositoryFullName = normalizeRepositoryFullName(
    input.repositoryFullName,
  );
  const candidates = await repositories.findActiveCandidates({
    provider: input.provider,
    repositoryFullName,
    ...(input.workspace?.trim() ? { workspace: input.workspace.trim() } : {}),
    ...(input.sourceBaseUrl?.trim()
      ? { sourceBaseUrl: input.sourceBaseUrl.trim() }
      : {}),
  });
  if (candidates.length === 0) {
    throw new ReviewConfigurationOperatorError(
      ReviewConfigurationOperatorErrorCode.RepositoryNotFound,
    );
  }
  if (candidates.length > 1) {
    throw new ReviewConfigurationOperatorError(
      ReviewConfigurationOperatorErrorCode.RepositoryAmbiguous,
    );
  }
  return candidates[0]!;
}

function normalizeRepositoryFullName(repositoryFullName: string): string {
  const normalized = repositoryFullName.trim();
  if (
    normalized.length < 3 ||
    normalized.length > 255 ||
    !normalized.includes("/") ||
    /\s/.test(normalized)
  ) {
    throw new ReviewConfigurationOperatorError(
      ReviewConfigurationOperatorErrorCode.InvalidRepository,
    );
  }
  return normalized;
}

function repositoryTarget(repository: ReviewConfigurationOperatorRepository) {
  return {
    scope: "repository" as const,
    workspaceId: repository.workspaceId,
    repositoryId: repository.id,
  };
}

function withReasoningEffort(
  config: ReviewConfiguration,
  effort: ReviewReasoningEffort,
): ReviewConfiguration {
  const providerIndex = config.providers.findIndex(isCodexBackedProvider);
  if (providerIndex < 0) {
    throw new ReviewConfigurationOperatorError(
      ReviewConfigurationOperatorErrorCode.ReviewProviderNotFound,
    );
  }
  const providers = config.providers.map((provider, index) =>
    index === providerIndex
      ? { ...provider, reasoningEffort: effort }
      : provider,
  );
  return {
    ...config,
    providers,
    provider: providerIndex === 0 ? providers[0]! : config.provider,
  };
}

function toOperatorReviewConfiguration(
  repository: ReviewConfigurationOperatorRepository,
  resolved: {
    readonly source: ResolvedReviewConfigurationSource;
    readonly version: number;
    readonly config: ReviewConfiguration;
  },
): OperatorReviewConfiguration {
  return {
    repository: repository.fullName,
    provider: repository.provider,
    sourceBaseUrl: repository.sourceBaseUrl,
    workspaceId: repository.workspaceId,
    workspaceSlug: repository.workspaceSlug,
    source: resolved.source,
    version: resolved.version,
    repositoryVersion:
      resolved.source === "repository" ? resolved.version : null,
    reasoningEffort:
      (resolved.config.providers.find(isCodexBackedProvider)
        ?.reasoningEffort as ReviewReasoningEffort | undefined) ?? null,
    investigationRollout: { ...resolved.config.investigationRollout },
    providers: resolved.config.providers.length,
  };
}
