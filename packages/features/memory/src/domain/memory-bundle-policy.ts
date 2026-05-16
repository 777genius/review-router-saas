import type { MemoryItemSnapshot } from "./memory-item";

export type ActionMemoryBundleItem = {
  readonly id: string;
  readonly scope: MemoryItemSnapshot["scope"];
  readonly body: string;
  readonly tags: readonly string[];
  readonly confidence: number;
};

export type ActionMemoryBundle = {
  readonly protocolVersion: 1;
  readonly memoryVersion: 1;
  readonly items: readonly ActionMemoryBundleItem[];
  readonly degraded: boolean;
  readonly reason: string | null;
};

export type MemoryBundlePolicy = {
  readonly maxItems: number;
  readonly maxCharacters: number;
  readonly includeUserPrefs: boolean;
};

export const defaultMemoryBundlePolicy: MemoryBundlePolicy = {
  maxItems: 12,
  maxCharacters: 6_000,
  includeUserPrefs: true,
};

export type BuildMemoryBundleOptions = {
  readonly preserveInputOrder?: boolean;
  readonly degraded?: boolean;
  readonly reason?: string | null;
};

const scopePriority: Record<MemoryItemSnapshot["scope"], number> = {
  repository: 0,
  workspace: 1,
  user_prefs: 2,
};

export function buildMemoryBundle(
  items: readonly MemoryItemSnapshot[],
  policy: MemoryBundlePolicy = defaultMemoryBundlePolicy,
  options: BuildMemoryBundleOptions = {},
): ActionMemoryBundle {
  const selected: ActionMemoryBundleItem[] = [];
  let characterCount = 0;

  const candidates = [...items]
    .filter((item) => item.status === "active")
    .filter((item) => policy.includeUserPrefs || item.scope !== "user_prefs");

  if (!options.preserveInputOrder) {
    candidates.sort(compareBundleItems);
  }

  for (const item of candidates) {
    if (selected.length >= policy.maxItems) break;
    const nextCharacterCount = characterCount + item.body.length;
    if (nextCharacterCount > policy.maxCharacters) continue;
    selected.push({
      id: item.id,
      scope: item.scope,
      body: item.body,
      tags: item.tags,
      confidence: item.confidence,
    });
    characterCount = nextCharacterCount;
  }

  return {
    protocolVersion: 1,
    memoryVersion: 1,
    items: selected,
    degraded: options.degraded ?? false,
    reason: options.reason ?? null,
  };
}

function compareBundleItems(
  left: MemoryItemSnapshot,
  right: MemoryItemSnapshot,
): number {
  const scope = scopePriority[left.scope] - scopePriority[right.scope];
  if (scope !== 0) return scope;
  const leftTime = (left.lastUsedAt ?? left.updatedAt).getTime();
  const rightTime = (right.lastUsedAt ?? right.updatedAt).getTime();
  if (leftTime !== rightTime) return rightTime - leftTime;
  if (left.confidence !== right.confidence)
    return right.confidence - left.confidence;
  return left.id.localeCompare(right.id);
}
