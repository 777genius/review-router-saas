import { Prisma } from "@prisma/client";
import { AsyncLocalStorage } from "node:async_hooks";
import type { PrismaClient } from "@reviewrouter/platform-db";
import {
  releaseControlMutationDatabaseIsReady,
  type ReleaseAuthorityDatabaseReadiness,
  type TrustedReleaseControlDatabaseIdentity,
} from "../application/readiness.js";
import type { RuntimeDatabaseIdentity } from "../domain/database-identity.js";
import type { ReleaseAuthorityMutationTarget } from "../application/services.js";
import type { ReleaseAuthorityFencedAttestation } from "../application/services.js";
import { observeReleaseAuthorityDatabaseReadinessOnConnection } from "./postgres-readiness.js";
import { observeReleaseAuthorityDatabaseReadiness } from "./postgres-readiness.js";

export type SameConnectionIdentityExpectation = Readonly<{
  roleName: string;
  databaseIdentity: RuntimeDatabaseIdentity;
  postgresMajor: 17;
}>;

export type SameConnectionTransactionTiming = Readonly<{
  maxWaitMilliseconds: number;
  transactionTimeoutMilliseconds: number;
}>;

export type AtomicMutationTiming = SameConnectionTransactionTiming &
  Readonly<{
    lockTimeoutMilliseconds: number;
    statementTimeoutMilliseconds: number;
  }>;

