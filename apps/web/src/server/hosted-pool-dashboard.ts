import {
  repositoryId,
  workspaceId,
  type HostedAccountSafeSummary,
  type HostedPoolQueryPort,
  type HostedPoolSafeSummary,
  type HostedRepositoryBindingSafeSummary,
} from "@reviewrouter/features-hosted-account-pool";

export type HostedSessionSource = "repository_secret" | "hosted_workspace_pool";

export type HostedPoolRepositoryView = Readonly<{
  id: string;
  fullName: string;
  visibility: string;
  source: HostedSessionSource;
  bindingId: string | null;
  bindingVersion: number;
  activation: "legacy" | "pending" | "active";
  eligible: boolean;
}>;

export type HostedPoolDashboardView = Readonly<{
  gate: "enabled" | "feature_disabled" | "entitlement_denied";
  pool: HostedPoolSafeSummary | null;
  accounts: readonly HostedAccountSafeSummary[];
  repositories: readonly HostedPoolRepositoryView[];
}>;

export type HostedPoolDashboardRepository = Readonly<{
  id: string;
  fullName: string;
  visibility: string;
}>;

export interface HostedPoolDashboardMutationPort {
  importAccount(input: {
    readonly workspaceId: string;
    readonly label: string;
    readonly priority: number;
    readonly authJson: Uint8Array;
    readonly requestedAt: Date;
  }): Promise<void>;
  setAccountState(input: {
    readonly workspaceId: string;
    readonly accountId: string;
    readonly state: "healthy" | "paused";
    readonly expectedVersion: number;
    readonly requestedAt: Date;
  }): Promise<void>;
  setRepositorySource(input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly source: HostedSessionSource;
    readonly expectedVersion: number;
    readonly requestedAt: Date;
  }): Promise<{
    readonly activation: "pending" | "active";
    readonly bindingId?: string;
    readonly bindingRevision?: number;
  }>;
}

export type HostedPoolDashboardMutationDependencies = Readonly<{
  featureEnabled: boolean;
  authorizeWorkspaceAdmin(
    workspaceId: string,
  ): Promise<{ readonly actor: string }>;
  assertEntitled(workspaceId: string, actor: string): Promise<void>;
  getRepository(
    repositoryId: string,
  ): Promise<
    (HostedPoolDashboardRepository & { readonly workspaceId: string }) | null
  >;
  mutations: HostedPoolDashboardMutationPort;
  now(): Date;
}>;

export async function loadHostedPoolDashboardView(input: {
  readonly workspaceId: string;
  readonly repositories: readonly HostedPoolDashboardRepository[];
  readonly featureEnabled: boolean;
  readonly entitled: boolean;
  readonly queries: HostedPoolQueryPort;
}): Promise<HostedPoolDashboardView> {
  if (!input.featureEnabled) {
    return emptyDashboardView("feature_disabled", input.repositories);
  }
  if (!input.entitled) {
    return emptyDashboardView("entitlement_denied", input.repositories);
  }

  const pool = await input.queries.getDefaultPoolSummary(
    workspaceId(input.workspaceId),
  );
  const [accounts, bindings] = await Promise.all([
    pool ? input.queries.listAccountSummaries(pool.id) : Promise.resolve([]),
    Promise.all(
      input.repositories.map((repository) =>
        input.queries.getRepositoryBindingSummary(repositoryId(repository.id)),
      ),
    ),
  ]);
  return {
    gate: "enabled",
    pool,
    accounts,
    repositories: input.repositories.map((repository, index) =>
      toRepositoryView(repository, bindings[index] ?? null, pool),
    ),
  };
}

