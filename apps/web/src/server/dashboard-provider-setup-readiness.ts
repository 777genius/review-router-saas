import type { RepositoryHealthStatus } from "@reviewrouter/features-repo-health";
import type { ReviewConfiguration } from "@reviewrouter/features-review-config";

export type DashboardProviderSetupReadinessRecord = {
  readonly repositoryId: string | null;
  readonly providerKind: string;
  readonly authMode: string;
  readonly state: string;
  readonly updatedAt: Date;
};

export type DashboardProviderSetupRepositoryRecord = {
  readonly id: string;
};

export type DashboardProviderSetupRepositoryConfigRecord = {
  readonly repositoryId: string;
  readonly config: { readonly config: ReviewConfiguration } | null;
};

export type DashboardEffectiveProviderSetupState = {
  readonly state: string;
  readonly updatedAt: Date;
};

export function buildConfiguredProviderSetupByRepositoryId(input: {
  readonly providerSetup: readonly DashboardProviderSetupReadinessRecord[];
  readonly repositories: readonly DashboardProviderSetupRepositoryRecord[];
  readonly repositoryConfigs: readonly DashboardProviderSetupRepositoryConfigRecord[];
  readonly activeConfig: ReviewConfiguration;
}): ReadonlyMap<string, { readonly updatedAt: Date }> {
  return new Map(
    [...buildEffectiveProviderSetupStateByRepositoryId(input)].flatMap(
      ([repositoryId, setup]) =>
        setup.state === "configured"
          ? [[repositoryId, { updatedAt: setup.updatedAt }] as const]
          : [],
    ),
  );
}

export function buildEffectiveProviderSetupStateByRepositoryId(input: {
  readonly providerSetup: readonly DashboardProviderSetupReadinessRecord[];
  readonly repositories: readonly DashboardProviderSetupRepositoryRecord[];
  readonly repositoryConfigs: readonly DashboardProviderSetupRepositoryConfigRecord[];
  readonly activeConfig: ReviewConfiguration;
}): ReadonlyMap<string, DashboardEffectiveProviderSetupState> {
  const effectiveProviderSetupByRepositoryId = new Map<
    string,
    DashboardEffectiveProviderSetupState
  >();
  const providerSetupByRepositoryId = new Map<
    string,
    DashboardProviderSetupReadinessRecord[]
  >();
  const repositoryConfigById = new Map(
    input.repositoryConfigs.map(
      (item) => [item.repositoryId, item.config] as const,
    ),
  );

  for (const item of input.providerSetup) {
    if (!item.repositoryId) continue;
    providerSetupByRepositoryId.set(item.repositoryId, [
      ...(providerSetupByRepositoryId.get(item.repositoryId) ?? []),
      item,
    ]);
  }

  for (const repository of input.repositories) {
    const effectiveConfig =
      repositoryConfigById.get(repository.id)?.config ?? input.activeConfig;
    const repositoryProviderSetup =
      providerSetupByRepositoryId.get(repository.id) ?? [];
    const expectedProviderKeys = providerKeysForConfig(effectiveConfig);
    const matchingProviderSetup = repositoryProviderSetup.filter((item) =>
      providerSetupMatchesConfig(item, effectiveConfig),
    );
    if (matchingProviderSetup.length === 0) {
      if (expectedProviderKeys.size > 0) {
        effectiveProviderSetupByRepositoryId.set(repository.id, {
          state: "missing",
          updatedAt: new Date(0),
        });
      }
      continue;
    }
    effectiveProviderSetupByRepositoryId.set(
      repository.id,
      aggregateEffectiveProviderSetupState({
        expectedProviderKeys,
        matchingProviderSetup,
      }),
    );
  }

  return effectiveProviderSetupByRepositoryId;
}

export function repositoryHealthStatusWithProviderSetupReadiness(input: {
  readonly repositoryId: string;
  readonly healthStatus: RepositoryHealthStatus | undefined;
  readonly effectiveProviderSetupStateByRepositoryId: ReadonlyMap<
    string,
    DashboardEffectiveProviderSetupState
  >;
  readonly providerSetupMismatchRepositoryIds: ReadonlySet<string>;
}): RepositoryHealthStatus | undefined {
  if (input.healthStatus !== "healthy") {
    return input.healthStatus;
  }
  const effectiveProviderSetup =
    input.effectiveProviderSetupStateByRepositoryId.get(input.repositoryId);
  if (effectiveProviderSetup) {
    return effectiveProviderSetup.state === "configured"
      ? input.healthStatus
      : "provider_needs_setup";
  }
  return input.providerSetupMismatchRepositoryIds.has(input.repositoryId)
    ? "provider_needs_setup"
    : input.healthStatus;
}

