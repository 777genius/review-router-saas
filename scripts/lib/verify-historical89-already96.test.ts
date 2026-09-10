import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  readRenderManagedCheckoutInventory,
  renderManagedEvidenceDigest,
} from "./render-schema-handoff-policy.mjs";
import {
  readHistorical89PendingIdentities,
  renderHistorical89AdmissionPhase as phase,
  renderHistorical89PendingDigest,
} from "./render-historical89-admission.mjs";

const inventory = readRenderManagedCheckoutInventory();
const ledger = (count: number) =>
  inventory.slice(0, count).map((r, i) => ({
    migrationName: r.migrationName,
    checksum: r.checksum,
    id: `00000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`,
    startedAt: "2026-08-01T00:00:00.000001Z",
    finishedAt: "2026-08-01T00:00:01.000001Z",
    rolledBackAt: null,
    appliedStepsCount: 1,
    logsPresent: false,
    hasLogs: false,
    logsDigest: null,
  }));
const originalMembership = {
  role: "reviewrouter_release_schema_owner",
  member: "reviewrouter",
  grantor: "postgres",
  adminOption: true,
  inheritOption: false,
  setOption: false,
};
const baselineCatalog = {
  version: 1,
  serverVersionNum: 170010,
  database: "review_router_dimy",
  sessionUser: "reviewrouter",
  currentUser: "reviewrouter",
  facts: [
    {
      family: "authority",
      fact: {
        roles: [
          {
            name: "reviewrouter_release_schema_owner",
            canLogin: false,
            superuser: false,
            bypassRls: false,
            replication: false,
            createDatabase: false,
            createRole: false,
          },
          {
            name: "reviewrouter_release_migration",
            canLogin: true,
            superuser: false,
            bypassRls: false,
            replication: false,
            createDatabase: false,
            createRole: false,
          },
        ],
      },
    },
  ],
};
// The four reviewed provider rows, in the exact shape the 1A projection emits.
const providerRow = (
  oid: string,
  objectType: string,
  grantees: string[],
  privileges: string[],
) => ({
  oid,
  ownerOid: "10",
  owner: "postgres",
  namespaceOid: "0",
  schema: "*",
  objectType,
  raw: `{postgres=X/postgres}`,
  entries: grantees.flatMap((grantee) =>
    privileges.map((privilege) => ({
      grantee,
      granteeOid:
        grantee === "PUBLIC" ? "0" : grantee === "postgres" ? "10" : "20",
      grantor: "postgres",
      grantorOid: "10",
      privilege,
      grantable: false,
    })),
  ),
});
const defaultAcl = () => ({
  version: 1,
  rows: [
    providerRow(
      "101",
      "S",
      ["postgres", "reviewrouter"],
      ["SELECT", "UPDATE", "USAGE"],
    ),
    providerRow("102", "T", ["PUBLIC", "postgres", "reviewrouter"], ["USAGE"]),
    providerRow(
      "103",
      "f",
      ["PUBLIC", "postgres", "reviewrouter"],
      ["EXECUTE"],
    ),
    providerRow(
      "104",
      "r",
      ["postgres", "reviewrouter"],
      [
        "INSERT",
        "SELECT",
        "UPDATE",
        "DELETE",
        "TRUNCATE",
        "REFERENCES",
        "TRIGGER",
        "MAINTAIN",
      ],
    ),
  ],
});
const creatorEvidence = () => ({
  sessionUser: "reviewrouter",
  currentUser: "reviewrouter",
  creatingRoles: ["reviewrouter"],
  roleSettings: [],
  securityDefiners: [
    {
      identity: "public.codex_oauth_secret_namespace_tombstone_guard()",
      effectiveRole: "reviewrouter",
      createsObjects: false,
    },
  ],
  dynamicDdl: [
    {
      identity: "000089 canonical owner transfer",
      effectiveRole: "reviewrouter",
      createsObjects: false,
    },
  ],
  triggerCreators: [],
});
const gate = { gateStatus: "closed", authzEpoch: "3", revision: "7" };
const digest = (n: number) => `sha256:${String(n).padStart(2, "0").repeat(32)}`;
const admission = (overrides: Record<string, unknown> = {}) => ({
  providerDatabaseResourceId: "dpg-da32ipmk1f9s73dttm90-a",
  systemIdentifier: "7300000000000000001",
  databaseOid: "16401",
  databaseName: "review_router_dimy",
  recoveryIdentitySha256: digest(1),
  operationId: "12345678-abcd-abcd-abcd-123456789abc",
  providerEffectIds: ["dpg-effect-1"],
  qualifiedAt: "2026-09-07T00:00:00.000Z",
  handoffSourceCommit: phase.handoffSourceCommit,
  cutoverSourceCommit: phase.cutoverSourceCommit,
  sourceTree: "b".repeat(40),
  pendingEntriesSha256: renderHistorical89PendingDigest(
    readHistorical89PendingIdentities(),
  ),
  authorizedBinaryArtifactDigest: digest(2),
  baselineManifest: phase.baselineManifest,
  targetManifest: phase.targetManifest,
  originalLedgerDigest: renderManagedEvidenceDigest(ledger(89)),
  catalogDigest: renderManagedEvidenceDigest(baselineCatalog),
  topologyDigest: digest(3),
  ownershipDigest: digest(4),
  aclDigest: renderManagedEvidenceDigest(defaultAcl()),
  membershipDigest: renderManagedEvidenceDigest([originalMembership]),
  gateStatus: "closed",
  externalFenceSha256: digest(5),
  custodyDigest: renderManagedEvidenceDigest(gate),
  ...overrides,
});
const aclRow = (
  oid: string,
  identity: string,
  owner: string,
  grantees: string[] = [owner],
) => ({
  oid,
  source: "pg_proc",
  identity,
  aclType: "f",
  ownerOid: "20",
  owner,
  raw: `{${owner}=X/${owner}}`,
  effective: grantees.map((grantee) => ({
    grantee,
    granteeOid: grantee === "PUBLIC" ? "0" : "20",
    grantor: owner,
    grantorOid: "20",
    privilege: "EXECUTE",
    grantable: false,
  })),
});
const before = {
  version: 1,
  rows: [
    aclRow("900", 'public."CodexOAuthSecretNamespace"', "reviewrouter"),
    aclRow(
      "901",
      "public.codex_oauth_secret_namespace_tombstone_guard()",
      "reviewrouter",
    ),
    aclRow("902", "public.untouched()", "reviewrouter"),
  ],
};
const after = () => ({
  version: 1,
  rows: [
    aclRow(
      "900",
      'public."CodexOAuthSecretNamespace"',
      "reviewrouter_release_schema_owner",
    ),
    aclRow(
      "901",
      "public.codex_oauth_secret_namespace_tombstone_guard()",
      "reviewrouter_release_schema_owner",
    ),
    aclRow("902", "public.untouched()", "reviewrouter"),
    aclRow(
      "903",
      "public.codex_oauth_workflow_compatibility_guard()",
      "reviewrouter_release_schema_owner",
    ),
  ],
});

import { afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseHistorical89Verification,
  verifyHistorical89Already96,
} from "./verify-historical89-already96.mjs";
import {
  renderManagedLedgerSql,
  renderManagedMembershipSql,
} from "./render-schema-handoff-policy.mjs";
import { renderManagedCatalogSql } from "./render-managed-catalog.mjs";
import { renderHistorical89ObjectAclSql } from "./render-historical89-admission.mjs";

// Synthetic unit evidence only. Real validators run; no production or PG proof.
const document = () => ({
  version: 1,
  admission: admission(),
  coordinates: { epoch: 1, generation: 1, nonce: "0".repeat(32) },
  reviewedTerminalCatalogDigest: renderManagedEvidenceDigest(baselineCatalog),
  originalMembership,
  baselineObjectAcl: before,
  creatorEvidence: creatorEvidence(),
});
const bytesOf = (doc = document()) => Buffer.from(JSON.stringify(doc));
const hashOf = (bytes: Buffer) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const requestOf = () => {
  const bytes = bytesOf();
  return parseHistorical89Verification(
    bytes,
    admission().operationId,
    hashOf(bytes),
  );
};
function fixture() {
  const request = requestOf();
  const permit = {
    ...request.binding,
    kind: phase.kind,
    admissionIdentityDigest: request.identityDigest,
    terminalCatalogDigest: request.reviewedTerminalCatalogDigest,
    epoch: "1",
    generation: "1",
    nonce: request.coordinates.nonce,
    state: "terminal",
  };
  const receipt = {
    kind: phase.kind,
    operationId: request.binding.operationId,
    epoch: "1",
    generation: "1",
    nonce: request.coordinates.nonce,
    ledgerManifest: phase.targetManifest,
    terminalCatalogDigest: request.reviewedTerminalCatalogDigest,
    effectFingerprint: "",
    backendPid: 123,
    transactionId: "456",
    recordedAt: "2026-09-07T00:00:00.000Z",
    permitState: "terminal",
  };
  receipt.effectFingerprint = `sha256:${createHash("sha256")
    .update(
      [
        receipt.kind,
        receipt.operationId,
        request.identityDigest,
        request.binding.systemIdentifier,
        request.binding.databaseOid,
        request.binding.databaseName,
        request.binding.recoveryIdentitySha256,
        request.binding.externalFenceSha256,
        receipt.generation,
        receipt.epoch,
        receipt.nonce,
        receipt.ledgerManifest,
        receipt.terminalCatalogDigest,
      ].join("\n"),
    )
    .digest("hex")}`;
  const state: any = {
    permit,
    receipt,
    ledger: ledger(96),
    catalog: baselineCatalog,
    gate,
    memberships: [originalMembership],
    acl: after(),
    backend: false,
    identity: {
      systemIdentifier: request.binding.systemIdentifier,
      databaseOid: request.binding.databaseOid,
      databaseName: request.binding.databaseName,
    },
    role: {
      session: "reviewrouter_operation_custody_reader",
      current: "reviewrouter_operation_custody_reader",
    },
    fail: "",
    ambiguous: "",
  };
  const queries: string[] = [];
  const makeClient = () => ({
    connectionParameters: {
      host: "unit.invalid",
      port: 5432,
      database: "review_router_dimy",
    },
    connect: async () => {},
    end: async () => {},
    query: async (sql: string) => {
      queries.push(sql);
      if (state.fail && sql.includes(state.fail))
        throw new Error("injected read failure");
      let value: any;
      if (sql === renderManagedLedgerSql) value = state.ledger;
      else if (sql === renderManagedCatalogSql) value = state.catalog;
      else if (sql === renderManagedMembershipSql) value = state.memberships;
      else if (sql === renderHistorical89ObjectAclSql) value = state.acl;
      else if (sql.includes("pg_control_system")) value = state.identity;
      else if (sql.includes("custody_current_permit(")) value = state.permit;
      else if (sql.includes("pg_export_snapshot"))
        value = "00000001-00000002-1";
      else if (sql.includes("'session',session_user")) value = state.role;
      else if (sql.includes("custody_read_effect(")) value = state.receipt;
      else if (sql.includes("pg_stat_activity")) value = state.backend;
      else if (sql.includes("gateStatus")) value = state.gate;
      else return { rows: [] };
      return {
        rows:
          state.ambiguous && sql.includes(state.ambiguous)
            ? [{ value }, { value }]
            : [{ value }],
      };
    },
  });
  return {
    request,
    state,
    queries,
    client: makeClient(),
    reader: makeClient(),
  };
}

