import { beforeEach, describe, expect, it, vi } from "vitest";

const { observe, mutationDatabaseIsReady } = vi.hoisted(() => ({
  observe: vi.fn(
    async (connection: { observation: unknown }) => connection.observation,
  ),
  mutationDatabaseIsReady: vi.fn(() => true),
}));

vi.mock("./postgres-readiness", () => ({
  observeReleaseAuthorityDatabaseReadinessOnConnection: observe,
}));
vi.mock("../application/readiness", () => ({
  releaseControlMutationDatabaseIsReady: mutationDatabaseIsReady,
}));

import {
  executeAtomicReleaseControlMutation,
  executeSameConnectionFenced,
} from "./same-connection-fence";

const timing = {
  maxWaitMilliseconds: 20,
  lockTimeoutMilliseconds: 10,
  statementTimeoutMilliseconds: 30,
  transactionTimeoutMilliseconds: 40,
};

const roles = [
  "reviewrouter_release_control",
  "reviewrouter_provider_authority",
  "reviewrouter_activation_permit_installer",
  "reviewrouter_activation_receipt_reader",
] as const;

const fixture = () => {
  const events: string[] = [];
  const entries = roles.map((roleName, index) => {
    const target = index >= 2;
    const expected = {
      roleName,
      databaseIdentity: {
        serverIdentity: target ? "2" : "1",
        databaseIdentity: target ? "20" : "10",
        databaseName: target ? "target" : "authority",
      },
      postgresMajor: 17 as const,
    };
    const connection = {
      observation: {
        roleName,
        databaseIdentity: expected.databaseIdentity,
        postgresMajor: 17,
      },
      $queryRaw: vi.fn(async (query: { strings?: readonly string[] }) => {
        const sql = query.strings?.join(" ") ?? "";
        if (sql.includes("current_user"))
          return [
            {
              roleName,
              serverIdentity: expected.databaseIdentity.serverIdentity,
              databaseIdentity: expected.databaseIdentity.databaseIdentity,
              databaseName: expected.databaseIdentity.databaseName,
              postgresMajor: 17,
            },
          ];
        events.push(
          sql.includes("pg_advisory_xact_lock_shared") ? "lock" : "timeout",
        );
        return [{ locked: true }];
      }),
    };
    const prisma = {
      $transaction: vi.fn(
        async (operation: (client: typeof connection) => unknown) => {
          events.push(`begin:${roleName}`);
          try {
            const result = await operation(connection);
            events.push(`commit:${roleName}`);
            return result;
          } catch (error) {
            events.push(`rollback:${roleName}`);
            throw error;
          }
        },
      ),
    };
    return { prisma, expected, connection };
  });
  return {
    events,
    entries,
    clients: {
      control: entries[0]!,
      provider: entries[1]!,
      installer: entries[2]!,
      reader: entries[3]!,
    },
  };
};

