import {
  CapabilityAudience,
  CapabilityKind,
  JoseRotatingCapabilityCodec,
} from "@reviewrouter/platform-signed-capabilities";
import { ReviewRunAuthorizationSignedCapabilityAdapter } from "../infrastructure/signed-capabilities/review-run-authorization-token-adapter";
import { describe, expect, it, vi } from "vitest";
import {
  PrismaClient,
  type ReviewRunAuthorization as PrismaAuthorization,
} from "@prisma/client";
import type { SqlDriverAdapterFactory } from "@prisma/client/runtime/client";
import type { ReviewRunControlTransaction } from "../infrastructure/prisma/prisma-review-run-control-utils";
import {
  PrismaLockedReviewRunPrincipalReader,
  type VerifiedCurrentReviewRunPrincipal,
} from "../infrastructure/prisma/prisma-locked-review-run-principal-reader";
import { createReviewRunControlTestKit } from "../testing/review-run-control-test-kit";
import { provisionV2AuthorizationContext } from "./fixtures";

async function fixture() {
  const kit = createReviewRunControlTestKit({ now: new Date() });
  const context = await provisionV2AuthorizationContext(kit);
  const issued = await kit.control.authorizations.authorizeReviewRun(
    context.authorizeInput,
  );
  if (!("authorization" in issued)) throw new Error("fixture_failed");
  const reader = new PrismaLockedReviewRunPrincipalReader(kit.tokens);
  const principal = await reader.preflight(issued.token.token);
  const row = {
    ...issued.authorization,
    revokedAt: null,
  } as unknown as PrismaAuthorization;
  const order: string[] = [];
  const transaction = {
    $queryRaw: vi.fn(async () => {
      order.push(order.length === 0 ? "advisory" : "share");
      return [{ authorizationId: row.authorizationId }];
    }),
    reviewRunAuthorization: {
      findUnique: vi.fn(async () => {
        order.push("reread");
        return row;
      }),
    },
  } as unknown as ReviewRunControlTransaction;
  return { kit, issued, reader, principal, row, transaction, order };
}

