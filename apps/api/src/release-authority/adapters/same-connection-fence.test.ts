import { describe, expect, it, vi } from "vitest";
import { executeSameConnectionFenced } from "./same-connection-fence";

const expected = {
  roleName: "reviewrouter_release_control",
  databaseIdentity: {
    serverIdentity: "1",
    databaseIdentity: "2",
    databaseName: "authority",
  },
  postgresMajor: 17 as const,
};
const row = {
  roleName: expected.roleName,
  serverIdentity: "1",
  databaseIdentity: "2",
  databaseName: "authority",
  postgresMajor: 17,
};

describe("same-connection identity fence", () => {
  it("runs the fence and routine on the transaction connection", async () => {
    const connection = { $queryRaw: vi.fn().mockResolvedValue([row]) };
    const prisma = {
      $transaction: vi.fn((operation, options) =>
        operation(connection).then((value: unknown) => ({ value, options })),
      ),
    };
    const routine = vi.fn(async (actual) => {
      expect(actual).toBe(connection);
      return "ok";
    });
    await expect(
      executeSameConnectionFenced(prisma as never, expected, routine, {
        maxWaitMilliseconds: 123,
        transactionTimeoutMilliseconds: 456,
      }),
    ).resolves.toMatchObject({
      value: "ok",
      options: { maxWait: 123, timeout: 456 },
    });
    expect(connection.$queryRaw).toHaveBeenCalledOnce();
    const identityQuery = connection.$queryRaw.mock.calls[0]?.[0] as {
      strings?: readonly string[];
    };
    expect(identityQuery.strings?.join(" ")).toContain("current_user");
    expect(identityQuery.strings?.join(" ")).not.toContain("WITH facts AS");
    expect(routine).toHaveBeenCalledOnce();
  });

  it("rejects invalid configured transaction bounds before opening a connection", async () => {
    const prisma = { $transaction: vi.fn() };
    await expect(
      executeSameConnectionFenced(prisma as never, expected, vi.fn(), {
        maxWaitMilliseconds: 0,
        transactionTimeoutMilliseconds: 20,
      }),
    ).rejects.toThrow("release_authority_same_connection_timing_invalid");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    { roleName: "reviewrouter_release_witness" },
    { serverIdentity: "9" },
    { databaseIdentity: "9" },
    { databaseName: "rerouted" },
    { postgresMajor: 16 },
  ])("rejects a reroute or role mismatch: %o", async (change) => {
    const connection = {
      $queryRaw: vi.fn().mockResolvedValue([{ ...row, ...change }]),
    };
    const prisma = {
      $transaction: vi.fn((operation) => operation(connection)),
    };
    const routine = vi.fn();
    await expect(
      executeSameConnectionFenced(prisma as never, expected, routine),
    ).rejects.toThrow("release_authority_same_connection_identity_mismatch");
    expect(routine).not.toHaveBeenCalled();
  });
});
