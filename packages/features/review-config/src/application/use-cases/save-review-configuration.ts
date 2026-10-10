import {
  parseReviewConfigurationStrict,
  type ReviewConfiguration,
} from "../../domain/review-configuration";
import type { ReviewConfigurationTarget } from "../../domain/review-configuration-target";
import type {
  PersistedReviewConfiguration,
  ReviewConfigurationBatchReaderPort,
  ReviewConfigurationRepositoryPort,
  ReviewConfigurationOperationInput,
  ReviewConfigurationOperationRepositoryPort,
} from "../ports/review-configuration-repository-port";

export async function saveReviewConfigurationWithOperation(
  input: ReviewConfigurationOperationInput,
  dependencies: {
    readonly configurations: ReviewConfigurationOperationRepositoryPort;
  },
): Promise<PersistedReviewConfiguration> {
  return dependencies.configurations.saveNextVersionWithOperation(
    snapshotReviewConfigurationOperation(input),
  );
}

export async function findReviewConfigurationOperation(
  input: {
    readonly target: ReviewConfigurationTarget;
    readonly operationId: string;
    readonly expectedVersion: number | null;
  },
  dependencies: {
    readonly configurations: ReviewConfigurationOperationRepositoryPort;
  },
): Promise<PersistedReviewConfiguration | null> {
  return dependencies.configurations.findOperation(
    snapshotReviewConfigurationOperationLookup(input),
  );
}

/** Capture original lookup intent before any repository I/O, including direct ingress. */
export function snapshotReviewConfigurationOperationLookup(
  input: Parameters<
    ReviewConfigurationOperationRepositoryPort["findOperation"]
  >[0],
): Parameters<ReviewConfigurationOperationRepositoryPort["findOperation"]>[0] {
  return Object.freeze({
    target: snapshotOperationTarget(input.target),
    operationId: validateReviewConfigurationOperationId(input.operationId),
    expectedVersion: validateReviewConfigurationExpectedVersion(
      input.expectedVersion,
    ),
  });
}

/** Owned, frozen intent before the first await, also used at direct adapter ingress. */
export function snapshotReviewConfigurationOperation(
  input: ReviewConfigurationOperationInput,
): ReviewConfigurationOperationInput {
  const expectedVersion = validateReviewConfigurationExpectedVersion(
    input.expectedVersion,
  );
  return freezeOperationIntent({
    target: snapshotOperationTarget(input.target),
    config: parseReviewConfigurationStrict(input.config),
    expectedVersion,
    operationId: validateReviewConfigurationOperationId(input.operationId),
  });
}

function validateReviewConfigurationExpectedVersion(
  expectedVersion: number | null,
): number | null {
  if (
    expectedVersion !== null &&
    (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
  ) {
    throw new Error("review_configuration_expected_version_invalid");
  }
  return expectedVersion;
}

export function validateReviewConfigurationOperationId(
  operationId: string,
): string {
  if (
    typeof operationId !== "string" ||
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.exec(operationId)?.[0] !== operationId
  ) {
    throw new Error("review_configuration_operation_id_invalid");
  }
  return operationId;
}

function snapshotOperationTarget(
  target: ReviewConfigurationTarget,
): ReviewConfigurationTarget {
  if (
    typeof target.workspaceId !== "string" ||
    !target.workspaceId ||
    (target.scope !== "workspace" && target.scope !== "repository") ||
    (target.scope === "repository" &&
      (typeof target.repositoryId !== "string" || !target.repositoryId))
  ) {
    throw new Error("review_configuration_target_invalid");
  }
  return Object.freeze(
    target.scope === "repository"
      ? {
          scope: target.scope,
          workspaceId: target.workspaceId,
          repositoryId: target.repositoryId,
        }
      : { scope: target.scope, workspaceId: target.workspaceId },
  );
}

function freezeOperationIntent<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeOperationIntent(child);
    Object.freeze(value);
  }
  return value;
}

export type RepositoryReviewConfigurationResult = Readonly<{
  repositoryId: string;
  config: PersistedReviewConfiguration | null;
}>;

export async function saveReviewConfiguration(
  input: {
    readonly target: ReviewConfigurationTarget;
    readonly config: ReviewConfiguration;
    readonly expectedVersion?: number | null;
  },
  dependencies: {
    readonly configurations: ReviewConfigurationRepositoryPort;
  },
): Promise<PersistedReviewConfiguration> {
  const config = parseReviewConfigurationStrict(input.config);

  return dependencies.configurations.saveNextVersion({
    target: input.target,
    config,
    ...(input.expectedVersion !== undefined
      ? { expectedVersion: input.expectedVersion }
      : {}),
  });
}

export async function findReviewConfiguration(
  target: ReviewConfigurationTarget,
  dependencies: {
    readonly configurations: ReviewConfigurationRepositoryPort;
  },
): Promise<PersistedReviewConfiguration | null> {
  return dependencies.configurations.findLatest(target);
}

/**
 * Returns one entry for every requested repository ID, preserving input order
 * and duplicates. Repositories without an override receive null, matching the
 * single-target findReviewConfiguration semantics.
 */
export async function findRepositoryReviewConfigurations(
  input: {
    readonly workspaceId: string;
    readonly repositoryIds: readonly string[];
  },
  dependencies: {
    readonly configurations: ReviewConfigurationBatchReaderPort;
  },
): Promise<readonly RepositoryReviewConfigurationResult[]> {
  if (input.repositoryIds.length === 0) {
    return [];
  }

  const uniqueRepositoryIds = [...new Set(input.repositoryIds)];
  const persisted = await dependencies.configurations.findLatestForRepositories(
    {
      workspaceId: input.workspaceId,
      repositoryIds: uniqueRepositoryIds,
    },
  );
  const configByRepositoryId = new Map(
    persisted.map(
      ({ repositoryId, config }) => [repositoryId, config] as const,
    ),
  );

  return input.repositoryIds.map((repositoryId) => ({
    repositoryId,
    config: configByRepositoryId.get(repositoryId) ?? null,
  }));
}

export async function clearReviewConfiguration(
  target: ReviewConfigurationTarget,
  dependencies: {
    readonly configurations: ReviewConfigurationRepositoryPort;
  },
): Promise<boolean> {
  return dependencies.configurations.deleteTarget(target);
}
