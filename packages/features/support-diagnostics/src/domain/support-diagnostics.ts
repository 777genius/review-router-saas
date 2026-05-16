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
    readonly latestFindingCounts: {
      readonly critical: number | null;
      readonly major: number | null;
      readonly minor: number | null;
      readonly info: number | null;
    } | null;
    readonly latestCommentCounts: {
      readonly inline: number | null;
      readonly summary: number | null;
    } | null;
  }[];
  readonly workflowProvisioning: readonly {
    readonly status: string;
  }[];
  readonly outbox: readonly {
    readonly status: string;
    readonly type: string;
  }[];
  readonly memory: {
    readonly itemStatusCounts: Record<string, number>;
    readonly itemScopeCounts: Record<string, number>;
    readonly itemIndexStateCounts: Record<string, number>;
    readonly suggestionStatusCounts: Record<string, number>;
    readonly usageEventCount: number;
  };
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
  readonly actionRunCounts: {
    readonly repositoriesWithReports: number;
    readonly criticalFindings: number;
    readonly majorFindings: number;
    readonly inlineComments: number;
    readonly summaryComments: number;
  };
  readonly workflowProvisioningCounts: Record<string, number>;
  readonly outboxCounts: {
    readonly pending: number;
    readonly processing: number;
    readonly deadLetter: number;
  };
  readonly memoryCounts: {
    readonly items: {
      readonly total: number;
      readonly active: number;
      readonly disabled: number;
      readonly expired: number;
      readonly deleted: number;
    };
    readonly scopes: {
      readonly repository: number;
      readonly workspace: number;
      readonly userPrefs: number;
    };
    readonly index: {
      readonly pending: number;
      readonly indexed: number;
      readonly failed: number;
      readonly deleted: number;
    };
    readonly suggestions: {
      readonly pending: number;
      readonly confirmed: number;
      readonly rejected: number;
      readonly blocked: number;
      readonly expired: number;
      readonly superseded: number;
    };
    readonly usageEvents: number;
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
    actionRunCounts: {
      repositoriesWithReports: input.repositories.filter(
        (repo) => repo.latestFindingCounts || repo.latestCommentCounts,
      ).length,
      criticalFindings: sumNullable(
        input.repositories.map(
          (repo) => repo.latestFindingCounts?.critical ?? null,
        ),
      ),
      majorFindings: sumNullable(
        input.repositories.map(
          (repo) => repo.latestFindingCounts?.major ?? null,
        ),
      ),
      inlineComments: sumNullable(
        input.repositories.map(
          (repo) => repo.latestCommentCounts?.inline ?? null,
        ),
      ),
      summaryComments: sumNullable(
        input.repositories.map(
          (repo) => repo.latestCommentCounts?.summary ?? null,
        ),
      ),
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
    memoryCounts: summarizeMemoryCounts(input.memory),
    recentAuditActions: input.recentAuditActions.slice(0, 10),
  };
}

function summarizeMemoryCounts(
  memory: SupportDiagnosticsInput["memory"],
): SupportDiagnosticsSnapshot["memoryCounts"] {
  return {
    items: {
      total: sumCounts(memory.itemStatusCounts),
      active: memory.itemStatusCounts.active ?? 0,
      disabled: memory.itemStatusCounts.disabled ?? 0,
      expired: memory.itemStatusCounts.expired ?? 0,
      deleted: memory.itemStatusCounts.deleted ?? 0,
    },
    scopes: {
      repository: memory.itemScopeCounts.repository ?? 0,
      workspace: memory.itemScopeCounts.workspace ?? 0,
      userPrefs: memory.itemScopeCounts.user_prefs ?? 0,
    },
    index: {
      pending: memory.itemIndexStateCounts.index_pending ?? 0,
      indexed: memory.itemIndexStateCounts.indexed ?? 0,
      failed: memory.itemIndexStateCounts.index_failed ?? 0,
      deleted: memory.itemIndexStateCounts.index_deleted ?? 0,
    },
    suggestions: {
      pending: memory.suggestionStatusCounts.pending ?? 0,
      confirmed: memory.suggestionStatusCounts.confirmed ?? 0,
      rejected: memory.suggestionStatusCounts.rejected ?? 0,
      blocked: memory.suggestionStatusCounts.blocked ?? 0,
      expired: memory.suggestionStatusCounts.expired ?? 0,
      superseded: memory.suggestionStatusCounts.superseded ?? 0,
    },
    usageEvents: memory.usageEventCount,
  };
}

function sumCounts(counts: Record<string, number>): number {
  return Object.values(counts).reduce((total, value) => total + value, 0);
}

function sumNullable(values: readonly (number | null)[]): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
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
