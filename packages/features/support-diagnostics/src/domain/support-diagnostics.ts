export type SupportDiagnosticsInput = {
  readonly workspace: {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
  };
  readonly installations: readonly {
    readonly status: string;
    readonly repositorySelection: string;
  }[];
  readonly repositories: readonly {
    readonly id: string;
    readonly selected: boolean;
    readonly archived: boolean;
    readonly setupStatus: string;
    readonly latestProviderSetupState: string | null;
    readonly latestProviderHealth: string | null;
  }[];
  readonly workflowProvisioning: readonly {
    readonly status: string;
  }[];
  readonly outbox: readonly {
    readonly status: string;
    readonly type: string;
  }[];
  readonly recentAuditActions: readonly string[];
};

export type SupportDiagnosticsSnapshot = {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly workspaceSlug: string;
  readonly checkedAt: Date;
  readonly installationCounts: Record<string, number>;
  readonly repositoryCounts: {
    readonly total: number;
    readonly selected: number;
    readonly archived: number;
    readonly notConfigured: number;
    readonly setupPrOpen: number;
    readonly configured: number;
    readonly needsAttention: number;
  };
  readonly providerCounts: {
    readonly unknown: number;
    readonly missing: number;
    readonly configured: number;
    readonly staleOrInvalid: number;
    readonly unhealthy: number;
  };
  readonly workflowProvisioningCounts: Record<string, number>;
  readonly outboxCounts: {
    readonly pending: number;
    readonly processing: number;
    readonly deadLetter: number;
  };
  readonly recentAuditActions: readonly string[];
};

export function summarizeSupportDiagnostics(
  input: SupportDiagnosticsInput,
  checkedAt: Date,
): SupportDiagnosticsSnapshot {
  const repositoryCounts = {
    total: input.repositories.length,
    selected: input.repositories.filter((repo) => repo.selected).length,
    archived: input.repositories.filter((repo) => repo.archived).length,
    notConfigured: input.repositories.filter(
      (repo) => repo.setupStatus === "not_configured",
    ).length,
    setupPrOpen: input.repositories.filter(
      (repo) => repo.setupStatus === "setup_pr_open",
    ).length,
    configured: input.repositories.filter(
      (repo) => repo.setupStatus === "configured",
    ).length,
    needsAttention: input.repositories.filter(
      (repo) => repo.setupStatus === "needs_attention",
    ).length,
  };

  return {
    workspaceId: input.workspace.id,
    workspaceName: input.workspace.name,
    workspaceSlug: input.workspace.slug,
    checkedAt,
    installationCounts: countBy(input.installations, (item) => item.status),
    repositoryCounts,
    providerCounts: {
      unknown: input.repositories.filter(
        (repo) =>
          repo.latestProviderSetupState === null ||
          repo.latestProviderSetupState === "unknown",
      ).length,
      missing: input.repositories.filter(
        (repo) => repo.latestProviderSetupState === "missing",
      ).length,
      configured: input.repositories.filter(
        (repo) => repo.latestProviderSetupState === "configured",
      ).length,
      staleOrInvalid: input.repositories.filter(
        (repo) => repo.latestProviderSetupState === "stale_or_invalid",
      ).length,
      unhealthy: input.repositories.filter(
        (repo) =>
          repo.latestProviderHealth === "failed" ||
          repo.latestProviderHealth === "degraded",
      ).length,
    },
    workflowProvisioningCounts: countBy(
      input.workflowProvisioning,
      (item) => item.status,
    ),
    outboxCounts: {
      pending: input.outbox.filter((event) => event.status === "pending")
        .length,
      processing: input.outbox.filter((event) => event.status === "processing")
        .length,
      deadLetter: input.outbox.filter((event) => event.status === "dead_letter")
        .length,
    },
    recentAuditActions: input.recentAuditActions.slice(0, 10),
  };
}

function countBy<T>(
  items: readonly T[],
  getKey: (item: T) => string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = getKey(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
