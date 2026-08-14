export type InventoryIncompleteReason =
  | "cursor_cycle"
  | "malformed_cursor"
  | "max_pages"
  | "max_items";

export type CompleteInventory<T> =
  | Readonly<{ complete: true; items: readonly T[]; pages: number }>
  | Readonly<{
      complete: false;
      items: readonly T[];
      pages: number;
      reason: InventoryIncompleteReason;
    }>;

export interface InventoryPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface InventoryLimits {
  readonly maxPages: number;
  readonly maxItems: number;
}

const cursorPattern = /^[A-Za-z0-9][A-Za-z0-9._~+/=-]{0,1023}$/u;

export async function collectCompleteInventory<T>(
  load: (cursor?: string) => Promise<InventoryPage<T>>,
  limits: InventoryLimits,
): Promise<CompleteInventory<T>> {
  if (
    !Number.isSafeInteger(limits.maxPages) ||
    limits.maxPages < 1 ||
    !Number.isSafeInteger(limits.maxItems) ||
    limits.maxItems < 1
  )
    throw new Error("provider_inventory_limits_invalid");
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let pages = 0; pages < limits.maxPages; pages += 1) {
    const page = await load(cursor);
    if (items.length + page.items.length > limits.maxItems)
      return Object.freeze({
        complete: false as const,
        items: Object.freeze(items),
        pages: pages + 1,
        reason: "max_items" as const,
      });
    items.push(...page.items);
    if (page.nextCursor === null)
      return Object.freeze({
        complete: true as const,
        items: Object.freeze(items),
        pages: pages + 1,
      });
    if (!cursorPattern.test(page.nextCursor))
      return Object.freeze({
        complete: false as const,
        items: Object.freeze(items),
        pages: pages + 1,
        reason: "malformed_cursor" as const,
      });
    if (seen.has(page.nextCursor) || page.nextCursor === cursor)
      return Object.freeze({
        complete: false as const,
        items: Object.freeze(items),
        pages: pages + 1,
        reason: "cursor_cycle" as const,
      });
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  return Object.freeze({
    complete: false as const,
    items: Object.freeze(items),
    pages: limits.maxPages,
    reason: "max_pages" as const,
  });
}

export type ProviderHttpErrorCategory =
  | "deadline"
  | "network"
  | "response_status"
  | "response_invalid";

export class ProviderHttpError extends Error {
  constructor(
    readonly operation: string,
    readonly category: ProviderHttpErrorCategory,
    readonly status?: number,
    readonly ambiguousWrite = false,
  ) {
    super(
      `provider_http_${operation}_${category}${status === undefined ? "" : `:${status}`}`,
    );
    this.name = "ProviderHttpError";
  }
}

export interface BoundedHttpPolicy {
  readonly deadlineMs: number;
  readonly safeReadAttempts: number;
}

export const DEFAULT_PROVIDER_HTTP_POLICY: BoundedHttpPolicy = Object.freeze({
  deadlineMs: 10_000,
  safeReadAttempts: 2,
});

const retryableStatus = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500;

export class BoundedProviderHttpClient {
  constructor(
    private readonly fetchImpl: (
      input: string,
      init?: RequestInit,
    ) => Promise<Response>,
    private readonly policy: BoundedHttpPolicy = DEFAULT_PROVIDER_HTTP_POLICY,
  ) {
    if (
      !Number.isSafeInteger(policy.deadlineMs) ||
      policy.deadlineMs < 1 ||
      !Number.isSafeInteger(policy.safeReadAttempts) ||
      policy.safeReadAttempts < 1 ||
      policy.safeReadAttempts > 5
    )
      throw new Error("provider_http_policy_invalid");
  }

  async request(
    operation: string,
    input: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    const safeRead = method === "GET" || method === "HEAD";
    const attempts = safeRead ? this.policy.safeReadAttempts : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      let deadlineReached = false;
      const timer = setTimeout(() => {
        deadlineReached = true;
        controller.abort();
      }, this.policy.deadlineMs);
      const onAbort = () => controller.abort();
      init.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const response = await this.fetchImpl(input, {
          ...init,
          signal: controller.signal,
        });
        if (safeRead && retryableStatus(response.status) && attempt < attempts)
          continue;
        return response;
      } catch {
        const category: ProviderHttpErrorCategory =
          deadlineReached || init.signal?.aborted ? "deadline" : "network";
        if (safeRead && attempt < attempts) continue;
        throw new ProviderHttpError(operation, category, undefined, !safeRead);
      } finally {
        clearTimeout(timer);
        init.signal?.removeEventListener("abort", onAbort);
      }
    }
    throw new ProviderHttpError(operation, "network");
  }
}