describe("atomic catalog-attested mutation boundary", () => {
  beforeEach(() => {
    observe.mockClear();
    mutationDatabaseIsReady.mockReset().mockReturnValue(true);
  });

  it("holds the matching migration lock, attests exact identity, then reuses the transaction connection", async () => {
    const { clients, entries, events } = fixture();
    const mutation = vi.fn(() =>
      executeSameConnectionFenced(
        clients.control.prisma as never,
        clients.control.expected,
        async (connection) => {
          expect(connection).toBe(clients.control.connection);
          events.push("mutation");
          return "ok";
        },
        timing,
      ),
    );

    await expect(
      executeAtomicReleaseControlMutation(
        clients as never,
        "control",
        {} as never,
        mutation,
        timing,
        () => Object.assign(new Error("unavailable"), { statusCode: 503 }),
      ),
    ).resolves.toBe("ok");

    expect(observe).toHaveBeenCalledOnce();
    expect(mutationDatabaseIsReady).toHaveBeenCalledOnce();
    expect(mutation).toHaveBeenCalledOnce();
    expect(events.filter((event) => event === "lock")).toHaveLength(1);
    expect(entries[0]!.prisma.$transaction).toHaveBeenCalledOnce();
    expect(events.indexOf("mutation")).toBeGreaterThan(
      events.lastIndexOf("lock"),
    );
  });

  it("selects the activation migration exclusion lock for installer writes", async () => {
    const { clients } = fixture();

    await executeAtomicReleaseControlMutation(
      clients as never,
      "installer",
      {} as never,
      () =>
        executeSameConnectionFenced(
          clients.installer.prisma as never,
          clients.installer.expected,
          async () => "installed",
          timing,
        ),
      timing,
      () => new Error("unavailable"),
    );

    expect(clients.control.prisma.$transaction).not.toHaveBeenCalled();
    expect(clients.installer.prisma.$transaction).toHaveBeenCalledOnce();
    const lockQuery = clients.installer.connection.$queryRaw.mock
      .calls[1]?.[0] as {
      values?: readonly unknown[];
    };
    expect(lockQuery.values).toContain(1129271120);
  });

  it("fails closed when a target-typed callback tries a different replica connection", async () => {
    const { clients, events } = fixture();
    const protectedRoutine = vi.fn();

    await expect(
      executeAtomicReleaseControlMutation(
        clients as never,
        "control",
        {} as never,
        () =>
          executeSameConnectionFenced(
            clients.provider.prisma as never,
            clients.provider.expected,
            protectedRoutine,
            timing,
          ),
        timing,
        () => new Error("unavailable"),
      ),
    ).rejects.toThrow("release_authority_atomic_mutation_target_mismatch");
    expect(protectedRoutine).not.toHaveBeenCalled();
    expect(events).toContain("rollback:reviewrouter_release_control");
  });

  it("never invokes the callback after stale evidence", async () => {
    const { clients, events } = fixture();
    mutationDatabaseIsReady.mockReturnValue(false);
    const protectedRoutine = vi.fn();
    const mutation = vi.fn(() =>
      executeSameConnectionFenced(
        clients.control.prisma as never,
        clients.control.expected,
        protectedRoutine,
        timing,
      ),
    );

    await expect(
      executeAtomicReleaseControlMutation(
        clients as never,
        "control",
        {} as never,
        mutation,
        timing,
        () => Object.assign(new Error("unavailable"), { statusCode: 503 }),
      ),
    ).rejects.toMatchObject({ message: "unavailable", statusCode: 503 });
    expect(mutation).not.toHaveBeenCalled();
    expect(protectedRoutine).not.toHaveBeenCalled();
    expect(
      events.filter((event) => event.startsWith("rollback:")),
    ).toHaveLength(1);
  });

  it("preserves the exact role and database identity fence inside the atomic probe", async () => {
    const { clients } = fixture();
    clients.control.connection.observation = {
      ...clients.control.connection.observation,
      roleName: "reviewrouter_provider_authority",
    };
    const protectedRoutine = vi.fn();

    await expect(
      executeAtomicReleaseControlMutation(
        clients as never,
        "control",
        {} as never,
        () =>
          executeSameConnectionFenced(
            clients.control.prisma as never,
            clients.control.expected,
            protectedRoutine,
            timing,
          ),
        timing,
        () => new Error("unavailable"),
      ),
    ).rejects.toThrow("unavailable");
    expect(protectedRoutine).not.toHaveBeenCalled();
  });

  it("fails closed on lock timeout and rolls every open transaction back", async () => {
    const { clients, events } = fixture();
    clients.control.connection.$queryRaw.mockImplementationOnce(
      async () => [{ configured: true }] as never,
    );
    clients.control.connection.$queryRaw.mockRejectedValueOnce(
      new Error("canceling statement due to lock timeout"),
    );
    const protectedRoutine = vi.fn();
    const mutation = vi.fn(() =>
      executeSameConnectionFenced(
        clients.control.prisma as never,
        clients.control.expected,
        protectedRoutine,
        timing,
      ),
    );

    await expect(
      executeAtomicReleaseControlMutation(
        clients as never,
        "control",
        {} as never,
        mutation,
        timing,
        () => new Error("unavailable"),
      ),
    ).rejects.toThrow("unavailable");
    expect(protectedRoutine).not.toHaveBeenCalled();
    expect(events).toContain("rollback:reviewrouter_release_control");
  });

  it("rolls the attested transaction back when the mutation fails", async () => {
    const { clients, events } = fixture();

    await expect(
      executeAtomicReleaseControlMutation(
        clients as never,
        "control",
        {} as never,
        () =>
          executeSameConnectionFenced(
            clients.control.prisma as never,
            clients.control.expected,
            async () => {
              throw new Error("mutation_failed");
            },
            timing,
          ),
        timing,
        () => new Error("unavailable"),
      ),
    ).rejects.toThrow("mutation_failed");
    expect(
      events.filter((event) => event.startsWith("rollback:")),
    ).toHaveLength(1);
  });
});
