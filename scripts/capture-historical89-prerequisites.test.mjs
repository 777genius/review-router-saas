import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { captureHistorical89PrerequisitesCommand } from "./capture-historical89-prerequisites.mjs";
import { readRenderHistorical96CheckoutInventory } from "./lib/render-historical96-checkout.mjs";

// Run: node --import tsx --test scripts/capture-historical89-prerequisites.test.mjs

const expected = {
  databaseName: "disposable",
  databaseOid: "16384",
  systemIdentifier: "7531234567890123456",
  sessionUser: "fixture",
  currentRole: "fixture",
};
const source = {
  commit: "b4f85b9225ffdf94c56299b855d8636a78d07d3a",
  label: "disposable-harness",
};
const secret = "postgresql://fixture:secret-canary@invalid/disposable";
const setup = [
  "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
  "SET LOCAL statement_timeout = '4s'",
  "SET LOCAL lock_timeout = '1s'",
  "SET LOCAL idle_in_transaction_session_timeout = '5s'",
  "SET LOCAL jit = off",
  "SET LOCAL search_path = pg_catalog, public",
];

function projections() {
  return [
    {
      ...expected,
      readOnly: "on",
      isolation: "repeatable read",
      backendPid: 123,
      backendStart: "2026-09-09T00:00:00Z",
    },
    { systemIdentifier: expected.systemIdentifier },
    {
      superuser: false,
      createRole: false,
      signalBackend: false,
      schemaOwnerRoleExists: false,
      signalTargets: [],
    },
    { gateStatus: "closed", authzEpoch: "1", revision: "2" },
    readRenderHistorical96CheckoutInventory()
      .slice(0, 89)
      .map((row, i) => ({
        ...row,
        id: `00000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`,
        startedAt: "2026-08-01T00:00:00.000001Z",
        finishedAt: "2026-08-01T00:00:01.000001Z",
        rolledBackAt: null,
        appliedStepsCount: 1,
        logsPresent: false,
        hasLogs: false,
        logsDigest: null,
      })),
    {
      version: 1,
      facts: [
        {
          family: "authority",
          fact: { roles: [], unsupportedAuthorityFamilies: [] },
        },
      ],
    },
    [],
    { version: 1, rows: [] },
    { version: 1, rows: [] },
    {
      version: 1,
      database: expected.databaseName,
      allowConnections: true,
      connectionLimit: -1,
      owner: "reviewrouter",
      raw: null,
      entries: [
        {
          grantee: "PUBLIC",
          granteeOid: "0",
          grantor: "reviewrouter",
          grantorOid: "10",
          privilege: "CONNECT",
          grantable: false,
        },
      ],
      connectCapableRoles: [],
      backends: [],
    },
  ];
}

