import { readRenderHistorical96CheckoutInventory } from "./render-historical96-checkout.mjs";
import { describe, expect, it, vi } from "vitest";
import { captureHistorical89Prerequisites } from "./render-historical89-prerequisite-capture.mjs";
import {
  renderManagedEvidenceDigest,
  renderManagedLedgerSql,
  renderManagedMembershipSql,
} from "./render-schema-handoff-policy.mjs";
import {
  readHistorical89PendingIdentities,
  renderHistorical89DefaultAclSql,
  renderHistorical89ObjectAclSql,
} from "./render-historical89-admission.mjs";
import { renderManagedCatalogSql } from "./render-managed-catalog.mjs";
import { renderManagedRuntimeGateSql } from "./render-managed-workflow-cutover.mjs";
import { projectionOf } from "./render-managed-transaction-bodies.mjs";
import { renderHistorical89ConnectAclSql } from "./render-historical89-execution-boundary.mjs";

const expected = {
  databaseName: "review_router_test",
  databaseOid: "16384",
  systemIdentifier: "7531234567890123456",
  sessionUser: "reviewrouter",
  currentRole: "reviewrouter",
};
const source = {
  commit: "b3f27bf3ceb41a3dcb1ed7dca66edda55704c3d3",
  label: "disposable-fixture",
};
const inventory = readRenderHistorical96CheckoutInventory();
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
function fixture(count = 89): Record<string, any> {
  return {
    identity: {
      ...expected,
      readOnly: "on",
      isolation: "repeatable read",
      backendPid: 123,
      backendStart: "2026-09-08 00:00:00+00",
    },
    cluster: { systemIdentifier: expected.systemIdentifier },
    capabilities: {
      superuser: false,
      createRole: false,
      ledgerExists: true,
      ledgerSelect: true,
      ledgerInsert: true,
      ledgerUpdate: true,
      ledgerDelete: true,
      ledgerOwner: "reviewrouter",
      publicSchemaOwner: "reviewrouter",
      publicSchemaCreate: true,
      namespaceObjectOwner: "reviewrouter",
      schemaOwnerRoleExists: true,
      signalBackend: false,
      retainedGuardRoutine: false,
      retainedGuardTrigger: false,
      signalTargets: [],
    },
    gate: { gateStatus: "closed", authzEpoch: "1", revision: "2" },
    ledger: ledger(count),
    catalog: {
      version: 1,
      serverVersionNum: 170010,
      database: expected.databaseName,
      sessionUser: expected.sessionUser,
      currentUser: expected.currentRole,
      facts: [
        {
          family: "authority",
          fact: { roles: [], unsupportedAuthorityFamilies: [] },
        },
      ],
    },
    memberships: [
      {
        role: "reviewrouter_release_schema_owner",
        member: "reviewrouter",
        grantor: "postgres",
        adminOption: true,
        inheritOption: false,
        setOption: false,
      },
    ],
    defaultAcl: { version: 1, rows: [] },
    objectAcl: { version: 1, rows: [] },
    connectAcl: {
      version: 1,
      database: expected.databaseName,
      allowConnections: true,
      connectionLimit: -1,
      owner: expected.currentRole,
      raw: null,
      entries: [
        {
          grantee: "PUBLIC",
          granteeOid: "0",
          grantor: expected.currentRole,
          grantorOid: "10",
          privilege: "CONNECT",
          grantable: false,
        },
      ],
      connectCapableRoles: [],
      backends: [],
    },
  };
}
const projectionSql = [
  renderManagedRuntimeGateSql,
  ...[
    renderManagedLedgerSql,
    renderManagedCatalogSql,
    renderManagedMembershipSql,
    renderHistorical89DefaultAclSql,
    renderHistorical89ObjectAclSql,
    renderHistorical89ConnectAclSql,
  ].map((sql) => projectionOf(sql)),
];
function harness(values = fixture(), failAt?: string, code = "42501") {
  const names = Object.keys(values);
  const sequence: string[] = [];
  let index = 0;
  const client = {
    end: vi.fn(),
    query: vi.fn(
      async ({
        text,
        query_timeout,
      }: {
        text: string;
        query_timeout: number;
      }) => {
        const name = text.startsWith("WITH capture") ? names[index++] : text;
        expect(query_timeout).toBe(name === "catalog" ? 16000 : 5000);
        if (name === undefined) throw new Error("unexpected capture query");
        sequence.push(name);
        if (name === failAt)
          throw Object.assign(new Error("password=secret-provider-body"), {
            code,
            detail: "secret-detail",
            hint: "secret-hint",
          });
        if (text === "ROLLBACK") return { command: "ROLLBACK", rows: [] };
        if (!text.startsWith("WITH capture"))
          return { command: text.split(" ")[0]!, rows: [] };
        expect(text).toContain("AS MATERIALIZED");
        const byteLimit = name === "catalog" ? 8 * 1024 * 1024 : 2_000_000;
        expect(text).toContain(`octet_length(value::text)<=${byteLimit}`);
        expect(text).toContain(
          `octet_length(value::text)>${byteLimit} AS exceeded`,
        );
        expect(text).toMatch(/LIMIT 2$/u);
        if (index >= 4) expect(text).toContain(projectionSql[index - 4]);
        return {
          command: "SELECT",
          rows: [{ value: values[name], exceeded: false as unknown }],
        };
      },
    ),
  };
  return {
    client,
    sequence,
    run: () =>
      captureHistorical89Prerequisites({
        client,
        expected,
        source,
        idleClient: true,
      }),
  };
}