export async function importHostedPoolAccount(
  input: {
    readonly workspaceId: string;
    readonly label: string;
    readonly priority: number;
    readonly authJson: Uint8Array | (() => Promise<Uint8Array>);
  },
  dependencies: HostedPoolDashboardMutationDependencies,
): Promise<void> {
  const actor = await authorizeAndEntitle(input.workspaceId, dependencies);
  if (!input.label.trim() || input.label.trim().length > 80)
    throw new Error("hosted_account_label_invalid");
  if (!Number.isSafeInteger(input.priority) || input.priority < 0)
    throw new Error("hosted_account_priority_invalid");
  const authJson =
    typeof input.authJson === "function"
      ? await input.authJson()
      : input.authJson;
  try {
    if (authJson.byteLength === 0 || authJson.byteLength > 1024 * 1024)
      throw new Error("hosted_account_auth_file_invalid");
    await dependencies.mutations.importAccount({
      workspaceId: input.workspaceId,
      label: input.label.trim(),
      priority: input.priority,
      authJson,
      requestedAt: dependencies.now(),
    });
  } finally {
    authJson.fill(0);
  }
  void actor;
}

export async function changeHostedPoolAccountState(
  input: {
    readonly workspaceId: string;
    readonly accountId: string;
    readonly state: "healthy" | "paused";
    readonly expectedVersion: number;
  },
  dependencies: HostedPoolDashboardMutationDependencies,
): Promise<void> {
  await authorizeAndEntitle(input.workspaceId, dependencies);
  await dependencies.mutations.setAccountState({
    ...input,
    requestedAt: dependencies.now(),
  });
}

export async function changeHostedRepositorySessionSource(
  input: {
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly source: HostedSessionSource;
    readonly expectedVersion: number;
  },
  dependencies: HostedPoolDashboardMutationDependencies,
): Promise<{
  readonly activation: "pending" | "active";
  readonly bindingId?: string;
  readonly bindingRevision?: number;
}> {
  await authorizeAndEntitle(input.workspaceId, dependencies);
  const repository = await dependencies.getRepository(input.repositoryId);
  if (!repository || repository.workspaceId !== input.workspaceId)
    throw new Error("repository_not_found");
  if (
    input.source === "hosted_workspace_pool" &&
    repository.visibility !== "private"
  ) {
    throw new Error("hosted_pool_private_repository_required");
  }
  return dependencies.mutations.setRepositorySource({
    ...input,
    requestedAt: dependencies.now(),
  });
}

async function authorizeAndEntitle(
  workspaceId: string,
  dependencies: HostedPoolDashboardMutationDependencies,
): Promise<{ readonly actor: string }> {
  if (!dependencies.featureEnabled)
    throw new Error("hosted_pool_feature_disabled");
  const actor = await dependencies.authorizeWorkspaceAdmin(workspaceId);
  await dependencies.assertEntitled(workspaceId, actor.actor);
  return actor;
}

function emptyDashboardView(
  gate: "feature_disabled" | "entitlement_denied",
  repositories: readonly HostedPoolDashboardRepository[],
): HostedPoolDashboardView {
  return {
    gate,
    pool: null,
    accounts: [],
    repositories: repositories.map((repository) =>
      toRepositoryView(repository, null, null),
    ),
  };
}

function toRepositoryView(
  repository: HostedPoolDashboardRepository,
  binding: HostedRepositoryBindingSafeSummary | null,
  pool: HostedPoolSafeSummary | null,
): HostedPoolRepositoryView {
  const hasBinding = Boolean(binding);
  const bound = Boolean(binding && binding.status !== "draining");
  const poolMatches = Boolean(binding && pool && binding.poolId === pool.id);
  return {
    ...repository,
    source: bound ? "hosted_workspace_pool" : "repository_secret",
    bindingId: hasBinding ? String(binding!.bindingId) : null,
    bindingVersion: hasBinding ? binding!.revision : 0,
    activation: bound
      ? !poolMatches || binding!.status === "pending_activation"
        ? "pending"
        : binding!.status === "active"
          ? "active"
          : "pending"
      : "legacy",
    eligible: repository.visibility === "private",
  };
}
