import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { CURRENT_SCOPE_GUARD_NAMESPACE } from "@reviewrouter/platform-db";
import { PrismaReviewSafetyControlRepository } from "../infrastructure/prisma/prisma-review-safety-control-repository";
import { PrismaProducerReleaseRepository } from "../infrastructure/prisma/prisma-producer-release-repository";
import { ReviewSafetyPolicyScope } from "../domain/review-run-control-types";
import {
  emergencyFixture,
  limitsProfile,
  policyFixture,
  registeredAt,
  releaseFixture,
  sloProfile,
} from "./safety-release-current-scope-fixtures";

function fixture(failGuard = false) {
  const events: string[] = [];
  const queries: Prisma.Sql[] = [];
  function delegate(name: string) {
    let row: Record<string, unknown> | null = null;
    return {
      findFirst: vi.fn(async () => {
        events.push(`${name}.read`);
        return row;
      }),
      findUnique: vi.fn(async () => {
        events.push(`${name}.read`);
        return row;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        events.push(`${name}.create`);
        row = { ...data };
        return row;
      }),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        events.push(`${name}.update`);
        row = { ...row, ...data };
        return { count: 1 };
      }),
    };
  }
  let selectors: Record<string, unknown>[] = [];
  const tx = {
    // Authentic callbacks can expose this; it must never be invoked here.
    $transaction: vi.fn(() => {
      throw new Error("nested_transaction");
    }),
    $queryRaw: vi.fn(async (sql: Prisma.Sql) => {
      events.push("lock");
      queries.push(sql);
      if (failGuard) throw new Error("scope_unavailable");
      return [{ locked: 1 }];
    }),
    reviewSafetyPolicy: delegate("policy"),
    reviewSafetyEmergencyControl: delegate("emergency"),
    reviewProtocolLimitsV2: delegate("limits"),
    reviewOperationalSloProfileV2: delegate("slo"),
    producerRelease: delegate("release"),
    reviewSafetyPolicySelector: {
      findMany: vi.fn(async () => selectors),
      deleteMany: vi.fn(async () => {
        events.push("selectors.delete");
        selectors = [];
        return { count: 0 };
      }),
      createMany: vi.fn(
        async ({ data }: { data: Record<string, unknown>[] }) => {
          events.push("selectors.create");
          selectors = data;
          return { count: data.length };
        },
      ),
    },
  };
  // A fresh callback object per transaction, retaining persistence between calls.
  const root = {
    $transaction: vi.fn(
      async (
        work: (transaction: Prisma.TransactionClient) => Promise<unknown>,
      ) => work({ ...tx } as unknown as Prisma.TransactionClient),
    ),
  };
  const db = root as unknown as PrismaClient;
  return {
    events,
    queries,
    tx,
    root,
    safety: new PrismaReviewSafetyControlRepository(db),
    releases: new PrismaProducerReleaseRepository(db),
  };
}
function digest(key: string) {
  return createHash("sha256")
    .update(CURRENT_SCOPE_GUARD_NAMESPACE)
    .update("\0")
    .update(key)
    .digest("hex");
}
const scopes = [
  { scope: ReviewSafetyPolicyScope.Global },
  { scope: ReviewSafetyPolicyScope.Workspace, workspaceId: "w" },
  {
    scope: ReviewSafetyPolicyScope.Repository,
    workspaceId: "w",
    repositoryConnectionId: "r",
    scmRepositoryIdentityId: "scm",
  },
] as const;