describe("locked CURRENT review run principal", () => {
  it("uses the caller transaction in advisory → SHARE → complete reread order", async () => {
    const f = await fixture();
    const locked = await f.reader.lock(f.transaction, f.principal);
    expect(f.order).toEqual(["advisory", "share", "reread"]);
    const queries = vi.mocked(f.transaction.$queryRaw).mock.calls;
    expect(queries[0]?.[0]).toMatchObject({
      strings: expect.arrayContaining([
        expect.stringContaining("pg_advisory_xact_lock"),
      ]),
    });
    expect(queries[1]?.[0]).toMatchObject({
      strings: expect.arrayContaining([expect.stringContaining("FOR SHARE")]),
    });
    expect(
      f.transaction.reviewRunAuthorization.findUnique,
    ).toHaveBeenCalledWith({
      where: { authorizationId: f.row.authorizationId },
    });
    expect(locked.assert(Date.now())).toBeUndefined();
    expect(Object.isFrozen(locked)).toBe(true);
    expect(Object.isFrozen(locked.authorization)).toBe(true);
    expect(Object.isFrozen(locked.authorization.providerVoteLanes[0])).toBe(
      true,
    );
    expect(Object.isFrozen(locked.principal.token.providerVoteLaneIds)).toBe(
      true,
    );
    expect(locked.principal.token).not.toHaveProperty("expiresAt");
    expect(locked.authorization).not.toHaveProperty("expiresAt");
    expect(
      JSON.stringify(locked, (_, value) =>
        typeof value === "bigint" ? String(value) : value,
      ),
    ).not.toContain(f.issued.token.token);
    locked.close();
    expect(() => locked.assert(Date.now())).toThrow("not_current");
  });

  it("rejects copied metadata/transport approvals, foreign-reader handles and root clients", async () => {
    const f = await fixture();
    for (const input of [
      { ...f.principal },
      { approved: true },
      JSON.parse("{}"),
    ]) {
      await expect(
        f.reader.lock(
          f.transaction,
          input as VerifiedCurrentReviewRunPrincipal,
        ),
      ).rejects.toThrow("not_current");
    }
    const other = new PrismaLockedReviewRunPrincipalReader(f.kit.tokens);
    await expect(other.lock(f.transaction, f.principal)).rejects.toThrow(
      "not_current",
    );
    await expect(
      f.reader.lock(
        {
          ...f.transaction,
          $transaction() {},
          $connect() {},
          $disconnect() {},
        } as unknown as ReviewRunControlTransaction,
        f.principal,
      ),
    ).rejects.toThrow("not_current");
    expect(f.order).toEqual([]);
    await expect(
      f.reader.preflight(`${f.issued.token.token}tampered`),
    ).rejects.toThrow();
  });

  it("admits the real Prisma interactive proxy and rejects the real root before driver I/O", async () => {
    const f = await fixture();
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
      await expect(f.reader.lock(db, f.principal)).rejects.toThrow(
        "not_current",
      );
      for (const dto of [null, {}, { approved: true }]) {
        await expect(
          f.reader.lock(dto as ReviewRunControlTransaction, f.principal),
        ).rejects.toThrow("not_current");
      }
      await db.$transaction(async (tx) => {
        // Reproduces the r115 failure on the installed Prisma 7.8 runtime.
        expect(Reflect.has(tx, "$transaction")).toBe(true);
        expect(typeof Reflect.get(tx, "$transaction")).toBe("function");
        expect(Reflect.get(tx, "$connect")).toBeUndefined();
        expect(Reflect.get(tx, "$disconnect")).toBeUndefined();
        await expect(f.reader.lock(tx, f.principal)).rejects.toThrow(
          "reached_interactive_transaction_driver",
        );
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

  it.each([
    { state: "revoked" },
    { state: "expired" },
    { revokedAt: new Date() },
    { workspaceId: "other" },
    { repositoryConnectionId: "other" },
    { scmRepositoryIdentityId: "other" },
    { pullRequestNumber: 99 },
    { tokenIssuer: "other" },
    { producerReleaseId: "other" },
    { schemaDigest: "f".repeat(64) },
    { protocolLimitsProfileId: "other" },
    { operationalSloProfileId: "other" },
    { mutationEpoch: 987n },
    { authorizationSafetyDecisionHash: "f".repeat(64) },
    { providerVoteLanes: [] },
    { renewedAt: new Date(0) },
    { expiresAt: new Date(0) },
  ])("rejects current row drift %o", async (change) => {
    const f = await fixture();
    Object.assign(f.row, change);
    await expect(f.reader.lock(f.transaction, f.principal)).rejects.toThrow();
  });

  it("keeps authenticated nbf distinct from iat and rejects JOSE preflight skew at command time", async () => {
    const f = await fixture();
    const codec = new JoseRotatingCapabilityCodec(f.kit.tokenKeyRing, 60);
    const claims = await codec.verify({
      token: f.issued.token.token,
      now: new Date(),
      expectedIssuer: f.row.tokenIssuer,
      expectedAudience: CapabilityAudience.ReviewRun,
      expectedKind: CapabilityKind.RunAuthorization,
    });
    const notBefore = new Date(Date.now() + 30_000);
    const signed = await codec.sign({ ...claims, notBefore });
    const reader = new PrismaLockedReviewRunPrincipalReader(
      new ReviewRunAuthorizationSignedCapabilityAdapter(
        codec,
        f.kit.tokenKeyRing,
      ),
    );
    const principal = await reader.preflight(signed.token);
    expect(principal.token.notBeforeMs).not.toBe(principal.token.issuedAtMs);
    const locked = await reader.lock(f.transaction, principal);
    expect(() => locked.assert(Date.now())).toThrow("not_current");
    expect(locked.assert(principal.token.notBeforeMs)).toBeUndefined();
  });

  it("rejects missing rows, including disappearance before the complete read", async () => {
    const f = await fixture();
    vi.mocked(f.transaction.$queryRaw)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    await expect(f.reader.lock(f.transaction, f.principal)).rejects.toThrow(
      "not_current",
    );
    expect(
      f.transaction.reviewRunAuthorization.findUnique,
    ).not.toHaveBeenCalled();
    const g = await fixture();
    vi.mocked(
      g.transaction.reviewRunAuthorization.findUnique,
    ).mockResolvedValue(null);
    await expect(g.reader.lock(g.transaction, g.principal)).rejects.toThrow(
      "not_current",
    );
  });

  it("strictly checks command/recovery time after waits with no lease or JOSE skew", async () => {
    const f = await fixture();
    const locked = await f.reader.lock(f.transaction, f.principal);
    expect(() => locked.assert(f.principal.token.notBeforeMs - 1)).toThrow(
      "not_current",
    );
    expect(locked.assert(f.principal.token.notBeforeMs)).toBeUndefined();
    const expiry = Math.min(
      f.principal.token.expiresAtMs,
      locked.authorization.expiresAtMs,
    );
    expect(locked.assert(expiry - 1)).toBeUndefined();
    for (const at of [expiry, expiry + 1, NaN, Infinity, -Infinity]) {
      expect(() => locked.assert(at)).toThrow("not_current");
    }
    // Same NumericDate still matches, but the exact row expiry remains binding.
    f.row.expiresAt = new Date(f.principal.token.expiresAtMs + 500);
    const fractional = await f.reader.lock(f.transaction, f.principal);
    expect(() => fractional.assert(f.principal.token.expiresAtMs)).toThrow(
      "not_current",
    );
  });
});
