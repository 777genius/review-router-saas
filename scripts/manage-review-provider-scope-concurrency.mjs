#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import pg from "pg";

const routineByOperation = Object.freeze({
  status: "reviewrouter_provider_scope_concurrency_status",
  activate: "reviewrouter_provider_scope_concurrency_activate",
  close: "reviewrouter_provider_scope_concurrency_close_for_rollback",
  verifyRollback: "reviewrouter_provider_scope_concurrency_verify_rollback",
});

const ambiguousConnectionCodes = new Set([
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
  "57P01",
  "57P02",
  "57P03",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
]);

/**
 * Execute one bounded operator transition.  A connection failure after the
 * server may have committed is reconciled by reading the desired state with a
 * new connection and, when still needed, safely retrying the idempotent
 * routine.  createClient is injectable so the real PG harness can discard a
 * committed response at the client boundary.
 */
export async function runProviderScopeConcurrencyOperation({
  operation,
  databaseUrl,
  createClient = () => new pg.Client({ connectionString: databaseUrl }),
  maxAttempts = 3,
}) {
  if (!Object.hasOwn(routineByOperation, operation)) {
    throw new Error("provider_scope_concurrency_operation_invalid");
  }
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 5
  ) {
    throw new Error("provider_scope_concurrency_attempt_limit_invalid");
  }

  let ambiguousFailure;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return {
        status: await callRestrictedRoutine(
          routineByOperation[operation],
          createClient,
        ),
        reconciledAfterAmbiguousCommit: false,
      };
    } catch (error) {
      if (!isAmbiguousConnectionFailure(error)) throw error;
      ambiguousFailure = error;
    }

    if (operation !== "status") {
      try {
        const status = await callRestrictedRoutine(
          routineByOperation.status,
          createClient,
        );
        if (isDesiredState(operation, status)) {
          return { status, reconciledAfterAmbiguousCommit: true };
        }
      } catch (error) {
        if (!isAmbiguousConnectionFailure(error)) throw error;
        ambiguousFailure = error;
      }
    }
  }
  throw ambiguousFailure;
}

async function callRestrictedRoutine(routineName, createClient) {
  const client = createClient();
  await client.connect();
  try {
    const result = await client.query(
      `SELECT public.${routineName}() AS status`,
    );
    if (result.rows.length !== 1 || result.rows[0]?.status === undefined) {
      throw new Error("provider_scope_concurrency_routine_response_invalid");
    }
    return result.rows[0].status;
  } finally {
    await client.end().catch(() => undefined);
  }
}

function isDesiredState(operation, status) {
  if (!status || typeof status !== "object") return false;
  if (operation === "activate") {
    return status.activated === true && status.legacyProviderVoteIndex === null;
  }
  if (operation === "close") return status.activated === false;
  return (
    operation === "verifyRollback" &&
    status.activated === false &&
    status.duplicateActiveVoteLanes === 0 &&
    status.legacyProviderVoteIndex?.exact === true
  );
}

function isAmbiguousConnectionFailure(error) {
  if (!error || typeof error !== "object") return false;
  if (ambiguousConnectionCodes.has(error.code)) return true;
  return /connection|socket|server closed|terminating connection/iu.test(
    error.message ?? "",
  );
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const args = new Set(argv);
  const selected = [
    ["--status", "status"],
    ["--activate", "activate"],
    ["--close-for-rollback", "close"],
    ["--verify-rollback-ready", "verifyRollback"],
  ].filter(([flag]) => args.has(flag));
  if (selected.length !== 1) {
    throw new Error(
      "Choose exactly one of --status, --activate, --close-for-rollback, or --verify-rollback-ready",
    );
  }
  const operation = selected[0][1];
  if (operation === "activate" && !args.has("--confirm-old-replicas-drained")) {
    throw new Error("Activation requires --confirm-old-replicas-drained");
  }
  if (operation === "close" && !args.has("--confirm-no-old-replica-started")) {
    throw new Error("Closing requires --confirm-no-old-replica-started");
  }

  const result = await runProviderScopeConcurrencyOperation({
    operation,
    databaseUrl: env.DATABASE_URL,
  });
  if (operation === "status") {
    console.log(JSON.stringify(result.status));
  } else if (operation === "activate") {
    console.log("Scoped provider concurrency activated after old-fleet drain.");
  } else if (operation === "close") {
    console.log(
      "Scoped provider concurrency is closed. Drain duplicate active vote lanes and run --verify-rollback-ready before starting any old replica.",
    );
    console.log(JSON.stringify(result.status));
  } else {
    console.log(
      "Rollback fence is closed and old-binary global reads are safe.",
    );
  }
  if (result.reconciledAfterAmbiguousCommit) {
    console.log("Committed operation reconciled after response loss.");
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(
      `ERROR: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
