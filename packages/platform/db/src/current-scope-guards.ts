import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";

/** Separate from review-authorization and other existing advisory namespaces. */
export const CURRENT_SCOPE_GUARD_NAMESPACE = "review-current-scope-v1";

type Mode = "shared" | "exclusive";
export type CurrentScopeGuard =
  | { readonly scope: "global"; readonly mode: Mode }
  | {
      readonly scope: "workspace";
      readonly workspaceId: string;
      readonly mode: Mode;
    }
  | {
      readonly scope: "repository";
      readonly workspaceId: string;
      readonly repositoryId: string;
      readonly mode: Mode;
    };

type Lock = { key: string; mode: Mode; rank: number };
type Held = { locks: readonly Lock[]; ready: Promise<void> };
const transactions = new WeakMap<object, Held>();

/**
 * Serialization only, never authorization. Pass the actual interactive transaction
 * and the complete scope set BEFORE existing advisory/row locks or authority reads.
 * Ancestors are shared, affected writer scopes exclusive. IDs must be canonical
 * storage IDs; protect all candidate scopes and revalidate bindings after waiting.
 *
 * Repeated covered requests are no-ops (including inside transaction repositories).
 * Extensions/upgrades fail closed: predeclare the union instead of acquiring an
 * earlier scope after row locks. The caller must not release locks/savepoint-rollback
 * and reuse this transaction. Unconverted writers do not participate in this fence.
 * READ COMMITTED readers must reread after acquisition; a Serializable snapshot can
 * predate a lock wait and must not be treated as a fresh current-authorization view.
 */
export async function acquireCurrentScopeGuards(
  transaction: Prisma.TransactionClient,
  scopes: readonly CurrentScopeGuard[],
): Promise<void> {
  // Prisma 7.8 interactive callbacks also expose $transaction. Supported
  // lifecycle methods distinguish the root; this is a caller-misuse guard.
  if (
    !transaction ||
    typeof transaction !== "object" ||
    Reflect.get(transaction, "$connect") !== undefined ||
    Reflect.get(transaction, "$disconnect") !== undefined ||
    typeof transaction.$queryRaw !== "function"
  ) {
    throw new Error("current_scope_guard_requires_transaction");
  }
  const locks = plan(scopes);
  const held = transactions.get(transaction);
  if (held) {
    if (
      !locks.every((lock) =>
        held.locks.some(
          (existing) =>
            existing.key === lock.key &&
            (existing.mode === "exclusive" || lock.mode === "shared"),
        ),
      )
    ) {
      throw new Error("current_scope_guard_plan_extension");
    }
    await held.ready;
    return;
  }
  const ready = acquire(transaction, locks);
  transactions.set(transaction, { locks, ready });
  await ready;
}

function plan(scopes: readonly CurrentScopeGuard[]): Lock[] {
  if (scopes.length === 0) throw new Error("current_scope_guard_empty_plan");
  const locks = new Map<string, Lock>();
  function add(key: string, rank: number, mode: Mode) {
    const previous = locks.get(key);
    locks.set(key, {
      key,
      rank,
      mode: previous?.mode === "exclusive" ? "exclusive" : mode,
    });
  }
  for (const scope of scopes) {
    if (scope.mode !== "shared" && scope.mode !== "exclusive")
      throw new Error("current_scope_guard_invalid_mode");
    add("global", 0, scope.scope === "global" ? scope.mode : "shared");
    if (scope.scope === "global") continue;
    validateId(scope.workspaceId);
    add(
      `workspace:${scope.workspaceId}`,
      1,
      scope.scope === "workspace" ? scope.mode : "shared",
    );
    if (scope.scope === "workspace") continue;
    if (scope.scope !== "repository")
      throw new Error("current_scope_guard_invalid_scope");
    validateId(scope.repositoryId);
    add(
      `repository:${JSON.stringify([scope.workspaceId, scope.repositoryId])}`,
      2,
      scope.mode,
    );
  }
  return [...locks.values()].sort(
    (a, b) => a.rank - b.rank || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}

function validateId(id: string) {
  if (typeof id !== "string" || !id || id.includes("\0"))
    throw new Error("current_scope_guard_invalid_id");
}

async function acquire(
  transaction: Prisma.TransactionClient,
  locks: readonly Lock[],
): Promise<void> {
  for (const lock of locks) {
    const identity = createHash("sha256")
      .update(CURRENT_SCOPE_GUARD_NAMESPACE)
      .update("\0")
      .update(lock.key)
      .digest("hex");
    // Selecting 1 avoids exposing PostgreSQL's void result to Prisma's decoder.
    await transaction.$queryRaw(
      lock.mode === "shared"
        ? Prisma.sql`SELECT 1 AS "locked" FROM pg_advisory_xact_lock_shared(hashtextextended(${identity}, 0))`
        : Prisma.sql`SELECT 1 AS "locked" FROM pg_advisory_xact_lock(hashtextextended(${identity}, 0))`,
    );
  }
}
