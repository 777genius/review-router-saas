#!/usr/bin/env node
// From the checkout root:
// node --import tsx scripts/capture-historical89-prerequisites.mjs --request /secure/request.json --output /secure/evidence.json
// Credentials: REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL only (preloaded env).
// Request: {expected:{databaseName,databaseOid,systemIdentifier,sessionUser,currentRole},
// source:{commit,label}}. All values are strings; use independently known identity
// pins, the checkout's full commit SHA, and a non-secret provenance label.
// A successful capture supplies observations, not migration authorization or E2E.
import { link, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const fail = () => new Error("historical89_prerequisites:failed");

async function createClient(connectionString) {
  const { default: pg } = await import("pg");
  return new pg.Client({ connectionString, connectionTimeoutMillis: 5_000 });
}

// Injection is for a disposable test harness; the CLI has no adapter override.
export async function captureHistorical89PrerequisitesCommand({
  argv = process.argv.slice(2),
  env = process.env,
  makeClient = createClient,
} = {}) {
  try {
    if (
      argv.length !== 4 ||
      argv[0] !== "--request" ||
      argv[2] !== "--output" ||
      !argv[1] ||
      !argv[3] ||
      !env.REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL
    )
      throw fail();
    const request = JSON.parse(await readFile(argv[1], "utf8"));
    const output = resolve(argv[3]);
    const { captureHistorical89Prerequisites } =
      await import("./lib/render-historical89-prerequisite-capture.mjs");
    // A dedicated newly connected client is IDLE and never shared or pooled.
    const client = await makeClient(
      env.REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL,
    );
    let result;
    let connectionFailed = false;
    try {
      // pg emits idle connection errors outside query promises. Never print them.
      client.on("error", () => {
        connectionFailed = true;
      });
      await client.connect();
      result = await captureHistorical89Prerequisites({
        client,
        expected: request.expected,
        source: request.source,
        idleClient: true,
      });
    } finally {
      // Includes connect failure and unconfirmed rollback. Close before publishing.
      await client.end();
    }
    if (
      connectionFailed ||
      result.collectionComplete !== true ||
      result.rollbackConfirmed !== true ||
      result.authorizesProductionMutation !== false
    )
      throw fail();

    // Same filesystem, private staging directory (0700), file 0600. Publish by
    // atomic no-clobber link only after the full JSON is written, synced, closed.
    // Existing evidence, including symlinks, is never replaced.
    const staging = await mkdtemp(
      join(dirname(output), ".historical89-capture-"),
    );
    try {
      const temporary = join(staging, "evidence.json");
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(result, null, 2)}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await link(temporary, output);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  } catch {
    // Never expose pg errors, credentials, request values, or filesystem paths.
    throw fail();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await captureHistorical89PrerequisitesCommand();
    process.stdout.write(
      "historical89_prerequisites:captured-observations-only\n",
    );
  } catch {
    process.stderr.write("historical89_prerequisites:failed\n");
    process.exitCode = 1;
  }
}
