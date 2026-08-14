import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@reviewrouter/platform-db";
import type { RuntimeDatabaseIdentity } from "../domain/database-identity.js";

export type SameConnectionIdentityExpectation = Readonly<{
  roleName: string;
  databaseIdentity: RuntimeDatabaseIdentity;
  postgresMajor: 17;
}>;

export type SameConnectionTransactionTiming = Readonly<{
  maxWaitMilliseconds: number;
  transactionTimeoutMilliseconds: number;
}>;

const defaultTransactionTiming: SameConnectionTransactionTiming = {
  maxWaitMilliseconds: 2_000,
  transactionTimeoutMilliseconds: 17_000,
};

type FenceRow = Readonly<{
  roleName: string;
  serverIdentity: string;
  databaseIdentity: string;
  databaseName: string;
  postgresMajor: number;
}>;

/** Executes the cheap identity fence and protected routine on one transaction connection. */
export async function executeSameConnectionFenced<T>(
  prisma: PrismaClient,
  expected: SameConnectionIdentityExpectation,
  routine: (connection: Prisma.TransactionClient) => Promise<T>,
  timing: SameConnectionTransactionTiming = defaultTransactionTiming,
): Promise<T> {
  if (
    !Number.isSafeInteger(timing.maxWaitMilliseconds) ||
    timing.maxWaitMilliseconds < 1 ||
    !Number.isSafeInteger(timing.transactionTimeoutMilliseconds) ||
    timing.transactionTimeoutMilliseconds < 1
  )
    throw new Error("release_authority_same_connection_timing_invalid");
  return prisma.$transaction(
    async (connection) => {
      const rows = await connection.$queryRaw<FenceRow[]>(Prisma.sql`
        SELECT current_user AS "roleName",
          (SELECT system_identifier::text FROM pg_control_system()) AS "serverIdentity",
          (SELECT oid::text FROM pg_database WHERE datname=current_database())
            AS "databaseIdentity",
          current_database() AS "databaseName",
          current_setting('server_version_num')::integer / 10000 AS "postgresMajor"
      `);
      const actual = rows[0];
      if (
        rows.length !== 1 ||
        !actual ||
        actual.roleName !== expected.roleName ||
        actual.serverIdentity !== expected.databaseIdentity.serverIdentity ||
        actual.databaseIdentity !==
          expected.databaseIdentity.databaseIdentity ||
        actual.databaseName !== expected.databaseIdentity.databaseName ||
        actual.postgresMajor !== 17
      )
        throw new Error("release_authority_same_connection_identity_mismatch");
      return routine(connection);
    },
    {
      maxWait: timing.maxWaitMilliseconds,
      timeout: timing.transactionTimeoutMilliseconds,
    },
  );
}
