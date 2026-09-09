import { switchRepositoryConfigurationAuthMode } from "../../../workflow-provisioning/src/infrastructure/prisma/prisma-hosted-pool-configuration";
import type { Prisma, PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  acquireReviewConfigurationWriteScope,
  PrismaReviewConfigurationRepository,
  PrismaReviewConfigurationTransactionRepository,
} from "../infrastructure/prisma/prisma-review-configuration-repository";
import { safeDefaultReviewConfiguration } from "../domain/review-configuration";
import { PrismaEntitlementRepository } from "../../../entitlements/src/infrastructure/prisma/prisma-entitlement-repository";
import { freeBetaEntitlement } from "../../../entitlements/src/domain/entitlement";

const target = {
  scope: "repository",
  workspaceId: "w",
  repositoryId: "r",
} as const;
function harness() {
  const events: string[] = [];
  const tx = {
    $queryRaw: vi.fn(async (sql: Prisma.Sql) => {
      events.push(sql.text.includes("lock_shared(") ? "shared" : "exclusive");
      return [];
    }),
    reviewConfiguration: {
      findUnique: vi.fn(async () => {
        events.push("config-read");
        return null;
      }),
      upsert: vi.fn(async () => {
        events.push("target");
        return { id: "c" };
      }),
      deleteMany: vi.fn(async () => {
        events.push("delete");
        return { count: 0 };
      }),
    },
    reviewConfigurationVersion: {
      findFirst: vi.fn(async () => {
        events.push("version-read");
        return null;
      }),
      create: vi.fn(
        async ({
          data,
        }: {
          data: Record<string, unknown> & { providers: { create: unknown[] } };
        }) => {
          events.push("version-create");
          return { ...data, id: "v", providers: data.providers.create };
        },
      ),
    },
    workspaceEntitlement: {
      upsert: vi.fn(async () => {
        events.push("entitlement");
      }),
      findUnique: vi.fn(async () => null),
    },
  };
  const prisma = {
    $transaction: vi.fn(
      async (work: (transaction: typeof tx) => Promise<unknown>) => {
        events.push("begin");
        try {
          const result = await work(tx);
          events.push("commit");
          return result;
        } catch (error) {
          events.push("rollback");
          throw error;
        }
      },
    ),
    workspaceEntitlement: tx.workspaceEntitlement,
  };
  return {
    tx,
    prisma,
    events,
    client: prisma as unknown as PrismaClient,
    transaction: tx as unknown as Prisma.TransactionClient,
  };
}

describe("production config and entitlement scope writers", () => {
  it("guards the actual workflow config caller before resolution and reuses guards on save", async () => {
    const h = harness();
    expect(
      await switchRepositoryConfigurationAuthMode({
        transaction: h.transaction,
        workspaceId: "w",
        repositoryId: "r",
        authMode: "codex_subscription_oauth_hosted_pool",
      }),
    ).toBe(true);
    expect(h.events).toEqual([
      "shared",
      "shared",
      "exclusive",
      "config-read",
      "config-read",
      "target",
      "version-read",
      "version-create",
    ]);
  });
  it("guards an absent repo override before target/version/provider writes in the Serializable wrapper", async () => {
    const h = harness();
    const saved = await new PrismaReviewConfigurationRepository(
      h.client,
    ).saveNextVersion({
      target,
      config: safeDefaultReviewConfiguration,
      expectedVersion: null,
    });
    expect(saved.version).toBe(1);
    expect(saved.config.providers).toEqual(
      safeDefaultReviewConfiguration.providers,
    );
    expect(h.events).toEqual([
      "begin",
      "shared",
      "shared",
      "exclusive",
      "target",
      "version-read",
      "version-create",
      "commit",
    ]);
    expect(h.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
  });

  it("reuses entry guards after an upstream row lock without reacquiring an ancestor", async () => {
    const h = harness();
    await acquireReviewConfigurationWriteScope(h.transaction, target);
    h.events.push("upstream-row-lock");
    const repository = new PrismaReviewConfigurationTransactionRepository(
      h.transaction,
    );
    await repository.saveNextVersion({
      target,
      config: safeDefaultReviewConfiguration,
    });
    await repository.deleteTarget(target);
    expect(h.events).toEqual([
      "shared",
      "shared",
      "exclusive",
      "upstream-row-lock",
      "target",
      "version-read",
      "version-create",
      "delete",
    ]);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([target, { scope: "workspace", workspaceId: "w" } as const])(
    "guards even absent deleteTarget %j in its own transaction",
    async (scope) => {
      const h = harness();
      expect(
        await new PrismaReviewConfigurationRepository(h.client).deleteTarget(
          scope,
        ),
      ).toBe(false);
      expect(h.events).toEqual([
        "begin",
        "shared",
        ...(scope.scope === "repository" ? ["shared"] : []),
        "exclusive",
        "delete",
        "commit",
      ]);
    },
  );

  it("preserves expected-version conflicts and rolls back the target insertion", async () => {
    const h = harness();
    await expect(
      new PrismaReviewConfigurationRepository(h.client).saveNextVersion({
        target,
        config: safeDefaultReviewConfiguration,
        expectedVersion: 2,
      }),
    ).rejects.toThrow();
    expect(h.events.at(-1)).toBe("rollback");
    expect(h.tx.reviewConfigurationVersion.create).not.toHaveBeenCalled();
  });

  it("retries serialization conflicts with fresh transaction scope acquisitions", async () => {
    const h = harness();
    const retry = harness();
    h.prisma.$transaction.mockImplementationOnce(async (work) => {
      await work(h.tx);
      throw { code: "P2034" };
    });
    h.prisma.$transaction.mockImplementationOnce(async (work) =>
      work(retry.tx),
    );
    await new PrismaReviewConfigurationRepository(h.client).saveNextVersion({
      target,
      config: safeDefaultReviewConfiguration,
    });
    expect(h.tx.$queryRaw).toHaveBeenCalledTimes(3);
    expect(retry.tx.$queryRaw).toHaveBeenCalledTimes(3);
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it("blocks all persistence when guard acquisition fails", async () => {
    const h = harness();
    h.tx.$queryRaw.mockRejectedValueOnce(new Error("lock failed"));
    await expect(
      new PrismaReviewConfigurationRepository(h.client).saveNextVersion({
        target,
        config: safeDefaultReviewConfiguration,
      }),
    ).rejects.toThrow("lock failed");
    expect(h.tx.reviewConfiguration.upsert).not.toHaveBeenCalled();
    expect(h.events).toEqual(["begin", "rollback"]);
  });

  it("protects missing entitlement insertion with shared global then exclusive workspace", async () => {
    const h = harness();
    const repository = new PrismaEntitlementRepository(h.client);
    expect(await repository.findWorkspaceEntitlement("w")).toBeNull();
    const entitlement = {
      ...freeBetaEntitlement("w"),
      status: "paused" as const,
    };
    await repository.upsertWorkspaceEntitlement(entitlement);
    expect(h.events).toEqual([
      "begin",
      "shared",
      "exclusive",
      "entitlement",
      "commit",
    ]);
    expect(h.tx.workspaceEntitlement.upsert).toHaveBeenCalledWith({
      where: { workspaceId: "w" },
      update: {
        plan: entitlement.plan,
        status: "paused",
        limits: entitlement.limits,
        flags: entitlement.flags,
      },
      create: entitlement,
    });
  });
});