export type AtomicReleaseControlConnections = Readonly<{
  control: Readonly<{
    prisma: PrismaClient;
    expected: SameConnectionIdentityExpectation;
  }>;
  provider: Readonly<{
    prisma: PrismaClient;
    expected: SameConnectionIdentityExpectation;
  }>;
  installer: Readonly<{
    prisma: PrismaClient;
    expected: SameConnectionIdentityExpectation;
  }>;
  reader: Readonly<{
    prisma: PrismaClient;
    expected: SameConnectionIdentityExpectation;
  }>;
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

type ActiveAtomicConnection = Readonly<{
  connection: Prisma.TransactionClient;
  expected: SameConnectionIdentityExpectation;
}>;

const atomicConnections = new AsyncLocalStorage<
  ReadonlyMap<PrismaClient, ActiveAtomicConnection>
>();

type ReadinessObservationOptions = Parameters<
  typeof observeReleaseAuthorityDatabaseReadiness
>[1];

const sameExpectedIdentity = (
  left: SameConnectionIdentityExpectation,
  right: SameConnectionIdentityExpectation,
): boolean =>
  left.roleName === right.roleName &&
  left.postgresMajor === right.postgresMajor &&
  left.databaseIdentity.serverIdentity ===
    right.databaseIdentity.serverIdentity &&
  left.databaseIdentity.databaseIdentity ===
    right.databaseIdentity.databaseIdentity &&
  left.databaseIdentity.databaseName === right.databaseIdentity.databaseName;

/**
 * Observes readiness on an already-attested atomic connection when this
 * async sequence owns one for the exact Prisma client and expected identity.
 * Other clients retain the normal bounded pooled observer. The two observer
 * overrides are intentionally independent: pooled overrides never receive a
 * transaction client, and active-connection overrides never open a pool slot.
 */
export async function observeAtomicConnectionAwareReadiness(
  prisma: PrismaClient,
  expected: SameConnectionIdentityExpectation,
  options: ReadinessObservationOptions = {},
  pooledObserver: typeof observeReleaseAuthorityDatabaseReadiness = observeReleaseAuthorityDatabaseReadiness,
  activeObserver: typeof observeReleaseAuthorityDatabaseReadinessOnConnection = observeReleaseAuthorityDatabaseReadinessOnConnection,
): Promise<ReleaseAuthorityDatabaseReadiness> {
  options.signal?.throwIfAborted();
  const active = atomicConnections.getStore()?.get(prisma);
  if (!active) return pooledObserver(prisma, options);
  if (!sameExpectedIdentity(active.expected, expected))
    throw new Error("release_authority_same_connection_identity_mismatch");
  const readiness = await activeObserver(active.connection, options.signal);
  options.signal?.throwIfAborted();
  return readiness;
}

const authorityMigrationLock = [1381126735, 1381258071] as const;
const activationMigrationLock = [1381126735, 1129271120] as const;

const identityMatches = (
  actual: FenceRow | undefined,
  expected: SameConnectionIdentityExpectation,
): boolean =>
  Boolean(
    actual &&
    actual.roleName === expected.roleName &&
    actual.serverIdentity === expected.databaseIdentity.serverIdentity &&
    actual.databaseIdentity === expected.databaseIdentity.databaseIdentity &&
    actual.databaseName === expected.databaseIdentity.databaseName &&
    actual.postgresMajor === expected.postgresMajor,
  );

const assertTiming = (timing: SameConnectionTransactionTiming): void => {
  if (
    !Number.isSafeInteger(timing.maxWaitMilliseconds) ||
    timing.maxWaitMilliseconds < 1 ||
    !Number.isSafeInteger(timing.transactionTimeoutMilliseconds) ||
    timing.transactionTimeoutMilliseconds < 1
  )
    throw new Error("release_authority_same_connection_timing_invalid");
};

const identityRows = (connection: Prisma.TransactionClient) =>
  connection.$queryRaw<FenceRow[]>(Prisma.sql`
    SELECT current_user AS "roleName",
      (SELECT system_identifier::text FROM pg_control_system()) AS "serverIdentity",
      (SELECT oid::text FROM pg_database WHERE datname=current_database())
        AS "databaseIdentity",
      current_database() AS "databaseName",
      current_setting('server_version_num')::integer / 10000 AS "postgresMajor"
  `);

/**
 * Executes the runtime-identity fence and routine on one transaction
 * connection. Inside a high-risk application boundary it additionally takes
 * the migration exclusion lock and proves the complete connection-local
 * catalog policy before invoking the routine.
 */
export async function executeSameConnectionFenced<T>(
  prisma: PrismaClient,
  expected: SameConnectionIdentityExpectation,
  routine: (connection: Prisma.TransactionClient) => Promise<T>,
  timing: SameConnectionTransactionTiming = defaultTransactionTiming,
): Promise<T> {
  assertTiming(timing);
  const atomic = atomicConnections.getStore();
  const active = atomic?.get(prisma);
  if (atomic && !active)
    throw new Error("release_authority_atomic_mutation_target_mismatch");
  if (active) {
    if (!sameExpectedIdentity(active.expected, expected))
      throw new Error("release_authority_same_connection_identity_mismatch");
    return routine(active.connection);
  }
  return prisma.$transaction(
    async (connection) => {
      const rows = await identityRows(connection);
      const actual = rows[0];
      if (rows.length !== 1 || !identityMatches(actual, expected))
        throw new Error("release_authority_same_connection_identity_mismatch");
      return routine(connection);
    },
    {
      maxWait: timing.maxWaitMilliseconds,
      timeout: timing.transactionTimeoutMilliseconds,
    },
  );
}

/**
 * Executes one target-typed application callback inside the selected
 * adapter's transaction after its migration lock and exact catalog evidence
 * have been acquired on that same connection.
 */
export async function executeAtomicReleaseControlMutation<T>(
  clients: AtomicReleaseControlConnections,
  target: ReleaseAuthorityMutationTarget,
  trusted: TrustedReleaseControlDatabaseIdentity,
  mutation: (attestation: ReleaseAuthorityFencedAttestation) => Promise<T> | T,
  timing: AtomicMutationTiming,
  unavailableError: () => Error,
  observe: (
    connection: Prisma.TransactionClient,
  ) => Promise<ReleaseAuthorityDatabaseReadiness> = observeReleaseAuthorityDatabaseReadinessOnConnection,
): Promise<T> {
  assertTiming(timing);
  if (
    !Number.isSafeInteger(timing.lockTimeoutMilliseconds) ||
    timing.lockTimeoutMilliseconds < 1 ||
    !Number.isSafeInteger(timing.statementTimeoutMilliseconds) ||
    timing.statementTimeoutMilliseconds < timing.lockTimeoutMilliseconds ||
    timing.statementTimeoutMilliseconds >= timing.transactionTimeoutMilliseconds
  )
    throw new Error("release_authority_atomic_mutation_timing_invalid");

  const selected = clients[target];
  const lock =
    target === "control" || target === "provider"
      ? authorityMigrationLock
      : activationMigrationLock;
  let mutationStarted = false;
  try {
    return await selected.prisma.$transaction(
      async (connection) => {
        await connection.$queryRaw(Prisma.sql`
          SELECT
            set_config('statement_timeout', ${`${timing.statementTimeoutMilliseconds}ms`}, true),
            set_config('lock_timeout', ${`${timing.lockTimeoutMilliseconds}ms`}, true)
        `);
        await connection.$queryRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock_shared(
            ${lock[0]}, ${lock[1]}
          ) IS NULL AS "locked"
        `);
        const readiness = await observe(connection);
        if (
          readiness.roleName !== selected.expected.roleName ||
          readiness.databaseIdentity.serverIdentity !==
            selected.expected.databaseIdentity.serverIdentity ||
          readiness.databaseIdentity.databaseIdentity !==
            selected.expected.databaseIdentity.databaseIdentity ||
          readiness.databaseIdentity.databaseName !==
            selected.expected.databaseIdentity.databaseName ||
          readiness.postgresMajor !== selected.expected.postgresMajor ||
          !releaseControlMutationDatabaseIsReady(readiness, trusted)
        )
          throw new Error("release_authority_atomic_attestation_mismatch");
        mutationStarted = true;
        return atomicConnections.run(
          new Map([
            [selected.prisma, { connection, expected: selected.expected }],
          ]),
          () =>
            mutation({
              systemIdentifier: readiness.systemIdentifier,
              recoveryWitnessSha256: readiness.recoveryWitnessSha256,
            }),
        );
      },
      {
        maxWait: timing.maxWaitMilliseconds,
        timeout: timing.transactionTimeoutMilliseconds,
      },
    );
  } catch (error) {
    if (mutationStarted) throw error;
    throw unavailableError();
  }
}
