"use client";

import type { ProviderAuthMode } from "@reviewrouter/features-review-providers";

export type ProviderSecretAvailabilityStatus =
  | "available_repository"
  | "available_organization"
  | "not_available_to_repository"
  | "missing"
  | "permission_required"
  | "unknown";

export type ProviderSecretCheckResult = {
  readonly status: ProviderSecretAvailabilityStatus;
};

type ProviderSecretStatusCacheEntry =
  | {
      readonly expiresAt: number;
      readonly promise: Promise<ProviderSecretCheckResult>;
      readonly result?: never;
    }
  | {
      readonly expiresAt: number;
      readonly promise?: never;
      readonly result: ProviderSecretCheckResult;
    };

const providerSecretStatusCacheTtlMs = 60_000;
const providerSecretStatusUnknownCacheTtlMs = 15_000;
const providerSecretStatusPendingTtlMs = 15_000;
const providerSecretStatusCache = new Map<
  string,
  ProviderSecretStatusCacheEntry
>();

export function clearProviderSecretStatusCache(input?: {
  readonly workspaceId?: string;
  readonly repositoryId?: string;
  readonly authMode?: ProviderAuthMode;
}): void {
  if (!input?.workspaceId && !input?.repositoryId && !input?.authMode) {
    providerSecretStatusCache.clear();
    return;
  }

  for (const key of providerSecretStatusCache.keys()) {
    const [workspaceId, repositoryId, authMode] = key.split(":");
    if (input.workspaceId && workspaceId !== input.workspaceId) continue;
    if (input.repositoryId && repositoryId !== input.repositoryId) continue;
    if (input.authMode && authMode !== input.authMode) continue;

    providerSecretStatusCache.delete(key);
  }
}

export function clearProviderSecretStatusCacheForTest(): void {
  clearProviderSecretStatusCache();
}

export function checkProviderSecretStatusWithCache(input: {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly authMode: ProviderAuthMode;
  readonly formData: FormData;
  readonly forceRefresh: boolean;
  readonly check: (formData: FormData) => Promise<ProviderSecretCheckResult>;
}): Promise<ProviderSecretCheckResult> {
  const cacheKey = providerSecretStatusCacheKey(input);
  const now = Date.now();
  const cached = providerSecretStatusCache.get(cacheKey);

  if (!input.forceRefresh && cached && cached.expiresAt > now) {
    if (cached.result) return Promise.resolve(cached.result);
    return cached.promise;
  }

  const promise = input
    .check(input.formData)
    .then((result) => {
      providerSecretStatusCache.set(cacheKey, {
        expiresAt:
          Date.now() +
          (result.status === "unknown"
            ? providerSecretStatusUnknownCacheTtlMs
            : providerSecretStatusCacheTtlMs),
        result,
      });
      return result;
    })
    .catch((error: unknown) => {
      providerSecretStatusCache.delete(cacheKey);
      throw error;
    });

  providerSecretStatusCache.set(cacheKey, {
    expiresAt: now + providerSecretStatusPendingTtlMs,
    promise,
  });

  return promise;
}

function providerSecretStatusCacheKey(input: {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly authMode: ProviderAuthMode;
}): string {
  return `${input.workspaceId}:${input.repositoryId}:${input.authMode}`;
}
