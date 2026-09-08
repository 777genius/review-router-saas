import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { CURRENT_SCOPE_GUARD_NAMESPACE } from "@reviewrouter/platform-db";
import { PrismaScmRepositoryIdentityRepository } from "../infrastructure/prisma/prisma-scm-repository-identity-repository";
import { PrismaReviewMutationAuthorityRepository } from "../infrastructure/prisma/prisma-review-mutation-authority-repository";
import {
  ReviewMutationLaneKind,
  ReviewMutationMode,
} from "../domain/review-run-control-types";
import {
  identityFixture,
  authorityFixture,
  changedAt,
} from "./scm-mutation-current-scope-fixtures";

const bind = {
  scmRepositoryIdentityId: "scm",
  expectedVersion: 1,
  workspaceId: "w",
  repositoryConnectionId: "storage",
  boundAt: changedAt,
};
const unbind = {
  scmRepositoryIdentityId: "scm",
  expectedVersion: 2,
  unboundAt: changedAt,
  authority: {
    laneKind: ReviewMutationLaneKind.HostedReviewRouterApp,
    expectedVersion: 1,
  },
};
function fixture(failGuard = false) {
  const events: string[] = [];
  const queries: Prisma.Sql[] = [];
  const state = {
    identity: null as Record<string, unknown> | null,
    authority: null as Record<string, unknown> | null,
    repository: {
      id: "storage",
      workspaceId: "w",
      provider: "github",
      sourceBaseUrl: "https://github.com/",
      externalRepositoryId: "external",
      scmRepositoryIdentityId: null,
    } as Record<string, unknown>,
  };
  function delegate(name: "identity" | "authority" | "repository") {
    return {
      findUnique: vi.fn(async () => {
        events.push(`${name}.read`);
        return state[name];
      }),
      findFirst: vi.fn(async () => {
        events.push(`${name}.owner`);
        return null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        events.push(`${name}.create`);
        state[name] = { ...data };
        return state[name];
      }),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        events.push(`${name}.update`);
        state[name] = { ...state[name], ...data };
        return { count: 1 };
      }),
    };
  }
  const tx = {
    $transaction: vi.fn(() => {
      throw new Error("nested_transaction");
    }),
    $queryRaw: vi.fn(async (sql: Prisma.Sql) => {
      events.push("lock");
      queries.push(sql);
      if (failGuard) throw new Error("scope_unavailable");
      return [{ locked: 1 }];
    }),
    scmRepositoryIdentity: delegate("identity"),
    reviewMutationAuthority: delegate("authority"),
    repositoryConnection: delegate("repository"),
  };
  const root = {
    scmRepositoryIdentity: {
      findUnique: vi.fn(async () => {
        events.push("observation");
        return state.identity;
      }),
    },
    reviewMutationAuthority: tx.reviewMutationAuthority,
    $transaction: vi.fn(
      async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        work({ ...tx } as unknown as Prisma.TransactionClient),
    ),
  };
  const db = root as unknown as PrismaClient;
  return {
    events,
    queries,
    state,
    tx,
    root,
    identities: new PrismaScmRepositoryIdentityRepository(db),
    authorities: new PrismaReviewMutationAuthorityRepository(db),
  };
}
const mutations = [
  {
    name: "register",
    run: (f: ReturnType<typeof fixture>) =>
      f.identities.resolveOrRegisterScmRepositoryIdentity({
        identity: identityFixture(),
      }),
  },
  {
    name: "bind",
    run: (f: ReturnType<typeof fixture>) =>
      f.identities.bindScmRepositoryIdentity(bind),
  },
  {
    name: "unbind",
    run: (f: ReturnType<typeof fixture>) =>
      f.identities.unbindScmRepositoryIdentity(unbind),
  },
  {
    name: "initialize",
    run: (f: ReturnType<typeof fixture>) =>
      f.authorities.initializeReviewMutationAuthority(authorityFixture()),
  },
  {
    name: "CAS",
    run: (f: ReturnType<typeof fixture>) =>
      f.authorities.compareAndSetReviewMutationAuthority({
        expectedVersion: 1,
        authority: { ...authorityFixture(), version: 2 },
      }),
  },
];
describe("SCM and App mutation production scope guards", () => {
  it.each(mutations)(
    "$name guards before old keys and transactional reads even on absence",
    async ({ name, run }) => {
      const f = fixture();
      await run(f);
      expect(
        f.events.slice(
          name === "register" ? 1 : 0,
          name === "register" ? 3 : 2,
        ),
      ).toEqual(["lock", "lock"]);
      expect(f.queries[0]!.values).toEqual([
        createHash("sha256")
          .update(CURRENT_SCOPE_GUARD_NAMESPACE)
          .update("\0global")
          .digest("hex"),
      ]);
      expect(f.queries[0]!.sql).toContain("pg_advisory_xact_lock(");
      expect(f.queries[1]!.values).not.toEqual(f.queries[0]!.values);
      expect(f.tx.$transaction).not.toHaveBeenCalled();
    },
  );
  it.each(mutations)(
    "$name fails before old locks/rows/writes when guard fails",
    async ({ name, run }) => {
      const f = fixture(true);
      await expect(run(f)).rejects.toThrow("scope_unavailable");
      expect(f.events).toEqual(
        name === "register" ? ["observation", "lock"] : ["lock"],
      );
    },
  );
  it("read-only resolution and query ports acquire no global writer", async () => {
    const f = fixture(true);
    f.state.identity = identityFixture();
    expect(
      (
        await f.identities.resolveOrRegisterScmRepositoryIdentity({
          identity: identityFixture("other"),
        })
      ).status,
    ).toBe("restored");
    await f.identities.findScmRepositoryIdentityById("scm");
    await f.identities.findScmRepositoryIdentityByExternalIdentity(
      identityFixture(),
    );
    await f.authorities.findReviewMutationAuthority(authorityFixture());
    expect(f.root.$transaction).not.toHaveBeenCalled();
    expect(f.queries).toEqual([]);
  });
  it("rechecks external identity after absence observation, preserving a concurrent winner", async () => {
    const f = fixture();
    f.state.identity = identityFixture("winner");
    f.root.scmRepositoryIdentity.findUnique.mockResolvedValueOnce(null);
    const result = await f.identities.resolveOrRegisterScmRepositoryIdentity({
      identity: identityFixture(),
    });
    expect(result).toMatchObject({
      status: "restored",
      identity: { scmRepositoryIdentityId: "winner" },
    });
    expect(f.events).toEqual(["lock", "lock", "identity.read"]);
    expect(f.tx.scmRepositoryIdentity.create).not.toHaveBeenCalled();
  });
  it("registration keeps immutable ID collision rejection", async () => {
    const f = fixture();
    f.tx.scmRepositoryIdentity.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(identityFixture("scm", "different"));
    await expect(
      f.identities.resolveOrRegisterScmRepositoryIdentity({
        identity: identityFixture(),
      }),
    ).rejects.toThrow("scm_repository_identity_id_conflict");
    expect(f.tx.scmRepositoryIdentity.create).not.toHaveBeenCalled();
  });
  it("bind and unbind update both sides with existing CAS and restore semantics", async () => {
    const f = fixture();
    f.state.identity = identityFixture();
    f.state.authority = { ...authorityFixture(), mode: "paused" };
    expect((await f.identities.bindScmRepositoryIdentity(bind)).status).toBe(
      "bound",
    );
    expect(f.state.repository.scmRepositoryIdentityId).toBe("scm");
    expect(f.state.identity).toMatchObject({
      version: 2,
      currentRepositoryConnectionId: "storage",
      currentWorkspaceId: "w",
      externalRepositoryId: "external",
    });
    expect(
      (
        await f.identities.bindScmRepositoryIdentity({
          ...bind,
          expectedVersion: 0,
        })
      ).status,
    ).toBe("restored");
    expect(
      (
        await f.identities.unbindScmRepositoryIdentity({
          ...unbind,
          expectedVersion: 0,
        })
      ).status,
    ).toBe("conflict");
    expect(
      (await f.identities.unbindScmRepositoryIdentity(unbind)).status,
    ).toBe("unbound");
    expect(f.state.repository.scmRepositoryIdentityId).toBeNull();
    expect(f.state.identity).toMatchObject({
      version: 3,
      currentWorkspaceId: null,
      currentRepositoryConnectionId: null,
    });
    expect(
      (await f.identities.unbindScmRepositoryIdentity(unbind)).status,
    ).toBe("restored");
    expect(f.tx.repositoryConnection.updateMany).toHaveBeenCalledTimes(2);
    expect(
      f.tx.scmRepositoryIdentity.updateMany.mock.calls[0]![0],
    ).toMatchObject({
      where: {
        version: 1,
        currentWorkspaceId: null,
        currentRepositoryConnectionId: null,
      },
    });
    expect(
      f.tx.repositoryConnection.updateMany.mock.calls[1]![0],
    ).toMatchObject({
      where: { id: "storage", scmRepositoryIdentityId: "scm" },
    });
  });
  it.each([
    "provider",
    "externalRepositoryId",
    "workspaceId",
    "scmRepositoryIdentityId",
  ])("bind rejects repository %s mismatch under the guard", async (field) => {
    const f = fixture();
    f.state.identity = identityFixture();
    f.state.repository[field] = "other";
    expect((await f.identities.bindScmRepositoryIdentity(bind)).status).toBe(
      "conflict",
    );
    expect(f.tx.repositoryConnection.updateMany).not.toHaveBeenCalled();
  });
  it("bound cross-workspace identity conflicts; paused authority is rechecked on unbind", async () => {
    const f = fixture();
    f.state.identity = {
      ...identityFixture(),
      version: 2,
      currentWorkspaceId: "old-workspace",
      currentRepositoryConnectionId: "old-storage",
    };
    expect((await f.identities.bindScmRepositoryIdentity(bind)).status).toBe(
      "conflict",
    );
    f.state.authority = authorityFixture();
    expect(
      (await f.identities.unbindScmRepositoryIdentity(unbind)).status,
    ).toBe("authority_not_paused");
    f.state.authority = { ...authorityFixture(), mode: "paused", version: 2 };
    expect(
      (await f.identities.unbindScmRepositoryIdentity(unbind)).status,
    ).toBe("authority_not_paused");
    expect(f.tx.scmRepositoryIdentity.updateMany).not.toHaveBeenCalled();
  });
  it("authority initialization, epoch/state CAS, duplicate and stale/missing semantics survive", async () => {
    const f = fixture();
    const authority = authorityFixture();
    expect(
      (
        await f.authorities.compareAndSetReviewMutationAuthority({
          expectedVersion: 1,
          authority,
        })
      ).status,
    ).toBe("missing");
    expect(
      (await f.authorities.initializeReviewMutationAuthority(authority)).status,
    ).toBe("created");
    expect(
      (await f.authorities.initializeReviewMutationAuthority(authority)).status,
    ).toBe("restored");
    expect(
      (
        await f.authorities.initializeReviewMutationAuthority({
          ...authority,
          epoch: 2n,
        })
      ).status,
    ).toBe("conflict");
    const next = {
      ...authority,
      version: 2,
      epoch: 2n,
      mode: ReviewMutationMode.Paused,
      pausedAt: changedAt,
    };
    expect(
      (
        await f.authorities.compareAndSetReviewMutationAuthority({
          expectedVersion: 1,
          authority: next,
        })
      ).status,
    ).toBe("updated");
    expect(
      (
        await f.authorities.compareAndSetReviewMutationAuthority({
          expectedVersion: 1,
          authority: next,
        })
      ).status,
    ).toBe("restored");
    expect(
      (
        await f.authorities.compareAndSetReviewMutationAuthority({
          expectedVersion: 1,
          authority,
        })
      ).status,
    ).toBe("conflict");
    expect(f.state.authority).toMatchObject({
      version: 2,
      epoch: 2n,
      mode: "paused",
    });
    expect(f.tx.reviewMutationAuthority.updateMany).toHaveBeenCalledTimes(1);
  });
});
