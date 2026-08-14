import { describe, expect, it, vi } from "vitest";
import {
  BoundedProviderHttpClient,
  ProviderHttpError,
  collectCompleteInventory,
} from "./bounded-provider-io";

describe("bounded provider inventory", () => {
  it("proves an exact complete inventory", async () => {
    const result = await collectCompleteInventory(
      async (cursor) =>
        cursor
          ? { items: [2], nextCursor: null }
          : { items: [1], nextCursor: "cursor-2" },
      { maxPages: 2, maxItems: 2 },
    );
    expect(result).toEqual({ complete: true, items: [1, 2], pages: 2 });
  });

  it.each([
    ["cursor cycle", ["same", "same"], "cursor_cycle"],
    ["malformed cursor", ["bad cursor"], "malformed_cursor"],
  ] as const)("rejects %s", async (_name, cursors, reason) => {
    let page = 0;
    const result = await collectCompleteInventory(
      async () => ({ items: [page], nextCursor: cursors[page++] ?? null }),
      { maxPages: 4, maxItems: 10 },
    );
    expect(result).toMatchObject({ complete: false, reason });
  });

  it("bounds endless pages", async () => {
    let page = 0;
    const result = await collectCompleteInventory(
      async () => ({ items: [page], nextCursor: `cursor-${++page}` }),
      { maxPages: 3, maxItems: 10 },
    );
    expect(result).toMatchObject({
      complete: false,
      reason: "max_pages",
      pages: 3,
    });
  });

  it("rejects item overflow without returning the overflowing page", async () => {
    const result = await collectCompleteInventory(
      async () => ({ items: [1, 2, 3], nextCursor: null }),
      { maxPages: 2, maxItems: 2 },
    );
    expect(result).toEqual({
      complete: false,
      items: [],
      pages: 1,
      reason: "max_items",
    });
  });
});

describe("bounded provider HTTP", () => {
  it("aborts and finitely retries a hung safe read", async () => {
    const fetchImpl = vi.fn(
      async (_url: string, init?: RequestInit): Promise<Response> =>
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const client = new BoundedProviderHttpClient(fetchImpl, {
      deadlineMs: 5,
      safeReadAttempts: 2,
    });
    await expect(
      client.request("inventory", "https://provider.invalid"),
    ).rejects.toMatchObject({ category: "deadline", ambiguousWrite: false });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("never repeats a hung write and categorizes the outcome as ambiguous", async () => {
    const fetchImpl = vi.fn(
      async (_url: string, init?: RequestInit): Promise<Response> =>
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const client = new BoundedProviderHttpClient(fetchImpl, {
      deadlineMs: 5,
      safeReadAttempts: 3,
    });
    const error = await client
      .request("mutate", "https://provider.invalid", { method: "POST" })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error).toMatchObject({ category: "deadline", ambiguousWrite: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("drops adversarial URL, request, nested error, and abort secrets", async () => {
    const canaries = [
      "url-secret-canary",
      "request-header-canary",
      "nested-network-canary",
      "abort-reason-canary",
    ];
    const controller = new AbortController();
    controller.abort(new Error(canaries[3]));
    const client = new BoundedProviderHttpClient(
      vi.fn().mockRejectedValue(
        new Error(canaries[2], {
          cause: new Error("postgresql://user:dsn-secret@db.invalid/app"),
        }),
      ),
      { deadlineMs: 5, safeReadAttempts: 1 },
    );
    const error = await client
      .request("mutate", `https://provider.invalid/?token=${canaries[0]}`, {
        method: "POST",
        headers: { authorization: `Bearer ${canaries[1]}` },
        body: JSON.stringify({ auth: "auth-json-canary" }),
        signal: controller.signal,
      })
      .catch((value: unknown) => value);
    const outputs = [String(error), JSON.stringify(error)];
    for (const output of outputs) {
      expect(output.length).toBeLessThan(768);
      for (const canary of [...canaries, "dsn-secret", "auth-json-canary"])
        expect(output).not.toContain(canary);
    }
  });
});