describe("production safety and release current scope participation", () => {
  for (const scope of scopes) {
    it.each(["policy", "emergency"] as const)(
      `${scope.scope} %s guards absence before existing keys and writes`,
      async (kind) => {
        const f = fixture();
        const result =
          kind === "policy"
            ? await f.safety.putReviewSafetyPolicy({
                expectedVersion: 0,
                policy: policyFixture(scope, "id"),
              })
            : await f.safety.putReviewSafetyEmergencyControl({
                expectedVersion: 0,
                control: emergencyFixture(scope, "id"),
              });
        expect(result.status).toBe("created");
        const keys =
          scope.scope === "global"
            ? ["global"]
            : scope.scope === "workspace"
              ? ["global", "workspace:w"]
              : ["global", "workspace:w", 'repository:["w","r"]'];
        expect(f.queries.slice(0, keys.length).map((q) => q.values)).toEqual(
          keys.map((key) => [digest(key)]),
        );
        for (let i = 0; i < keys.length; i++)
          expect(
            f.queries[i]!.sql.includes("pg_advisory_xact_lock_shared"),
          ).toBe(i < keys.length - 1);
        expect(f.events.slice(0, keys.length + 1)).toEqual(
          Array(keys.length + 1).fill("lock"),
        );
        expect(f.queries[keys.length]!.values[0]).not.toBe(
          digest(keys.at(-1)!),
        );
        expect(f.tx.$transaction).not.toHaveBeenCalled();
        if (kind === "policy")
          expect(f.events.slice(-2)).toEqual([
            "selectors.delete",
            "selectors.create",
          ]);
      },
    );
  }
  it("selector replacement and removal stay under the exact scope; idempotency and conflicts survive", async () => {
    const f = fixture();
    const policy = policyFixture(scopes[2], "id", false);
    expect(
      (await f.safety.putReviewSafetyPolicy({ expectedVersion: 0, policy }))
        .status,
    ).toBe("created");
    const next = { ...policyFixture(scopes[2], "id"), version: 2 };
    expect(
      (
        await f.safety.putReviewSafetyPolicy({
          expectedVersion: 1,
          policy: next,
        })
      ).status,
    ).toBe("updated");
    expect(
      (
        await f.safety.putReviewSafetyPolicy({
          expectedVersion: 1,
          policy: next,
        })
      ).status,
    ).toBe("restored");
    expect(
      (await f.safety.putReviewSafetyPolicy({ expectedVersion: 0, policy }))
        .status,
    ).toBe("conflict");
    expect(
      (
        await f.safety.putReviewSafetyPolicy({
          expectedVersion: 2,
          policy: { ...policy, version: 3 },
        })
      ).status,
    ).toBe("updated");
    expect(f.tx.reviewSafetyPolicySelector.createMany).toHaveBeenCalledTimes(1);
    expect(f.tx.reviewSafetyPolicySelector.deleteMany).toHaveBeenCalledTimes(3);
  });
  it("emergency stop can recover, restores repeats and rejects stale writes", async () => {
    const f = fixture();
    const control = emergencyFixture(scopes[1], "id");
    expect(
      (
        await f.safety.putReviewSafetyEmergencyControl({
          expectedVersion: 0,
          control,
        })
      ).status,
    ).toBe("created");
    const recovered = { ...control, stopped: false, version: 2 };
    expect(
      (
        await f.safety.putReviewSafetyEmergencyControl({
          expectedVersion: 1,
          control: recovered,
        })
      ).status,
    ).toBe("updated");
    expect(
      (
        await f.safety.putReviewSafetyEmergencyControl({
          expectedVersion: 1,
          control: recovered,
        })
      ).status,
    ).toBe("restored");
    expect(
      (
        await f.safety.putReviewSafetyEmergencyControl({
          expectedVersion: 0,
          control,
        })
      ).status,
    ).toBe("conflict");
  });
  const mutations = [
    (f: ReturnType<typeof fixture>) =>
      f.safety.putReviewSafetyPolicy({
        expectedVersion: 0,
        policy: policyFixture(scopes[2], "id"),
      }),
    (f: ReturnType<typeof fixture>) =>
      f.safety.putReviewSafetyEmergencyControl({
        expectedVersion: 0,
        control: emergencyFixture(scopes[2], "id"),
      }),
    (f: ReturnType<typeof fixture>) =>
      f.releases.registerProtocolLimitsProfile(limitsProfile),
    (f: ReturnType<typeof fixture>) =>
      f.releases.registerOperationalSloProfile(sloProfile),
    (f: ReturnType<typeof fixture>) =>
      f.releases.registerProducerRelease(releaseFixture("id")),
    (f: ReturnType<typeof fixture>) =>
      f.releases.revokeProducerRelease({
        producerReleaseId: "id",
        revokedAt: registeredAt,
      }),
  ];
  it.each(mutations.map((mutate, index) => ({ mutate, index })))(
    "mutation $index fails before old locks, reads or writes if scope acquisition fails",
    async ({ mutate }) => {
      const f = fixture(true);
      await expect(mutate(f)).rejects.toThrow("scope_unavailable");
      expect(f.events).toEqual(["lock"]);
    },
  );
  it.each(mutations.slice(2).map((mutate, index) => ({ mutate, index })))(
    "global registry mutation $index guards before registry keys",
    async ({ mutate }) => {
      const f = fixture();
      await mutate(f);
      expect(f.queries[0]!.values).toEqual([digest("global")]);
      expect(f.queries[0]!.sql).toContain("pg_advisory_xact_lock(");
      expect(f.events.slice(0, 2)).toEqual(["lock", "lock"]);
    },
  );
  it("profile identities stay immutable and repeated retirement is restored", async () => {
    const f = fixture();
    expect(
      (await f.releases.registerProtocolLimitsProfile(limitsProfile)).status,
    ).toBe("created");
    expect(
      (await f.releases.registerProtocolLimitsProfile(limitsProfile)).status,
    ).toBe("restored");
    expect(
      (
        await f.releases.registerProtocolLimitsProfile({
          ...limitsProfile,
          maxWorkSlots: 1,
        })
      ).status,
    ).toBe("conflict");
    expect(
      (await f.releases.registerOperationalSloProfile(sloProfile)).status,
    ).toBe("created");
    expect(
      (await f.releases.registerOperationalSloProfile(sloProfile)).status,
    ).toBe("restored");
    expect(
      (
        await f.releases.registerOperationalSloProfile({
          ...sloProfile,
          ownerRefs: ["changed"],
        })
      ).status,
    ).toBe("conflict");
    const release = releaseFixture("id");
    expect((await f.releases.registerProducerRelease(release)).status).toBe(
      "created",
    );
    expect(
      (
        await f.releases.registerProducerRelease({
          ...release,
          schemaDigest: "c".repeat(64),
        })
      ).status,
    ).toBe("conflict");
    const input = { producerReleaseId: "id", revokedAt: registeredAt };
    expect((await f.releases.revokeProducerRelease(input)).status).toBe(
      "revoked",
    );
    expect((await f.releases.revokeProducerRelease(input)).status).toBe(
      "restored",
    );
    expect((await f.releases.registerProducerRelease(release)).status).toBe(
      "restored",
    );
    expect(f.tx.producerRelease.updateMany).toHaveBeenCalledTimes(1);
  });
});