describe("read-only historical89 prerequisite capture", () => {
  it.each([89, 96])(
    "captures actual %i ledger observations without authorizing success",
    async (count) => {
      const values = fixture(count);
      const h = harness(values);
      const result = await h.run();
      expect(h.sequence).toEqual([
        "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
        "SET LOCAL statement_timeout = '4s'",
        "SET LOCAL lock_timeout = '1s'",
        "SET LOCAL idle_in_transaction_session_timeout = '5s'",
        "SET LOCAL jit = off",
        "SET LOCAL search_path = pg_catalog, public",
        ...Object.keys(values).flatMap((name) =>
          name === "catalog"
            ? [
                "SET LOCAL statement_timeout = '15s'",
                name,
                "SET LOCAL statement_timeout = '4s'",
              ]
            : [name],
        ),
        "ROLLBACK",
      ]);
      expect(result.limits).toEqual({
        bytes: 2_000_000,
        catalogBytes: 8 * 1024 * 1024,
        rows: 20_000,
        queryMs: 5_000,
        statementMs: 4_000,
        catalogQueryMs: 16_000,
        catalogStatementMs: 15_000,
      });
      expect(result.collectionComplete).toBe(true);
      expect(result.rollbackConfirmed).toBe(true);
      expect(result.observations).toEqual(values);
      expect(result.ledgerObservation?.count).toBe(count);
      expect(result.unresolvedCapabilities).not.toContain(
        "ledger-history-not-qualified",
      );
      expect(
        result.migrationIdentities?.some(
          (row) => row.migrationName === "000098_certified_fork_effect_archive",
        ),
      ).toBe(false);
      expect(result.migrationIdentities).toEqual(
        readHistorical89PendingIdentities(),
      );
      expect(result.migrationIdentities).toHaveLength(7);
      expect(
        result.migrationIdentities?.filter((r) =>
          r.migrationName?.startsWith("000089_"),
        ),
      ).toHaveLength(2);
      expect(result.authorizesProductionMutation).toBe(false);
      expect(result).not.toHaveProperty("success");
      expect(result.unresolvedCapabilities).toContain(
        "complete-effective-authority-qualification",
      );
      expect(h.client.end).not.toHaveBeenCalled();
      const sql = h.client.query.mock.calls.map(([q]) => q.text).join("\n");
      expect(sql).not.toMatch(
        /\b(COMMIT|SET ROLE|INSERT INTO|UPDATE public|DELETE FROM|pg_terminate_backend\(|rolpassword|pg_authid)\b/iu,
      );
      expect(sql).toContain("current_setting('transaction_read_only')");
      expect(sql).toContain("current_setting('transaction_isolation')");
      expect(sql).toContain("pg_catalog.pg_control_system()");
      expect(sql).toContain("'backendPid',pg_backend_pid()");
      expect(sql).toContain("'createRole',r.rolcreaterole");
      expect(sql).toContain("'signalBackend',pg_has_role");
      expect(sql).toContain("'definitionDigest'");
      expect(sql).toContain("'configurationDigest'");
    },
  );

  it("rolls back a failed JIT setup before collecting any evidence", async () => {
    const h = harness(fixture(), "SET LOCAL jit = off");
    const result = await h.run();
    expect(result.collection.timeouts).toBe("permission-denied");
    expect(result.observations).toEqual({});
    expect(result.collectionComplete).toBe(false);
    expect(result.rollbackConfirmed).toBe(true);
    expect(h.sequence.slice(-2)).toEqual(["SET LOCAL jit = off", "ROLLBACK"]);
    expect(h.client.end).not.toHaveBeenCalled();
  });

  it.each(["setup", "restore"])(
    "fails closed on catalog budget %s failure",
    async (phase) => {
      const h = harness();
      const original = h.client.query.getMockImplementation()!;
      let defaults = 0;
      h.client.query.mockImplementation(async (config) => {
        if (config.text === "SET LOCAL statement_timeout = '4s'") defaults++;
        if (
          (phase === "setup" &&
            config.text === "SET LOCAL statement_timeout = '15s'") ||
          (phase === "restore" &&
            defaults === 2 &&
            config.text === "SET LOCAL statement_timeout = '4s'")
        )
          throw Object.assign(new Error("secret"), { code: "22023" });
        return original(config);
      });
      const result = await h.run();
      expect(result.collection.catalog).toBe("query-failed");
      expect(result.digests.ledger).toBe(
        renderManagedEvidenceDigest(fixture().ledger),
      );
      expect(Boolean(result.digests.catalog)).toBe(phase === "restore");
      expect(result.collection.memberships).toBe("not-collected");
      expect(result.collectionComplete).toBe(false);
      expect(result.rollbackConfirmed).toBe(true);
      expect(h.sequence.at(-1)).toBe("ROLLBACK");
    },
  );

  it("binds digests to collected projections, with canonical object key order", async () => {
    const a = fixture();
    const b = fixture();
    b.gate = { revision: "2", authzEpoch: "1", gateStatus: "closed" };
    const first = await harness(a).run();
    const second = await harness(b).run();
    expect(second.digests).toEqual(first.digests);
    for (const [name, value] of Object.entries(a))
      expect(first.digests[name]).toBe(renderManagedEvidenceDigest(value));
    b.ledger[0].id = "10000000-0000-0000-0000-000000000001";
    b.catalog.facts.push({
      family: "routine",
      fact: { definitionDigest: "changed" },
    });
    const changed = await harness(b).run();
    expect(changed.digests.ledger).not.toBe(first.digests.ledger);
    expect(changed.digests.catalog).not.toBe(first.digests.catalog);
    expect(changed.digests.gate).toBe(first.digests.gate);
  });

  it.each([
    "databaseName",
    "databaseOid",
    "sessionUser",
    "currentRole",
    "systemIdentifier",
  ])("guards mismatched %s before broad reads", async (key) => {
    const values = fixture();
    values[key === "systemIdentifier" ? "cluster" : "identity"][key] =
      "unexpected";
    const h = harness(values);
    const result = await h.run();
    expect(result.collectionComplete).toBe(false);
    expect(result.unresolvedCapabilities.join()).toContain("identity-mismatch");
    expect(h.sequence).not.toContain("capabilities");
    expect(h.sequence.at(-1)).toBe("ROLLBACK");
  });

  it.each(["readOnly", "isolation", "backendPid", "backendStart"])(
    "rejects missing transaction fact %s",
    async (key) => {
      const values = fixture();
      delete values.identity[key];
      const h = harness(values);
      const result = await h.run();
      expect(result.collectionComplete).toBe(false);
      expect(h.sequence).not.toContain("cluster");
      expect(result.rollbackConfirmed).toBe(true);
    },
  );

  it.each([
    "identity",
    "cluster",
    "capabilities",
    "gate",
    "ledger",
    "catalog",
    "memberships",
    "defaultAcl",
    "objectAcl",
    "connectAcl",
  ])(
    "stops and sanitizes a permission failure at %s, retaining only earlier facts",
    async (stage) => {
      const h = harness(fixture(), stage);
      const result = await h.run();
      expect(result.collection[stage]).toBe("permission-denied");
      expect(result.digests).not.toHaveProperty(stage);
      expect(JSON.stringify(result)).not.toMatch(
        /secret-provider-body|secret-detail|secret-hint|password=/u,
      );
      expect(h.sequence.slice(-2)).toEqual([stage, "ROLLBACK"]);
      expect(result.rollbackConfirmed).toBe(true);
      expect(result.collectionComplete).toBe(false);
    },
  );

  it("rejects an invalid CONNECT ACL before recording its observation or digest", async () => {
    const values = fixture();
    values.connectAcl.owner = "postgres";
    const result = await harness(values).run();
    expect(result.collection.connectAcl).toBe("collection-failed");
    expect(result.observations.connectAcl).toBeUndefined();
    expect(result.digests.connectAcl).toBeUndefined();
    expect(result.collectionComplete).toBe(false);
    expect(result.authorizesProductionMutation).toBe(false);
  });

  it.each(["57014", "XX000"])(
    "sanitizes timeout/other query error %s",
    async (code) => {
      const result = await harness(fixture(), "catalog", code).run();
      expect(result.collection.catalog).toBe(
        code === "57014" ? "query-timeout" : "query-failed",
      );
      expect(result.rollbackConfirmed).toBe(true);
      expect(result.collectionComplete).toBe(false);
      expect(result.digests.ledger).toBeTruthy();
      expect(result.collection.memberships).toBe("not-collected");
    },
  );

  it("retains pre-catalog evidence and requires discard when timeout cleanup fails", async () => {
    const h = harness(fixture(), "catalog", "57014");
    const original = h.client.query.getMockImplementation()!;
    h.client.query.mockImplementation(async (config) => {
      if (config.text === "ROLLBACK") {
        expect(config.query_timeout).toBe(5_000);
        throw new Error("secret-cleanup-failure");
      }
      return original(config);
    });
    const result = await h.run();
    expect(result.collection.catalog).toBe("query-timeout");
    expect(result.digests.ledger).toBe(
      renderManagedEvidenceDigest(fixture().ledger),
    );
    expect(result.observations.catalog).toBeUndefined();
    expect(result.collection.memberships).toBe("not-collected");
    expect(result.rollbackConfirmed).toBe(false);
    expect(result.collectionComplete).toBe(false);
    expect(result.authorizesProductionMutation).toBe(false);
    expect(result.unresolvedCapabilities).toContain(
      "rollback-unconfirmed-discard-client",
    );
    expect(h.client.query.mock.calls.at(-1)?.[0].text).toBe("ROLLBACK");
    expect(JSON.stringify(result)).not.toMatch(
      /secret-cleanup-failure|secret-provider-body|secret-detail|secret-hint/u,
    );
  });

  it.each([null, { version: 1, facts: [] }])(
    "does not call missing catalog facts complete",
    async (catalog) => {
      const values = fixture();
      values.catalog = catalog;
      const result = await harness(values).run();
      expect(result.collection.catalog).toBe("missing-facts");
      expect(result.digests.catalog).toBeUndefined();
    },
  );

  it("reports open gate, partial ledger, missing ownership and signal rights as unresolved", async () => {
    const values = fixture(92);
    values.gate.gateStatus = "open";
    values.capabilities.ledgerInsert = false;
    values.capabilities.namespaceObjectOwner = null;
    values.capabilities.signalTargets = [
      { pid: 234, role: "writer", superuser: false, roleUsage: false },
    ];
    const result = await harness(values).run();
    expect(result.collectionComplete).toBe(true);
    expect(result.ledgerObservation).toBeUndefined();
    expect(result.unresolvedCapabilities).toEqual(
      expect.arrayContaining([
        "ledger-history-not-qualified",
        "closed-gate-not-observed",
        "ledgerInsert-not-observed",
        "namespaceObjectOwner-not-current-role",
        "existing-guard-signal-rights-unresolved",
      ]),
    );
  });

  it.each([
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    "SET LOCAL statement_timeout = '4s'",
    "ROLLBACK",
  ])("attempts cleanup even when %s fails", async (stage) => {
    const h = harness(fixture(), stage);
    const result = await h.run();
    expect(h.sequence.at(-1)).toBe("ROLLBACK");
    expect(result.rollbackConfirmed).toBe(stage !== "ROLLBACK");
    expect(result.collectionComplete).toBe(false);
    expect(h.client.end).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("secret-provider-body");
  });

  it.each(["bytes", "rows", "server"])(
    "enforces %s read cap without digesting truncated data",
    async (kind) => {
      const values = fixture();
      if (kind === "bytes")
        values.objectAcl.rows = [{ identity: "x".repeat(2_000_001) }];
      if (kind === "rows") values.objectAcl.rows = Array(20_001).fill({});
      const h = harness(values);
      if (kind === "server") {
        const original = h.client.query.getMockImplementation()!;
        h.client.query.mockImplementation(async (query) =>
          query.text.startsWith("WITH capture")
            ? { command: "SELECT", rows: [{ value: null, exceeded: true }] }
            : original(query),
        );
      }
      const result = await h.run();
      expect(result.collectionComplete).toBe(false);
      expect(result.digests.objectAcl).toBeUndefined();
      expect(result.rollbackConfirmed).toBe(true);
      expect(result.unresolvedCapabilities.join()).toContain("read-cap");
    },
  );

  it("collects the full catalog above 2MB and below 8MiB without omitting facts", async () => {
    const values = fixture();
    values.catalog.facts.push(
      ...Array.from({ length: 15_038 }, (_, i) => ({
        family: "routine",
        fact: { identity: `routine-${i}`, definitionDigest: "x".repeat(240) },
      })),
    );
    const bytes = Buffer.byteLength(JSON.stringify(values.catalog));
    expect(bytes).toBeGreaterThan(2_000_000);
    expect(bytes).toBeLessThan(8 * 1024 * 1024);
    const result = await harness(values).run();
    expect(result.collectionComplete).toBe(true);
    expect(result.collection.catalog).toBe("collected");
    expect(result.observations.catalog).toEqual(values.catalog);
    expect(result.observations.catalog.facts).toHaveLength(15_039);
    expect(result.digests.catalog).toBe(
      renderManagedEvidenceDigest(values.catalog),
    );
    expect(result.rollbackConfirmed).toBe(true);
  });

  it.each(["bytes", "rows"])(
    "rejects oversized catalog %s after collecting the ledger without losing prior evidence",
    async (kind) => {
      const values = fixture();
      if (kind === "bytes")
        values.catalog.facts.push({
          family: "routine",
          fact: "x".repeat(8 * 1024 * 1024 + 1),
        });
      else
        values.catalog.facts.push(
          ...Array(20_000).fill({ family: "routine", fact: {} }),
        );
      // Isolate each client cap: the row fixture is below the byte cap and the
      // byte fixture is below the row cap. The server boolean remains false.
      expect(
        Buffer.byteLength(JSON.stringify(values.catalog)) > 8 * 1024 * 1024,
      ).toBe(kind === "bytes");
      expect(values.catalog.facts.length > 20_000).toBe(kind === "rows");
      const h = harness(values);
      const result = await h.run();
      expect(result.collection.ledger).toBe("collected");
      expect(result.digests.ledger).toBe(
        renderManagedEvidenceDigest(values.ledger),
      );
      expect(result.collection.catalog).toBe("read-cap");
      expect(result.observations.catalog).toBeUndefined();
      expect(result.digests.catalog).toBeUndefined();
      expect(result.collection.memberships).toBe("not-collected");
      expect(result.collectionComplete).toBe(false);
      expect(result.rollbackConfirmed).toBe(true);
      expect(h.sequence.slice(-2)).toEqual(["catalog", "ROLLBACK"]);
      expect(h.client.end).not.toHaveBeenCalled();
    },
  );

  it.each([true, "f", null, undefined])(
    "fails closed on catalog wrapper exceeded=%s after retaining the ledger",
    async (exceeded) => {
      const h = harness();
      const original = h.client.query.getMockImplementation()!;
      h.client.query.mockImplementation(async (query) => {
        const response = await original(query);
        if (query.text.includes(projectionOf(renderManagedCatalogSql)))
          return { command: "SELECT", rows: [{ value: null, exceeded }] };
        return response;
      });
      const result = await h.run();
      expect(result.collection.ledger).toBe("collected");
      expect(result.collection.catalog).toBe("read-cap");
      expect(result.collection.memberships).toBe("not-collected");
      expect(result.digests.catalog).toBeUndefined();
      expect(result.collectionComplete).toBe(false);
      expect(result.rollbackConfirmed).toBe(true);
      expect(h.client.end).not.toHaveBeenCalled();
    },
  );

  it.each(["checksum", "finishedAt"])(
    "keeps observed ledger digest but rejects invalid %s",
    async (key) => {
      const values = fixture();
      values.ledger[0][key] = null;
      const result = await harness(values).run();
      expect(result.digests.ledger).toBe(
        renderManagedEvidenceDigest(values.ledger),
      );
      expect(result.ledgerObservation).toBeUndefined();
      expect(result.unresolvedCapabilities).toContain(
        "ledger-history-not-qualified",
      );
    },
  );

  it.each(["gate", "capabilities"])(
    "rejects missing %s projection fields",
    async (key) => {
      const values = fixture();
      values[key] = {};
      const result = await harness(values).run();
      expect(result.collection[key]).toBe("missing-facts");
      expect(result.collectionComplete).toBe(false);
      expect(result.rollbackConfirmed).toBe(true);
    },
  );

  it.each([
    { rows: [] },
    {
      rows: [
        { value: {}, exceeded: false },
        { value: {}, exceeded: false },
      ],
    },
  ])("rejects unexpected scalar row cardinality", async ({ rows }) => {
    const h = harness();
    const original = h.client.query.getMockImplementation()!;
    h.client.query.mockImplementation(async (query) =>
      query.text.startsWith("WITH capture")
        ? { command: "SELECT", rows }
        : original(query),
    );
    const result = await h.run();
    expect(result.collection.identity).toBe("missing-facts");
    expect(result.collection.capabilities).toBe("not-collected");
    expect(result.rollbackConfirmed).toBe(true);
  });

  it("does not confirm cleanup from an unexpected command tag", async () => {
    const h = harness();
    const original = h.client.query.getMockImplementation()!;
    h.client.query.mockImplementation(async (query) =>
      query.text === "ROLLBACK"
        ? { command: "SELECT", rows: [] }
        : original(query),
    );
    const result = await h.run();
    expect(result.rollbackConfirmed).toBe(false);
    expect(result.collectionComplete).toBe(false);
    expect(result.unresolvedCapabilities).toContain(
      "rollback-unconfirmed-discard-client",
    );
  });

  it("requires explicit idle-client and non-secret source context before any query", async () => {
    const h = harness();
    await expect(
      captureHistorical89Prerequisites({
        client: h.client,
        expected,
        source,
        idleClient: false,
      }),
    ).rejects.toThrow("historical89_capture:input");
    await expect(
      captureHistorical89Prerequisites({
        client: h.client,
        expected,
        source: { ...source, label: "postgres://secret" },
        idleClient: true,
      }),
    ).rejects.toThrow("historical89_capture:input");
    expect(h.client.query).not.toHaveBeenCalled();
  });
});