describe("already96 verified read-only startup", () => {
  it("accepts authentic bound terminal evidence and current exact96 postconditions", async () => {
    const f = fixture();
    await expect(
      verifyHistorical89Already96(f.client, f.reader, f.request),
    ).resolves.toMatchObject({
      outcome: "already-96",
      receiptDigest: f.state.receipt.effectFingerprint,
      authorizesProductionMutation: false,
    });
    expect(f.queries.filter((q) => q.startsWith("BEGIN"))).toEqual(
      Array(2).fill("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;"),
    );
    expect(f.queries).toContain(
      "SET TRANSACTION SNAPSHOT '00000001-00000002-1';",
    );
    expect(f.queries.filter((q) => q === "ROLLBACK;")).toHaveLength(2);
    expect(
      f.queries
        .filter((q) => !q.startsWith("DO $custody_attestation$"))
        .join("\n"),
    ).not.toMatch(
      /LIMIT 1|custody_open_operation\(|custody_record_effect\(|UPDATE |INSERT |ALTER /,
    );
  });
  it.each([
    ["missing receipt", (s: any) => (s.receipt = null)],
    [
      "unreadable receipt",
      (s: any) =>
        (s.fail =
          "SELECT COALESCE(release_operation_custody.custody_read_effect"),
    ],
    [
      "ambiguous receipt",
      (s: any) =>
        (s.ambiguous =
          "SELECT COALESCE(release_operation_custody.custody_read_effect"),
    ],
    ["missing permit", (s: any) => (s.permit = null)],
    ["open permit", (s: any) => (s.permit.state = "open")],
    ["stale permit", (s: any) => (s.permit.epoch = "2")],
    [
      "wrong permit binding",
      (s: any) => (s.permit.externalFenceSha256 = digest(9)),
    ],
    [
      "unreadable permit",
      (s: any) =>
        (s.fail = "SELECT release_operation_custody.custody_current_permit"),
    ],
    [
      "ambiguous permit",
      (s: any) =>
        (s.ambiguous =
          "SELECT release_operation_custody.custody_current_permit"),
    ],
    [
      "wrong receipt operation",
      (s: any) =>
        (s.receipt.operationId = "22222222-2222-2222-2222-222222222222"),
    ],
    ["stale receipt nonce", (s: any) => (s.receipt.nonce = "1".repeat(32))],
    ["wrong receipt generation", (s: any) => (s.receipt.generation = "2")],
    [
      "tampered fingerprint",
      (s: any) => (s.receipt.effectFingerprint = digest(9)),
    ],
    [
      "wrong receipt manifest",
      (s: any) => (s.receipt.ledgerManifest = phase.baselineManifest),
    ],
    ["wrong reader", (s: any) => (s.role.current = "reviewrouter")],
    ["wrong database", (s: any) => (s.identity.databaseOid = "999")],
    [
      "custody attestation fails",
      (s: any) => (s.fail = "DO $custody_attestation$"),
    ],
    [
      "snapshot import fails",
      (s: any) => (s.fail = "SET TRANSACTION SNAPSHOT"),
    ],
    ["backend alive", (s: any) => (s.backend = true)],
    ["partial ledger", (s: any) => s.ledger.pop()],
    ["wrong checksum", (s: any) => (s.ledger[95].checksum = "a".repeat(64))],
    ["retained row changed", (s: any) => (s.ledger[0].id = "changed")],
    ["catalog drift", (s: any) => (s.catalog = { ...s.catalog, facts: [] })],
    ["gate open", (s: any) => (s.gate = { ...gate, gateStatus: "open" })],
    ["gate changed", (s: any) => (s.gate = { ...gate, revision: "8" })],
    ["membership drift", (s: any) => (s.memberships = [])],
    ["ACL drift", (s: any) => s.acl.rows.pop()],
    ["unreadable ledger", (s: any) => (s.fail = renderManagedLedgerSql)],
    ["unreadable catalog", (s: any) => (s.fail = renderManagedCatalogSql)],
    ["unreadable ACL", (s: any) => (s.fail = renderHistorical89ObjectAclSql)],
    [
      "unreadable membership",
      (s: any) => (s.fail = renderManagedMembershipSql),
    ],
    [
      "unreadable gate",
      (s: any) => (s.fail = "SELECT jsonb_build_object('gateStatus'"),
    ],
  ])("rejects %s", async (_name, mutate) => {
    const f = fixture();
    (mutate as (state: typeof f.state) => void)(f.state);
    await expect(
      verifyHistorical89Already96(f.client, f.reader, f.request),
    ).rejects.toThrow();
  });
  it("rejects different reader endpoints", async () => {
    const f = fixture();
    f.reader.connectionParameters.host = "elsewhere.invalid";
    await expect(
      verifyHistorical89Already96(f.client, f.reader, f.request),
    ).rejects.toThrow("reader_endpoint_mismatch");
  });
  it("requires independently pinned original request bytes and explicit operation", () => {
    const bytes = bytesOf();
    for (const [id, hash] of [
      ["", hashOf(bytes)],
      [admission().operationId, ""],
      [admission().operationId, digest(9)],
      ["other", hashOf(bytes)],
    ])
      expect(() => parseHistorical89Verification(bytes, id, hash)).toThrow();
    const bad = bytesOf({
      ...document(),
      coordinates: { epoch: 0, generation: 1, nonce: "0".repeat(32) },
    });
    expect(() =>
      parseHistorical89Verification(bad, admission().operationId, hashOf(bad)),
    ).toThrow("coordinates");
    const unbound = bytesOf({
      ...document(),
      originalMembership: { ...originalMembership, adminOption: false },
    });
    expect(() =>
      parseHistorical89Verification(
        unbound,
        admission().operationId,
        hashOf(unbound),
      ),
    ).toThrow("original_membership_binding");
  });
});

const runtime = vi.hoisted(() => ({ clients: [] as any[] }));
vi.mock("pg", () => ({
  default: {
    Client: function () {
      return runtime.clients.shift();
    },
  },
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
describe("native runner startup exit contract", () => {
  it.each(["valid", "missing request", "receipt unavailable", "permit stale"])(
    "%s",
    async (mode) => {
      const f = fixture();
      if (mode === "receipt unavailable")
        f.state.fail =
          "SELECT COALESCE(release_operation_custody.custody_read_effect";
      if (mode === "permit stale") f.state.permit.epoch = "2";
      runtime.clients = [f.client, f.reader];
      const dir = mkdtempSync(join(tmpdir(), "rr-startup96-unit-"));
      const path = join(dir, "request.json");
      const bytes = bytesOf();
      writeFileSync(path, bytes);
      vi.stubEnv(
        "REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL",
        "postgres://unit@unit.invalid/review_router_dimy",
      );
      vi.stubEnv(
        "REVIEW_ROUTER_RELEASE_MIGRATION_CUSTODY_READER_DATABASE_URL",
        "postgres://reviewrouter_operation_custody_reader@unit.invalid/review_router_dimy",
      );
      vi.stubEnv(
        "REVIEW_ROUTER_HISTORICAL89_VERIFICATION_PATH",
        mode === "missing request" ? "" : path,
      );
      vi.stubEnv(
        "REVIEW_ROUTER_HISTORICAL89_OPERATION_ID",
        admission().operationId,
      );
      vi.stubEnv(
        "REVIEW_ROUTER_HISTORICAL89_VERIFICATION_SHA256",
        hashOf(bytes),
      );
      const exit = vi
        .spyOn(process, "exit")
        .mockImplementation(() => undefined as never);
      const output = vi.spyOn(console, "log").mockImplementation(() => {});
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        vi.resetModules();
        const { runHistorical89Cli } =
          await import("../run-historical89-inplace-operation.mjs");
        await runHistorical89Cli();
        expect(errors).not.toHaveBeenCalled();
        expect(exit).toHaveBeenCalledWith(mode === "valid" ? 0 : 1);
        expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({
          outcome: mode === "valid" ? "already-96" : "fenced-unresolved",
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

// Launch the actual executable with only pg replaced. All classification,
// durable-request authentication, and terminal-evidence validators remain real.
// The adapter is in-process: it cannot open a socket or execute database SQL.
describe("runner executable mutation denial", () => {
  it.each([
    "baseline89",
    "already96",
    "missing request",
    "wrong digest",
    "missing receipt",
    "stale permit",
    "wrong reader",
  ])("%s", async (mode) => {
    const f = fixture();
    await verifyHistorical89Already96(f.client, f.reader, f.request);
    const verificationQueries = [...f.queries];
    if (mode === "baseline89") f.state.ledger = ledger(89);
    if (mode === "missing receipt") f.state.receipt = null;
    if (mode === "stale permit") f.state.permit.epoch = "2";
    if (mode === "wrong reader") f.state.role.current = "reviewrouter";
    const responses: Record<string, unknown> = {};
    // Exact known read queries only; an unexpected query is recorded and fails.
    for (const sql of [renderManagedLedgerSql, ...verificationQueries])
      responses[sql] = await f.client.query(sql);
    const dir = mkdtempSync(join(tmpdir(), "rr-runner-denial-"));
    try {
      const requestPath = join(dir, "request.json");
      const tracePath = join(dir, "trace.jsonl");
      const adapterPath = join(dir, "pg.mjs");
      const loaderPath = join(dir, "register.mjs");
      writeFileSync(requestPath, bytesOf());
      writeFileSync(tracePath, "");
      writeFileSync(
        adapterPath,
        String.raw`import { appendFileSync } from "node:fs";
const responses = ${JSON.stringify(responses)};
const trace = (event) => appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify(event) + "\n");
let nextId = 0;
export default { Client: class {
  constructor({ connectionString }) {
    this.id = nextId++;
    const url = new URL(connectionString);
    this.connectionParameters = { host: url.hostname, port: 5432, database: url.pathname.slice(1) };
  }
  async connect() { trace({ event: "connect", id: this.id }); }
  async end() { trace({ event: "end", id: this.id }); }
  async query(sql) {
    trace({ event: "query", id: this.id, sql });
    if (!Object.hasOwn(responses, sql)) throw new Error("unexpected_adapter_query");
    return responses[sql];
  }
}};
`,
      );
      writeFileSync(
        loaderPath,
        `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "pg") return { url: ${JSON.stringify(pathToFileURL(adapterPath).href)}, shortCircuit: true };
  return nextResolve(specifier, context);
}});
`,
      );
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          import.meta.resolve("tsx"),
          "--import",
          loaderPath,
          fileURLToPath(
            new URL(
              "../run-historical89-inplace-operation.mjs",
              import.meta.url,
            ),
          ),
        ],
        {
          // Do not inherit credentials, NODE_OPTIONS, or database overrides.
          env: {
            REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL:
              "postgres://fixture@unit.invalid/review_router_dimy",
            REVIEW_ROUTER_RELEASE_MIGRATION_CUSTODY_READER_DATABASE_URL:
              "postgres://reviewrouter_operation_custody_reader@unit.invalid/review_router_dimy",
            REVIEW_ROUTER_HISTORICAL89_VERIFICATION_PATH:
              mode === "missing request" ? "" : requestPath,
            REVIEW_ROUTER_HISTORICAL89_OPERATION_ID: admission().operationId,
            REVIEW_ROUTER_HISTORICAL89_VERIFICATION_SHA256:
              mode === "wrong digest" ? digest(9) : hashOf(bytesOf()),
          },
          encoding: "utf8",
          timeout: 15_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, result.stderr).toBe(mode === "already96" ? 0 : 1);
      const events = readFileSync(tracePath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const queries = events
        .filter((e) => e.event === "query")
        .map((e) => e.sql);
      expect(
        events
          .filter((e) => e.event === "end")
          .map((e) => e.id)
          .sort(),
      ).toEqual(
        events
          .filter((e) => e.event === "connect")
          .map((e) => e.id)
          .sort(),
      );
      if (mode === "baseline89") {
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe(
          "historical89_inplace_failed:render_historical89_admission_rejected:independent_review_missing\n",
        );
        expect(events).toEqual([
          { event: "connect", id: 0 },
          { event: "query", id: 0, sql: renderManagedLedgerSql },
          { event: "end", id: 0 },
        ]);
      } else {
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toMatchObject(
          mode === "already96"
            ? {
                outcome: "already-96",
                authorizesProductionMutation: false,
                verification: "read-only-snapshot",
                receiptDigest: f.state.receipt.effectFingerprint,
              }
            : {
                outcome: "fenced-unresolved",
                reason: "already96_verification_failed",
              },
        );
        if (mode === "already96")
          expect(queries).toEqual([
            renderManagedLedgerSql,
            ...verificationQueries,
          ]);
        if (mode === "missing request" || mode === "wrong digest")
          expect(queries).toEqual([renderManagedLedgerSql]);
        for (const sql of queries)
          expect(Object.hasOwn(responses, sql)).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