async function harness(t, failure) {
  const directory = await mkdtemp(join(tmpdir(), "historical89-cli-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const request = join(directory, "request.json");
  const output = join(directory, "evidence.json");
  await writeFile(request, JSON.stringify({ expected, source }), {
    mode: 0o600,
  });
  const values = projections();
  const queries = [];
  let closed = 0;
  let index = 0;
  let onError;
  const client = {
    on(event, handler) {
      assert.equal(event, "error");
      onError = handler;
    },
    async connect() {
      if (failure === "connect") throw new Error(secret);
    },
    async end() {
      closed++;
      if (failure === "idle-error") onError(new Error(secret));
      if (failure === "end") throw new Error(secret);
    },
    async query({ text, query_timeout }) {
      queries.push(text);
      assert.equal(
        query_timeout,
        text.startsWith("WITH capture") && index === 5 ? 16000 : 5000,
      );
      if (text === "ROLLBACK") {
        if (failure === "rollback") throw new Error(secret);
        return { command: "ROLLBACK", rows: [] };
      }
      if (
        setup.includes(text) ||
        text === "SET LOCAL statement_timeout = '15s'"
      )
        return { rows: [] };
      assert.match(
        text,
        /^WITH capture\(value\) AS MATERIALIZED \((?:SELECT|WITH) /,
      );
      assert.match(text, /FROM capture LIMIT 2$/);
      // Ignore SQL literals/quoted identifiers and comments when checking verbs.
      const sql = text.replace(
        /'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*|\/\*[\s\S]*?\*\//g,
        " ",
      );
      assert.doesNotMatch(
        sql,
        /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|CALL|DO|COMMIT|COPY)\b/i,
      );
      if (failure === "query" && index === 4) throw new Error(secret);
      if (failure === "catalog-timeout" && index === 5)
        throw Object.assign(new Error(secret), { code: "57014" });
      const value = globalThis.structuredClone(values[index++]);
      if (failure === "identity" && index === 1) value.databaseOid = "99999";
      if (failure === "missing" && index === 6) return { rows: [] };
      return { rows: [{ value, exceeded: failure === "cap" && index === 6 }] };
    },
  };
  return {
    directory,
    output,
    queries,
    values,
    closed: () => closed,
    run: () =>
      captureHistorical89PrerequisitesCommand({
        argv: ["--request", request, "--output", output],
        env: { REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL: secret },
        makeClient: async (url) => {
          assert.equal(url, secret);
          return client;
        },
      }),
  };
}

test("real capture library publishes complete private evidence after closing; only reads dispatched", async (t) => {
  const h = await harness(t);
  try {
    await h.run();
  } catch (error) {
    assert.fail(
      `${error.message}; dispatched: ${h.queries.map((sql) => sql.slice(0, 100)).join("\n")}`,
    );
  }
  assert.equal(h.closed(), 1);
  assert.deepEqual(h.queries.slice(0, setup.length), setup);
  assert.equal(h.queries.at(-1), "ROLLBACK");
  assert.equal(h.queries.length, 19);
  const serialized = await readFile(h.output, "utf8");
  const evidence = JSON.parse(serialized);
  assert.equal(evidence.collectionComplete, true);
  assert.equal(evidence.rollbackConfirmed, true);
  assert.equal(evidence.authorizesProductionMutation, false);
  assert.deepEqual(evidence.observations.ledger, h.values[4]);
  assert.deepEqual(evidence.observations.connectAcl, h.values[9]);
  assert.ok(
    evidence.unresolvedCapabilities.includes("independent-admission-review"),
  );
  assert.ok(!serialized.includes(secret));
  assert.equal((await stat(h.output)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(h.directory)).sort(), [
    "evidence.json",
    "request.json",
  ]);
});

for (const failure of [
  "connect",
  "query",
  "catalog-timeout",
  "identity",
  "missing",
  "cap",
  "rollback",
  "end",
  "idle-error",
]) {
  test(`${failure}: connection closed, partial evidence never published, errors sanitized`, async (t) => {
    const h = await harness(t, failure);
    await assert.rejects(h.run(), {
      message: "historical89_prerequisites:failed",
    });
    assert.equal(h.closed(), 1);
    assert.deepEqual(await readdir(h.directory), ["request.json"]);
    if (failure !== "connect") assert.equal(h.queries.at(-1), "ROLLBACK");
  });
}

test("publication failure preserves existing output and removes staging files", async (t) => {
  const h = await harness(t);
  await writeFile(h.output, "existing-evidence");
  await assert.rejects(h.run(), {
    message: "historical89_prerequisites:failed",
  });
  assert.equal(h.closed(), 1);
  assert.equal(await readFile(h.output, "utf8"), "existing-evidence");
  assert.deepEqual((await readdir(h.directory)).sort(), [
    "evidence.json",
    "request.json",
  ]);
});

test("catalog timeout preserves previously published evidence", async (t) => {
  const h = await harness(t, "catalog-timeout");
  await writeFile(h.output, "prior-evidence");
  await assert.rejects(h.run(), {
    message: "historical89_prerequisites:failed",
  });
  assert.equal(h.closed(), 1);
  assert.equal(h.queries.at(-1), "ROLLBACK");
  assert.equal(await readFile(h.output, "utf8"), "prior-evidence");
  assert.deepEqual((await readdir(h.directory)).sort(), [
    "evidence.json",
    "request.json",
  ]);
});

test("CLI rejects credentials in argv without printing them or loading pg", () => {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/capture-historical89-prerequisites.mjs",
      "--database-url",
      secret,
    ],
    { env: {}, encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "historical89_prerequisites:failed\n");
});
