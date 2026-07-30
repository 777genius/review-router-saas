import type { ScmProvider } from "@reviewrouter/shared";
import { isCodexBackedProvider } from "@reviewrouter/features-review-providers";
import type { ReviewConfiguration } from "../../domain/review-configuration";
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
  type ReviewConfigurationOperatorRepository,
  type ReviewConfigurationOperatorRepositoryPort,
} from "../ports/review-configuration-operator-ports";
import {
  resolveReviewConfiguration,
  type ResolvedReviewConfigurationSource,
} from "./resolve-review-configuration";
import { saveReviewConfiguration } from "./save-review-configuration";

export enum ReviewConfigurationOperatorErrorCode {
  Unauthorized = "unauthorized",
  RepositoryNotFound = "repository_not_found",
  RepositoryAmbiguous = "repository_ambiguous",
  InvalidRepository = "invalid_repository",
  RateLimited = "rate_limited",
  ReviewProviderNotFound = "review_provider_not_found",
  ConfigurationChanged = "configuration_changed",
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
  workspaceId: string;
  workspaceSlug: string;
  source: ResolvedReviewConfigurationSource;
  version: number;
  reasoningEffort: ReviewReasoningEffort | null;
  providers: number;
}>;

export type SetOperatorReviewReasoningEffortResult =
  OperatorReviewConfiguration &
    Readonly<{
      changed: boolean;
      previousSource: ResolvedReviewConfigurationSource;
      previousVersion: number;
    }>;

export type OperatorReviewConfigurationDependencies = Readonly<{
  authorization: ReviewConfigurationOperatorAuthorizationPort;
  rateLimits: ReviewConfigurationOperatorRateLimitPort;
  repositories: ReviewConfigurationOperatorRepositoryPort;
  configurations: ReviewConfigurationRepositoryPort;
  audit: ReviewConfigurationOperatorAuditPort;
}>;

type OperatorReviewConfigurationInput = Readonly<{
  credential: string;
  repositoryFullName: string;
  provider: ScmProvider;
  workspace?: string;
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
  let saved: { readonly version: number; readonly config: ReviewConfiguration };
  try {
    saved = alreadyExplicitAndEqual
      ? { version: previous.version, config: previous.config }
      : await saveReviewConfiguration(
          {
            target,
            config: updatedConfig,
            expectedVersion:
              previous.source === "repository" ? previous.version : null,
          },
          dependencies,
        );
  } catch (error) {
    if (isReviewConfigurationWriteConflictError(error)) {
      throw new ReviewConfigurationOperatorError(
        ReviewConfigurationOperatorErrorCode.ConfigurationChanged,
      );
    }
    throw error;
  }

  await dependencies.audit.record({
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
      version: saved.version,
      providers: saved.config.providers.length,
      reviewProvider: "codex-backed",
    },
  });

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

async function assertRateLimit(
  input: OperatorReviewConfigurationInput,
  principal: ReviewConfigurationOperatorPrincipal,
  operation: ReviewConfigurationOperatorOperation,
  dependencies: Pick<OperatorReviewConfigurationDependencies, "rateLimits">,
): Promise<void> {
  const allowed = await dependencies.rateLimits.consume({
    operatorId: principal.operatorId,
    operation,
    repositoryFullName: input.repositoryFullName.trim().toLowerCase(),
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
  const repositoryFullName = input.repositoryFullName.trim();
  if (
    repositoryFullName.length < 3 ||
    repositoryFullName.length > 255 ||
    !repositoryFullName.includes("/") ||
    /\s/.test(repositoryFullName)
  ) {
    throw new ReviewConfigurationOperatorError(
      ReviewConfigurationOperatorErrorCode.InvalidRepository,
    );
  }
  const candidates = await repositories.findActiveCandidates({
    provider: input.provider,
    repositoryFullName,
    ...(input.workspace?.trim() ? { workspace: input.workspace.trim() } : {}),
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
    provider: providers[0]!,
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
    workspaceId: repository.workspaceId,
    workspaceSlug: repository.workspaceSlug,
    source: resolved.source,
    version: resolved.version,
    reasoningEffort:
      (resolved.config.providers.find(isCodexBackedProvider)
        ?.reasoningEffort as ReviewReasoningEffort | undefined) ?? null,
    providers: resolved.config.providers.length,
  };
}
