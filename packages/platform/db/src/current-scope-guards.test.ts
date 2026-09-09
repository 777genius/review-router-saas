import type { SqlDriverAdapterFactory } from "@prisma/client/runtime/client";
import { createHash } from "node:crypto";
import { PrismaClient, Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  acquireCurrentScopeGuards,
  CURRENT_SCOPE_GUARD_NAMESPACE,
  type CurrentScopeGuard,
} from "./current-scope-guards";

function transaction() {
  const calls: Prisma.Sql[] = [];
  return {
    calls,
    tx: {
      $queryRaw: vi.fn(async (sql: Prisma.Sql) => {
        calls.push(sql);
        return [];
      }),
    } as unknown as Prisma.TransactionClient,
  };
}
const digest = (key: string) =>
  createHash("sha256")
    .update(`${CURRENT_SCOPE_GUARD_NAMESPACE}\0${key}`)
    .digest("hex");
const repo = (
  workspaceId: string,
  repositoryId: string,
  mode: "shared" | "exclusive" = "shared",
): CurrentScopeGuard => ({
  scope: "repository",
  workspaceId,
  repositoryId,
  mode,
});

describe("current scope transaction guards", () => {
  it("admits the real Prisma interactive proxy and rejects the real root before driver I/O", async () => {
    // Supported driver-adapter boundary: Prisma itself constructs the callback
    // client and executes its query pipeline. No mocked Prisma client/proxy.
    // SQL results/locking are deliberately not simulated as PostgreSQL evidence.
    const info = {
      provider: "postgres" as const,
      adapterName: "boundary-test",
    };
    const rootQuery = vi.fn(async () => {
      throw new Error("unexpected_root_query");
    });
    const txQuery = vi.fn(async () => {
      throw new Error("reached_interactive_transaction_driver");
    });
    const adapter: SqlDriverAdapterFactory = {
      ...info,
      connect: async () => ({
        ...info,
        queryRaw: rootQuery,
        executeRaw: rootQuery,
        executeScript: async () => {},
        dispose: async () => {},
        startTransaction: async () => ({
          ...info,
          options: { usePhantomQuery: true },
          queryRaw: txQuery,
          executeRaw: txQuery,
          commit: async () => {},
          rollback: async () => {},
        }),
      }),
    };
    const db = new PrismaClient({ adapter });
    try {
      await expect(
        acquireCurrentScopeGuards(db, [repo("w", "r")]),
      ).rejects.toThrow("requires_transaction");
      for (const dto of [null, {}, { approved: true }]) {
        await expect(
          acquireCurrentScopeGuards(dto as Prisma.TransactionClient, [
            repo("w", "r"),
          ]),
        ).rejects.toThrow("requires_transaction");
      }
      await db.$transaction(async (tx) => {
        // Reproduces the r115 failure on the installed Prisma 7.8 runtime.
        expect(Reflect.has(tx, "$transaction")).toBe(true);
        expect(typeof Reflect.get(tx, "$transaction")).toBe("function");
        expect(Reflect.get(tx, "$connect")).toBeUndefined();
        expect(Reflect.get(tx, "$disconnect")).toBeUndefined();
        await expect(
          acquireCurrentScopeGuards(tx, [repo("w", "r")]),
        ).rejects.toThrow("reached_interactive_transaction_driver");
      });
      expect(rootQuery).not.toHaveBeenCalled();
      expect(txQuery).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          sql: expect.stringContaining("pg_advisory_xact_lock"),
        }),
      );
    } finally {
      await db.$disconnect();
    }
  });

  it("deduplicates, promotes modes and sorts all ancestors before repositories", async () => {
    const { tx, calls } = transaction();
    await acquireCurrentScopeGuards(tx, [
      repo("z", "b"),
      repo("a", "z", "exclusive"),
      repo("a", "a"),
      repo("a", "a"),
      { scope: "workspace", workspaceId: "z", mode: "exclusive" },
    ]);
    expect(calls.map((sql) => sql.values)).toEqual(
      [
        "global",
        "workspace:a",
        "workspace:z",
        'repository:["a","a"]',
        'repository:["a","z"]',
        'repository:["z","b"]',
      ].map((key) => [digest(key)]),
    );
    expect(calls.map((sql) => sql.text.includes("lock_shared("))).toEqual([
      true,
      true,
      false,
      true,
      false,
      true,
    ]);
  });

  it.each([
    [[{ scope: "global", mode: "exclusive" }], [false]],
    [
      [{ scope: "workspace", workspaceId: "w", mode: "exclusive" }],
      [true, false],
    ],
    [[repo("w", "r", "exclusive")], [true, true, false]],
    [[repo("w", "r")], [true, true, true]],
  ] as [CurrentScopeGuard[], boolean[]][])(
    "uses the requested writer hierarchy: %j",
    async (scopes, shared) => {
      const { tx, calls } = transaction();
      await acquireCurrentScopeGuards(tx, scopes);
      expect(calls.map((sql) => sql.text.includes("lock_shared("))).toEqual(
        shared,
      );
    },
  );

  it("reuses covered requests but rejects extension and upgrades before further SQL", async () => {
    const { tx, calls } = transaction();
    await acquireCurrentScopeGuards(tx, [repo("w", "r", "exclusive")]);
    await acquireCurrentScopeGuards(tx, [repo("w", "r")]);
    await acquireCurrentScopeGuards(tx, [repo("w", "r", "exclusive")]);
    await expect(
      acquireCurrentScopeGuards(tx, [repo("w", "s")]),
    ).rejects.toThrow("plan_extension");
    await expect(
      acquireCurrentScopeGuards(tx, [
        { scope: "workspace", workspaceId: "w", mode: "exclusive" },
      ]),
    ).rejects.toThrow("plan_extension");
    expect(calls).toHaveLength(3);
  });

  it("awaits in-flight coverage and retains acquisition failures", async () => {
    let reject!: (reason: Error) => void;
    const query = vi.fn(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const tx = { $queryRaw: query } as unknown as Prisma.TransactionClient;
    const first = acquireCurrentScopeGuards(tx, [repo("w", "r")]);
    const second = acquireCurrentScopeGuards(tx, [repo("w", "r")]);
    reject(new Error("lock timeout"));
    await expect(first).rejects.toThrow("lock timeout");
    await expect(second).rejects.toThrow("lock timeout");
    await expect(
      acquireCurrentScopeGuards(tx, [repo("w", "r")]),
    ).rejects.toThrow("lock timeout");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("validates the entire plan before any SQL and rejects top-level clients", async () => {
    const { tx, calls } = transaction();
    await expect(
      acquireCurrentScopeGuards(tx, [repo("w", "r"), repo("", "r")]),
    ).rejects.toThrow("invalid_id");
    await expect(acquireCurrentScopeGuards(tx, [])).rejects.toThrow(
      "empty_plan",
    );
    await expect(
      acquireCurrentScopeGuards(
        {
          ...tx,
          $connect: () => {},
        } as unknown as Prisma.TransactionClient,
        [repo("w", "r")],
      ),
    ).rejects.toThrow("requires_transaction");
    expect(calls).toHaveLength(0);
  });
});
