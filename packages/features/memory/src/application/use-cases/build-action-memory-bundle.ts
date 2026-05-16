import {
  buildMemoryBundle,
  defaultMemoryBundlePolicy,
  type ActionMemoryBundle,
  type MemoryBundlePolicy,
} from "../../domain/memory-bundle-policy";
import type { MemoryItemSnapshot } from "../../domain/memory-item";
import type {
  MemorySearchCapability,
  MemorySearchIndexPort,
} from "../ports/memory-search-index-port";
import type { MemoryAllowedScopePolicy } from "../ports/memory-policy-config-port";
import type { MemoryUseCaseDependencies } from "./memory-use-case-types";

export type BuildActionMemoryBundleInput = {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly userId: string | null;
  readonly safeRetrievalQuery?: string | null;
  readonly policy?: Partial<MemoryBundlePolicy>;
};

export async function buildActionMemoryBundle(
  input: BuildActionMemoryBundleInput,
  dependencies: Pick<
    MemoryUseCaseDependencies,
    "memoryItems" | "memoryPolicyConfig"
  > & {
    readonly memorySearchIndex?: MemorySearchIndexPort;
  },
): Promise<ActionMemoryBundle> {
  const policyConfig = await dependencies.memoryPolicyConfig.getPolicy({
    workspaceId: input.workspaceId,
    repositoryId: input.repositoryId,
  });
  const policy = {
    ...defaultMemoryBundlePolicy,
    ...policyConfig.runtimeBundle,
    ...input.policy,
  };
  if (!policyConfig.memoryEnabled) {
    return buildMemoryBundle([], policy, {
      degraded: true,
      reason: "memory_disabled",
    });
  }
  const safeQuery = normalizeSafeRetrievalQuery(input.safeRetrievalQuery);
  if (safeQuery && dependencies.memorySearchIndex) {
    const searched = await searchBundleCandidates(input, dependencies, policy);
    if (searched.status === "found") {
      return buildMemoryBundle(
        filterItemsByAllowedScopes(searched.items, policyConfig.allowedScopes),
        policy,
        {
          preserveInputOrder: true,
        },
      );
    }
    if (searched.status === "degraded") {
      return buildFallbackBundle(
        input,
        dependencies,
        policy,
        searched.reason,
        policyConfig.allowedScopes,
      );
    }
  }

  return buildFallbackBundle(
    input,
    dependencies,
    policy,
    null,
    policyConfig.allowedScopes,
  );
}

async function searchBundleCandidates(
  input: BuildActionMemoryBundleInput,
  dependencies: Pick<MemoryUseCaseDependencies, "memoryItems"> & {
    readonly memorySearchIndex?: MemorySearchIndexPort;
  },
  policy: MemoryBundlePolicy,
): Promise<
  | { readonly status: "found"; readonly items: readonly MemoryItemSnapshot[] }
  | { readonly status: "empty" }
  | { readonly status: "degraded"; readonly reason: string }
> {
  const safeQuery = normalizeSafeRetrievalQuery(input.safeRetrievalQuery);
  const searchIndex = dependencies.memorySearchIndex;
  if (!safeQuery || !searchIndex) return { status: "empty" };

  try {
    const capabilities = await searchIndex.supports();
    if (!supportsRuntimeRetrieval(capabilities.capabilities)) {
      return { status: "degraded", reason: "memory_search_index_unavailable" };
    }
    const hits = await searchIndex.search({
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
      userId: input.userId,
      safeQuery,
      includeUserPrefs: policy.includeUserPrefs,
      limit: policy.maxItems * 5,
    });
    if (hits.length === 0) return { status: "empty" };

    const rankedIds = [...new Set(hits.map((hit) => hit.memoryItemId))];
    const canonical = await dependencies.memoryItems.listActiveByIdsForBundle({
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
      userId: input.userId,
      itemIds: rankedIds,
      limit: policy.maxItems * 3,
    });
    const byId = new Map(canonical.map((item) => [item.id, item]));
    const rankedCanonical = rankedIds
      .map((id) => byId.get(id))
      .filter((item): item is MemoryItemSnapshot => item !== undefined);

    if (rankedCanonical.length === 0) {
      return { status: "degraded", reason: "memory_search_index_stale" };
    }
    return { status: "found", items: rankedCanonical };
  } catch {
    return { status: "degraded", reason: "memory_search_index_unavailable" };
  }
}

async function buildFallbackBundle(
  input: BuildActionMemoryBundleInput,
  dependencies: Pick<MemoryUseCaseDependencies, "memoryItems">,
  policy: MemoryBundlePolicy,
  degradedReason: string | null,
  allowedScopes: MemoryAllowedScopePolicy,
): Promise<ActionMemoryBundle> {
  const items = await dependencies.memoryItems.listActiveForBundle({
    workspaceId: input.workspaceId,
    repositoryId: input.repositoryId,
    userId: input.userId,
    limit: policy.maxItems * 3,
  });
  return buildMemoryBundle(
    filterItemsByAllowedScopes(items, allowedScopes),
    policy,
    {
      degraded: degradedReason !== null,
      reason: degradedReason,
    },
  );
}

function filterItemsByAllowedScopes(
  items: readonly MemoryItemSnapshot[],
  allowedScopes: MemoryAllowedScopePolicy,
): readonly MemoryItemSnapshot[] {
  return items.filter((item) => allowedScopes[item.scope]);
}

function normalizeSafeRetrievalQuery(value: string | null | undefined): string {
  if (!value) return "";
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 500 ? normalized : "";
}

const runtimeRetrievalCapabilities: ReadonlySet<MemorySearchCapability> =
  new Set(["lexical", "full_text", "semantic_vector", "hybrid"]);

function supportsRuntimeRetrieval(
  capabilities: readonly MemorySearchCapability[],
): boolean {
  return capabilities.some((capability) =>
    runtimeRetrievalCapabilities.has(capability),
  );
}