export function buildProviderSetupMismatchRepositoryIds(input: {
  readonly providerSetup: readonly DashboardProviderSetupReadinessRecord[];
  readonly repositories: readonly DashboardProviderSetupRepositoryRecord[];
  readonly repositoryConfigs: readonly DashboardProviderSetupRepositoryConfigRecord[];
  readonly activeConfig: ReviewConfiguration;
}): ReadonlySet<string> {
  const repositoryConfigById = new Map(
    input.repositoryConfigs.map(
      (item) => [item.repositoryId, item.config] as const,
    ),
  );
  const effectiveConfigByRepositoryId = new Map(
    input.repositories.map((repository) => [
      repository.id,
      repositoryConfigById.get(repository.id)?.config ?? input.activeConfig,
    ]),
  );
  const mismatchedRepositoryIds = new Set<string>();

  for (const item of input.providerSetup) {
    if (!item.repositoryId) continue;
    const effectiveConfig = effectiveConfigByRepositoryId.get(
      item.repositoryId,
    );
    if (!effectiveConfig || providerSetupMatchesConfig(item, effectiveConfig)) {
      continue;
    }
    if (
      effectiveConfig.providers.some(
        (provider) => provider.kind === item.providerKind,
      )
    ) {
      mismatchedRepositoryIds.add(item.repositoryId);
    }
  }

  return mismatchedRepositoryIds;
}

function shouldReplaceEffectiveProviderSetupState(
  existing: DashboardEffectiveProviderSetupState | undefined,
  item: DashboardProviderSetupReadinessRecord,
): boolean {
  if (!existing) return true;
  if (existing.state !== "configured" && item.state === "configured") {
    return false;
  }
  if (existing.state === "configured" && item.state !== "configured") {
    return true;
  }
  return existing.updatedAt < item.updatedAt;
}

function aggregateEffectiveProviderSetupState(input: {
  readonly expectedProviderKeys: ReadonlySet<string>;
  readonly matchingProviderSetup: readonly DashboardProviderSetupReadinessRecord[];
}): DashboardEffectiveProviderSetupState {
  const setupStateByProviderKey = new Map<
    string,
    DashboardEffectiveProviderSetupState
  >();
  for (const item of input.matchingProviderSetup) {
    const providerKey = providerSetupKey(item);
    const existing = setupStateByProviderKey.get(providerKey);
    if (shouldReplaceEffectiveProviderSetupState(existing, item)) {
      setupStateByProviderKey.set(providerKey, {
        state: item.state,
        updatedAt: item.updatedAt,
      });
    }
  }

  const latestSetup = input.matchingProviderSetup.reduce((latest, item) =>
    latest.updatedAt < item.updatedAt ? item : latest,
  );
  if (setupStateByProviderKey.size < input.expectedProviderKeys.size) {
    return { state: "missing", updatedAt: latestSetup.updatedAt };
  }

  const blockingState = [...setupStateByProviderKey.values()].find(
    (item) => item.state !== "configured",
  );
  if (blockingState) {
    return blockingState;
  }

  return { state: "configured", updatedAt: latestSetup.updatedAt };
}

function providerSetupMatchesConfig(
  providerSetup: DashboardProviderSetupReadinessRecord,
  config: ReviewConfiguration,
): boolean {
  return config.providers.some(
    (provider) =>
      provider.kind === providerSetup.providerKind &&
      provider.authMode === providerSetup.authMode,
  );
}

function providerKeysForConfig(
  config: ReviewConfiguration,
): ReadonlySet<string> {
  return new Set(
    config.providers.map(
      (provider) => `${provider.kind}:${provider.authMode}` as const,
    ),
  );
}

function providerSetupKey(
  providerSetup: DashboardProviderSetupReadinessRecord,
): string {
  return `${providerSetup.providerKind}:${providerSetup.authMode}`;
}
