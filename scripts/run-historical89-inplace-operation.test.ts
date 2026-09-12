import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHistorical89Journal,
  historical89BackendSql,
} from "./lib/historical89-preparation-coordinator.mjs";
import {
  renderManagedEvidenceDigest as digest,
  renderManagedLedgerSql,
  renderManagedMembershipSql,
} from "./lib/render-schema-handoff-policy.mjs";
import { renderManagedCatalogSql } from "./lib/render-managed-catalog.mjs";
import { renderManagedRuntimeGateSql } from "./lib/render-managed-workflow-cutover.mjs";
import {
  renderHistorical89ConnectAclSql,
  renderHistorical89SessionDrainSql,
} from "./lib/render-historical89-execution-boundary.mjs";
import {
  renderManagedOperationAdvanceEpochSql,
  renderManagedOperationOpenPermitSql,
  renderManagedOperationEffectReadSql,
} from "./lib/render-managed-operation-custody.mjs";
import {
  renderHistorical89DefaultAclSql,
  renderHistorical89ObjectAclSql,
} from "./lib/render-historical89-admission.mjs";
import {
  renderHistorical89PreparationPrepareParts,
  renderHistorical89PreparationFinalizeParts,
  renderHistorical89PreparationService,
  renderHistorical89PreparationObserve,
} from "./lib/render-historical89-preparation-custody.mjs";

// Deliberately synthetic qualification and migration outcomes. Real preparation
// renderers, durable storage, transport order, authentication and restart logic
// are under test. Pure qualification/migration and PG17 semantics have separate
// tests; none of these fixtures is installed into the source registry.
const fixtures = vi.hoisted(() => ({
  bundle: null as any,
  checkpoints: [] as string[],
  mismatch: "",
  ledgerCount: 89,
  sourceChange: "",
}));
vi.mock("node:child_process", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  return {
    execFileSync: (_cmd: string, args: string[], options: { cwd: string }) => {
      if (args[0] === "rev-parse") return "a".repeat(40);
      const path = args[1].split(":")[1];
      return (
        readFileSync(join(options.cwd, path), "utf8") +
        (fixtures.sourceChange === path ? "\n// historical bytes differ" : "")
      );
    },
  };
});
vi.mock("./lib/render-historical89-admission.mjs", async (original) => {
  const real = await original<any>();
  return {
    ...real,
    readReviewedHistorical89Bundle: () => fixtures.bundle,
    readReviewedHistorical89BundleDigest: () => `sha256:${"b".repeat(64)}`,
    compareHistorical89Original: () => {
      fixtures.checkpoints.push("original");
      if (fixtures.mismatch === "original")
        throw new Error("original mismatch");
    },
    compareHistorical89PreparationStage: (_bundle: unknown, stage: string) => {
      fixtures.checkpoints.push(stage);
      if (fixtures.mismatch === stage) throw new Error(`${stage} mismatch`);
    },
    materializeHistorical89ReviewedTerminal: () => ({
      catalog: { terminal: true },
      digest: `sha256:${"c".repeat(64)}`,
    }),
  };
});
vi.mock("./lib/render-historical89-prerequisite-capture.mjs", () => ({
  captureHistorical89Prerequisites: async () => ({ collectionComplete: true }),
}));
vi.mock("./lib/verify-historical89-already96.mjs", async (original) => ({
  ...(await original<any>()),
  parseHistorical89Verification: () => ({}),
}));
vi.mock(
  "./lib/render-historical89-inplace-transaction.mjs",
  async (original) => ({
    ...(await original<any>()),
    inspectHistorical89InPlaceLedger: () => ({ count: fixtures.ledgerCount }),
    assertHistorical89InPlaceAclDelta: () => ({}),
  }),
);
vi.mock("./lib/render-historical89-operation.mjs", async (original) => {
  const real = await original<any>();
  return {
    ...real,
    planHistorical89InPlaceOperation: (input: any) => {
      const binding = real.historical89InPlaceCustodyBinding(input.admission);
      return {
        admission: input.admission,
        binding,
        coordinates: input.coordinates,
        identityDigest: digest(input.admission),
        reviewedTerminalCatalogDigest: input.reviewedTerminalCatalogDigest,
        creators: ["reviewrouter"],
        authorization: { authorizesProductionMutation: true },
        openPermitSql: renderManagedOperationOpenPermitSql(binding, {
          generation: input.coordinates.generation,
          nonce: input.coordinates.nonce,
          terminalCatalogDigest: input.reviewedTerminalCatalogDigest,
          admissionIdentityDigest: digest(input.admission),
        }),
        transactionSql: "TEST_MIGRATION",
        admissionRestoreSql: "TEST_ADMISSION_RESTORE",
        effectReadSql: renderManagedOperationEffectReadSql(binding),
      };
    },
    reconcileHistorical89InPlaceOperation: (observation: any) => {
      expect(observation.backendState).toBe("terminated");
      expect(observation.currentPermit.epoch).toBe(
        String(observation.plan.coordinates.epoch),
      );
      expect(observation.currentPermit.nonce).toBe(
        observation.plan.coordinates.nonce,
      );
      if (observation.receipt === null) {
        expect(observation.rollbackConfirmed).toBe(true);
        expect(observation.currentPermit.state).toBe("open");
        return { decision: "resume-same-operation" };
      }
      expect(observation.receipt).toEqual({ committed: true });
      expect(observation.currentPermit.state).toBe("terminal");
      return {
        decision: "reconciled-without-replay",
        effectFingerprint: "test-receipt",
      };
    },
  };
});
import {
  run,
  runHistorical89Operation,
} from "./run-historical89-inplace-operation.mjs";

const directories: string[] = [];
afterEach(() =>
  directories
    .splice(0)
    .forEach((d) => rmSync(d, { recursive: true, force: true })),
);
beforeEach(() => {
  fixtures.checkpoints = [];
  fixtures.mismatch = "";
  fixtures.ledgerCount = 89;
  fixtures.sourceChange = "";
});
const json = (value: unknown) => ({ rows: [{ value }] });
const gateSql = `SET search_path = pg_catalog, public;\n${renderManagedRuntimeGateSql};`;

function setup() {
  const directory = mkdtempSync(
    join(tmpdir(), "rr-historical89-coordination-"),
  );
  directories.push(directory);
  const artifactPath = join(directory, "artifact");
  writeFileSync(
    artifactPath,
    readFileSync(
      new URL("./run-historical89-inplace-operation.mjs", import.meta.url),
    ),
  );
  const journal = createHistorical89Journal(join(directory, "journal"));
  const fleet = ["api", "web", "worker"].map((role) => ({
    role,
    serviceId: `srv-${role}`,
    ownerId: "own-test",
    type: role,
  }));
  fixtures.bundle = {
    migration: {
      identity: {
        systemIdentifier: "123",
        databaseOid: "16385",
        databaseName: "review_router_dimy",
        sourceTree: "a".repeat(40),
        authorizedBinaryArtifactDigest: `sha256:${createHash("sha256").update(readFileSync(artifactPath)).digest("hex")}`,
      },
      creatorEvidence: { creatingRoles: ["reviewrouter"] },
    },
    preparation: { fleet },
  };
  const backupBytes = Buffer.from("synthetic-encrypted-custom-dump");
  const events: string[] = [];
  const flags = {
    neverSuspended: false,
    failReaderAt: 0,
    readerCount: 0,
    lose: "",
    lost: false,
    rollbackOnce: false,
    rolledBack: false,
    restrictionBeforeEffect: false,
    thirdAclState: false,
    lostPost: false,
    wrongOwner: false,
    configDrift: false,
    materializeDefaultRestore: false,
    backupCount: 0,
    failBackup: false,
    failResumeId: "",
  };
  let row: any;
  let permit: any = null;
  let restricted = false;
  let finalized = false;
  let currentStage = "";
  let sequence = 0;
  const alive = new Set<number>();
  const endpoints = {
    host: "disposable",
    port: 5432,
    database: "review_router_dimy",
  };
  const acl = {
    version: 1,
    database: "review_router_dimy",
    allowConnections: true,
    connectionLimit: -1,
    owner: "reviewrouter",
    raw: "{=c/reviewrouter}",
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
  };
  const coordinator = {
    open: async () => {
      const pid = ++sequence;
      alive.add(pid);
      return {
        connectionParameters: endpoints,
        end: async () => {
          alive.delete(pid);
        },
        query: async (sql: any) => {
          if (sql.text?.includes("set_config('reviewrouter.reader_verifier'")) {
            events.push("reader-provision");
            return { rows: [] };
          }
          if (
            sql === "BEGIN;" ||
            (typeof sql === "string" && sql.startsWith("DO $credential$"))
          )
            return { rows: [] };
          if (typeof sql === "string" && sql.includes("AS parameters"))
            return { rows: [{ parameters: "0", errors: "0" }] };
          if (typeof sql !== "string")
            return {
              rows: alive.has(sql.values[1])
                ? [{ started: `backend-${sql.values[1]}` }]
                : [],
            };
          if (sql === historical89BackendSql)
            return json({
              ...fixtures.bundle.migration.identity,
              pid,
              backendStart: `backend-${pid}`,
            });
          if (sql.includes("pg_try_advisory_lock")) return json(true);
          if (sql.includes("'present',to_regnamespace"))
            return json({
              present: !!row,
              roles: row ? 2 : 0,
              permit: false,
              owner: !!row,
              reader: !!row,
            });
          if (sql.includes("DROP SCHEMA release_operation_custody CASCADE"))
            return { command: "COMMIT", rows: [] };
          if (sql.includes("'finalized',to_regclass"))
            return json({ finalized });
          if (
            sql.includes(
              "'sessionUser',session_user,'currentUser',current_user",
            )
          )
            return json({
              sessionUser: "reviewrouter",
              currentUser: "reviewrouter",
            });
          if (sql === renderManagedMembershipSql)
            return json([{ role: "owner", member: "reviewrouter" }]);
          if (sql === renderManagedLedgerSql) return json([]);
          if (sql === renderManagedCatalogSql)
            return json({
              stage: finalized ? "finalized" : row ? "prepared" : "original",
            });
          if (
            sql === renderHistorical89DefaultAclSql ||
            sql === renderHistorical89ObjectAclSql
          )
            return json({ version: 1, rows: [] });
          if (sql === gateSql) return json({ gateStatus: "closed" });
          if (sql === renderHistorical89ConnectAclSql)
            return json({
              ...acl,
              ...(restricted
                ? {
                    raw: "{reviewrouter_operation_custody_reader=c/reviewrouter}",
                    entries: [
                      {
                        grantee: "reviewrouter_operation_custody_reader",
                        granteeOid: "11",
                        grantor: "reviewrouter",
                        grantorOid: "10",
                        privilege: flags.thirdAclState ? "CREATE" : "CONNECT",
                        grantable: false,
                      },
                    ],
                  }
                : {}),
              connectCapableRoles: row
                ? [{ role: "reviewrouter_operation_custody_reader" }]
                : [],
            });
          const identity = journal.get("identity");
          if (
            identity &&
            sql === renderHistorical89PreparationPrepareParts(identity).beginSql
          )
            return { rows: [] };
          if (
            identity &&
            sql === renderHistorical89PreparationPrepareParts(identity).bodySql
          ) {
            events.push("prepare-body");
            currentStage = "prepare";
            row ??= {
              identity,
              originalConnect: {
                database: acl.database,
                raw: acl.raw,
                entries: acl.entries,
              },
              revision: "1",
              services: {},
              evidence: {},
              finalization: null,
            };
            return { rows: [] };
          }
          if (sql.startsWith("DO $finalize$")) {
            expect(sql).toBe(
              renderHistorical89PreparationFinalizeParts(
                identity,
                journal.get("binding"),
                journal.get("finalize-revision"),
              ).bodySql,
            );
            events.push("finalize-body");
            currentStage = "finalize";
            finalized = true;
            row.finalization = {};
            row.revision = String(Number(row.revision) + 1);
            return { rows: [] };
          }
          if (sql === "COMMIT;") {
            events.push(`${currentStage}-commit`);
            if (flags.lose === currentStage && !flags.lost) {
              flags.lost = true;
              throw new Error("lost reply");
            }
            return { command: "COMMIT", rows: [] };
          }
          if (sql === "ROLLBACK;") {
            events.push("rollback");
            if (currentStage === "prepare") row = undefined;
            if (currentStage === "finalize") {
              finalized = false;
              row.finalization = null;
              row.revision = String(Number(row.revision) - 1);
            }
            return { command: "ROLLBACK", rows: [] };
          }
          const requestKey = journal
            .keys("")
            .find(
              (k) =>
                k.endsWith(".request") &&
                journal.get(k)?.sql === sql &&
                journal.get(k)?.transition,
            );
          if (requestKey) {
            const input = journal.get(requestKey).transition;
            expect(sql).toBe(
              input.kind
                ? renderHistorical89PreparationObserve(identity, input).sql
                : renderHistorical89PreparationService(identity, input).sql,
            );
            if (input.kind) row.evidence[input.kind] = input.digest;
            else {
              row.services[input.serviceId] ??= {};
              row.services[input.serviceId][
                input.phase === "intent" ? "intentSha256" : "resultSha256"
              ] = input.digest;
              events.push(`${input.serviceId}-${input.phase}-commit`);
            }
            row.revision = String(input.expectedRevision + 1);
            if (flags.lose === input.phase && !flags.lost) {
              flags.lost = true;
              throw new Error("lost reply");
            }
            return [json(row), { command: "COMMIT", rows: [] }];
          }
          if (sql.includes("original_connect")) return json(row);
          if (sql.includes("'reader',(SELECT oid::text"))
            return json({ reader: "11", owner: "10" });
          if (sql === renderHistorical89SessionDrainSql) {
            events.push("drain");
            return { rows: [] };
          }
          if (sql.includes("historical89_admission_identity")) {
            events.push("restrict");
            if (!flags.restrictionBeforeEffect) restricted = true;
            if (flags.lose === "restriction" && !flags.lost) {
              flags.lost = true;
              throw new Error("lost reply");
            }
            restricted = true;
            return { rows: [] };
          }
          if (sql.includes("$fleet$")) {
            events.push("fleet-guard");
            return { rows: [] };
          }
          if (
            sql.startsWith(
              "SELECT release_operation_custody.custody_open_operation(",
            )
          ) {
            events.push("permit");
            const input = journal.get("plan-input");
            const binding = journal.get("binding");
            permit = {
              ...binding,
              kind: "managed-historical89-in-place/v1",
              admissionIdentityDigest: digest(input.admission),
              terminalCatalogDigest: input.reviewedTerminalCatalogDigest,
              epoch: "1",
              generation: "1",
              nonce: input.coordinates.nonce,
              state: "open",
            };
            if (flags.lose === "permit" && !flags.lost) {
              flags.lost = true;
              throw new Error("lost reply");
            }
            return json(permit);
          }
          if (sql.includes("custody_advance_epoch(")) {
            const advance = journal.get("epoch-1");
            expect(sql).toBe(
              renderManagedOperationAdvanceEpochSql(
                journal.get("binding"),
                advance,
              ),
            );
            expect(permit.epoch).toBe(String(advance.expectedEpoch));
            expect(permit.nonce).toBe(advance.expectedNonce);
            expect(journal.get("verification-2.pin")).toBeDefined();
            events.push("epoch");
            permit.epoch = "2";
            permit.nonce = advance.nextNonce;
            if (flags.lose === "epoch" && !flags.lost) {
              flags.lost = true;
              throw new Error("lost reply");
            }
            return json(permit);
          }
          if (sql.includes("custody_current_permit(")) return json(permit);
          if (
            sql.startsWith(
              "SELECT COALESCE(release_operation_custody.custody_read_effect(",
            )
          )
            return json(
              fixtures.ledgerCount === 96 ? { committed: true } : null,
            );
          if (sql === "TEST_MIGRATION") {
            events.push("migration");
            if (flags.rollbackOnce && !flags.rolledBack) {
              flags.rolledBack = true;
              throw new Error("confirmed fixture rollback");
            }
            fixtures.ledgerCount = 96;
            permit.state = "terminal";
            if (flags.lose === "migration" && !flags.lost) {
              flags.lost = true;
              throw new Error("lost reply");
            }
            return { rows: [] };
          }
          if (sql === "TEST_ADMISSION_RESTORE") {
            events.push("admission-restore");
            restricted = false;
            if (flags.materializeDefaultRestore) acl.raw = "{=c/reviewrouter}";
            return { rows: [] };
          }
          throw new Error(`unhandled fixture SQL: ${sql.slice(0, 100)}`);
        },
      };
    },
  };
  const openReader = async () => {
    events.push("reader-open");
    flags.readerCount++;
    if (flags.failReaderAt === flags.readerCount)
      throw new Error("reader login failed");
    return {
      connectionParameters: endpoints,
      end: async () => {
        events.push("reader-close");
      },
      query: async (sql: string) => {
        if (sql.includes("session_user"))
          return json(
            sql.includes("'currentRole'")
              ? {
                  role: "reviewrouter_operation_custody_reader",
                  currentRole: "reviewrouter_operation_custody_reader",
                }
              : {
                  sessionUser: "reviewrouter_operation_custody_reader",
                  currentUser: "reviewrouter_operation_custody_reader",
                },
          );
        if (
          sql.startsWith(
            "SELECT COALESCE(release_operation_custody.custody_read_effect(",
          )
        )
          return json(fixtures.ledgerCount === 96 ? { committed: true } : null);
        return json(row);
      },
    };
  };
  const suspended = new Set<string>();
  const render = {
    getService: async (id: string) => {
      events.push(`${id}-get`);
      const expected = fleet.find((s) => s.serviceId === id)!;
      return {
        id,
        ownerId: flags.wrongOwner ? "own-wrong" : expected.ownerId,
        type: expected.type,
        autoDeploy: flags.configDrift ? "yes" : "no",
        suspended: suspended.has(id) ? "suspended" : "not_suspended",
        serviceDetails: { preDeployCommand: "" },
      };
    },
    suspend: async (id: string) => {
      expect(events).toContain(`${id}-intent-commit`);
      expect(journal.get(`${id}-intent.complete`)).toBeDefined();
      events.push(`${id}-post`);
      if (!flags.neverSuspended) suspended.add(id);
      if (flags.lostPost) throw new Error("POST reply lost");
    },
    resume: async (id: string) => {
      events.push(`${id}-resume`);
      if (flags.failResumeId === id) throw new Error("resume failed");
      suspended.delete(id);
    },
  };
  const captureBackup = async (identity: any) => {
    flags.backupCount++;
    events.push("backup");
    if (flags.failBackup) throw new Error("backup failed");
    const backupPath = join(
      directory,
      `historical89-${identity.operationId}.dump.gpg`,
    );
    writeFileSync(backupPath, backupBytes, { flag: "wx" });
    const recovery = {
      format: "postgresql-custom-gpg",
      bytes: backupBytes.byteLength,
      sha256: `sha256:${createHash("sha256").update(backupBytes).digest("hex")}`,
      capturedAt: "2026-09-09T00:00:00.000Z",
    };
    journal.put("recovery", recovery);
    return recovery;
  };
  const run = () =>
    runHistorical89Operation({
      coordinator,
      openReader,
      readerPassword: "synthetic-reader-secret",
      render,
      journal,
      captureBackup,
      request: { sourceCommit: "e".repeat(40), artifactPath },
    });
  return {
    run,
    events,
    flags,
    journal,
    artifactPath,
    suspended,
    acl,
    arguments: {
      coordinator,
      openReader,
      readerPassword: "synthetic-reader-secret",
      render,
      journal,
      captureBackup,
      request: { sourceCommit: "e".repeat(40), artifactPath },
    },
  };
}

describe("historical89 callable preparation orchestration", () => {
  it("routes target-96 with an existing retained operation into reconciliation", async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "rr-historical89-cli-resume-"),
    );
    directories.push(directory);
    process.env.REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL =
      "postgresql://synthetic.invalid/database";
    process.env.REVIEW_ROUTER_HISTORICAL89_OPERATION_DIRECTORY = directory;
    fixtures.ledgerCount = 96;
    const retainedOperation = vi.fn(async () => ({ outcome: "committed-96" }));
    const result = await run({
      databaseConnect: async () => ({
        query: async () => json([]),
        end: async () => {},
      }),
      retainedOperation,
    });
    expect(result).toEqual({ outcome: "committed-96" });
    expect(retainedOperation).toHaveBeenCalledOnce();
  });
  it("resumes request-only migration with original coordinates after duplicate crashes", async () => {
    const test = setup();
    const put = test.journal.put;
    let crashes = 2;
    const wrapped = {
      ...test.journal,
      put(key: string, value: unknown) {
        const result = put(key, value);
        if (key === "migration-1.request" && crashes-- > 0)
          throw new Error("request-only crash");
        return result;
      },
    };
    const run = () =>
      runHistorical89Operation({
        ...test.arguments,
        journal: wrapped,
      });
    await expect(run()).rejects.toThrow("request-only crash");
    const request = test.journal.bytes("migration-1.request");
    await expect(run()).rejects.toThrow("request-only crash");
    expect(test.journal.get("migration-1.attempt-0.start")).toBeUndefined();
    expect(test.events).not.toContain("migration");
    await expect(run()).resolves.toMatchObject({ outcome: "committed-96" });
    expect(test.journal.bytes("migration-1.request")).toEqual(request);
    expect(test.events.filter((e) => e === "migration")).toHaveLength(1);
    expect(test.events).not.toContain("epoch");
  });
  it.each(["resumed", "owner", "config", "fence", "attempt", "transport"])(
    "rejects persisted binding with changed %s before Finalize replay",
    async (change) => {
      const test = setup();
      test.journal.put("provider-fixture.response", {
        observed: "synthetic-response",
      });
      fixtures.mismatch = "finalized";
      await expect(test.run()).rejects.toThrow("finalized mismatch");
      fixtures.mismatch = "";
      test.events.length = 0;
      if (change === "resumed") test.suspended.clear();
      if (change === "owner") test.flags.wrongOwner = true;
      if (change === "config") test.flags.configDrift = true;
      if (change === "fence") {
        const fence = test.journal.get("fence");
        fence.establishedAt = "changed";
        writeFileSync(join(test.journal.root, "fence"), JSON.stringify(fence));
      }
      if (change === "attempt" || change === "transport")
        writeFileSync(
          join(
            test.journal.root,
            change === "attempt"
              ? "srv-api.suspend-0.response"
              : "provider-fixture.response",
          ),
          JSON.stringify({ changed: true }),
        );
      await expect(test.run()).rejects.toThrow(/fleet_observation|retained_/);
      expect(test.events).not.toContain("finalize-body");
      expect(test.events).not.toContain("restrict");
      expect(test.events).not.toContain("migration");
    },
  );
  it.each(["finalize", "migration"])(
    "rechecks the fleet before replay after a lost %s commit",
    async (stage) => {
      const test = setup();
      test.flags.lose = stage;
      await expect(test.run()).rejects.toThrow("lost reply");
      test.suspended.delete("srv-worker");
      test.events.length = 0;
      await expect(test.run()).rejects.toThrow("fleet_observation");
      expect(test.events).not.toContain("finalize-body");
      expect(test.events).not.toContain("reader-provision");
      expect(test.events).not.toContain("epoch");
      expect(test.events).not.toContain("migration");
    },
  );
  it("orders the actual preparation renderers, committed intents, provider observations, fresh reader auth and permit", async () => {
    const test = setup();
    await expect(test.run()).resolves.toMatchObject({
      outcome: "committed-96",
    });
    expect(fixtures.checkpoints).toEqual([
      "original",
      "original",
      "prepared",
      "finalized",
    ]);
    for (const id of ["srv-api", "srv-web", "srv-worker"]) {
      expect(test.events.indexOf(`${id}-intent-commit`)).toBeLessThan(
        test.events.indexOf(`${id}-post`),
      );
      expect(test.events.indexOf(`${id}-post`)).toBeLessThan(
        test.events.indexOf(`${id}-result-commit`),
      );
      expect(test.events.indexOf(`${id}-result-commit`)).toBeLessThan(
        test.events.indexOf("backup"),
      );
    }
    expect(test.flags.backupCount).toBe(1);
    expect(test.events.indexOf("restrict")).toBeLessThan(
      test.events.indexOf("backup"),
    );
    expect(
      test.events.lastIndexOf("fleet-guard", test.events.indexOf("backup")),
    ).toBeGreaterThan(test.events.indexOf("restrict"));
    expect(
      test.events.indexOf("fleet-guard", test.events.indexOf("backup") + 1),
    ).toBeGreaterThan(test.events.indexOf("backup"));
    expect(test.events.indexOf("backup")).toBeLessThan(
      test.events.indexOf("migration"),
    );
    expect(test.journal.get("binding").recoveryIdentitySha256).toBe(
      test.journal.get("recovery").sha256,
    );
    expect(test.events.indexOf("restrict")).toBeLessThan(
      test.events.indexOf("permit"),
    );
    expect(test.events.indexOf("migration")).toBeLessThan(
      test.events.indexOf("admission-restore"),
    );
    expect(test.events.indexOf("srv-api-resume")).toBeLessThan(
      test.events.indexOf("admission-restore"),
    );
    expect(test.flags.readerCount).toBeGreaterThanOrEqual(3);
    expect(test.journal.get("verification-1.pin").digest).toMatch(/^sha256:/);
  });
  it("accepts materialized effective ACL after restoring an original null default", async () => {
    const test = setup();
    test.acl.raw = null;
    test.flags.materializeDefaultRestore = true;
    await expect(test.run()).resolves.toMatchObject({
      outcome: "committed-96",
    });
    expect(test.events).toContain("admission-restore");
  });
  it("keeps the exact fleet suspended when fresh backup capture fails", async () => {
    const test = setup();
    test.flags.failBackup = true;
    await expect(test.run()).rejects.toThrow("backup failed");
    expect(test.flags.backupCount).toBe(1);
    expect(test.suspended).toEqual(
      new Set(["srv-api", "srv-web", "srv-worker"]),
    );
    expect(test.events).toContain("restrict");
    expect(test.events).not.toContain("migration");
  });
  it.each([
    "scripts/run-historical89-inplace-operation.mjs",
    "scripts/lib/render-historical89-preparation-custody.mjs",
    "scripts/lib/historical89-preparation-coordinator.mjs",
    "scripts/lib/render-historical89-admission.mjs",
  ])(
    "rejects executing closure mismatch in %s before effects",
    async (path) => {
      const test = setup();
      fixtures.sourceChange = path;
      await expect(test.run()).rejects.toThrow("executable_closure");
      expect(test.events).toEqual([]);
    },
  );
  it("rejects changed artifact bytes and changed original observations before preparation", async () => {
    const artifact = setup();
    writeFileSync(artifact.artifactPath, "changed artifact");
    await expect(artifact.run()).rejects.toThrow("executable_artifact");
    expect(artifact.events).toEqual([]);
    const original = setup();
    fixtures.mismatch = "original";
    await expect(original.run()).rejects.toThrow("original mismatch");
    expect(original.events).not.toContain("prepare-body");
    expect(original.events.some((e) => e.endsWith("-post"))).toBe(false);
  });
  it("rolls back a finalized checkpoint mismatch before restriction or permit", async () => {
    const test = setup();
    fixtures.mismatch = "finalized";
    await expect(test.run()).rejects.toThrow("finalized mismatch");
    expect(test.events).toContain("rollback");
    expect(test.events).not.toContain("finalize-commit");
    expect(test.events).toContain("restrict");
    expect(test.events).not.toContain("permit");
    const original = test.journal.bytes("finalize.request");
    fixtures.mismatch = "";
    await expect(test.run()).resolves.toMatchObject({
      outcome: "committed-96",
    });
    expect(test.flags.backupCount).toBe(1);
    expect(test.journal.bytes("finalize.request")).toEqual(original);
  });
  it("rolls back a preparation checkpoint mismatch before provider effects", async () => {
    const test = setup();
    fixtures.mismatch = "prepared";
    await expect(test.run()).rejects.toThrow("prepared mismatch");
    expect(test.events).toContain("rollback");
    expect(test.events.some((e) => e.endsWith("-post"))).toBe(false);
  });
  it("cannot finalize from an acknowledged suspend without a suspended observation", async () => {
    const test = setup();
    test.flags.neverSuspended = true;
    await expect(test.run()).rejects.toThrow("suspension_unobserved");
    expect(test.events).not.toContain("finalize-body");
    expect(test.events).not.toContain("permit");
  });
  it("rehashes partial retained transport before resuming another service", async () => {
    const test = setup();
    test.journal.put("provider-fixture.response", {
      observed: "synthetic-response",
    });
    test.flags.lose = "result";
    await expect(test.run()).rejects.toThrow("lost reply");
    expect(test.journal.get("binding")).toBeUndefined();
    writeFileSync(
      join(test.journal.root, "provider-fixture.response"),
      JSON.stringify({ changed: true }),
    );
    test.events.length = 0;
    await expect(test.run()).rejects.toThrow("retained_transport");
    expect(
      test.events.some(
        (event) => event.endsWith("-post") || event.endsWith("-get"),
      ),
    ).toBe(false);
  });
  it("requires the first fresh reader login before any service effects", async () => {
    const test = setup();
    test.flags.failReaderAt = 1;
    await expect(test.run()).rejects.toThrow("reader login failed");
    expect(test.events).toContain("reader-provision");
    expect(
      test.events.some(
        (event) => event.endsWith("-post") || event.endsWith("-get"),
      ),
    ).toBe(false);
    const retained = test.journal
      .keys("")
      .map((key) => test.journal.bytes(key).toString("utf8"))
      .join("\n");
    expect(retained).not.toContain("synthetic-reader-secret");
    expect(retained).not.toContain("SCRAM-SHA-256$");
  });
  it("blocks the permit when the fresh restricted reader cannot authenticate", async () => {
    const test = setup();
    test.flags.failReaderAt = 2;
    await expect(test.run()).rejects.toThrow("reader login failed");
    expect(test.events).toContain("restrict");
    expect(test.events).not.toContain("permit");
  });
  it.each([false, true])(
    "resumes the exact restriction request after a lost reply, original ACL=%s",
    async (beforeEffect) => {
      const test = setup();
      test.flags.lose = "restriction";
      test.flags.restrictionBeforeEffect = beforeEffect;
      await expect(test.run()).rejects.toThrow("lost reply");
      const original = test.journal.bytes("restriction.request");
      await expect(test.run()).resolves.toMatchObject({
        outcome: "committed-96",
      });
      expect(test.journal.bytes("restriction.request")).toEqual(original);
      expect(test.events.filter((e) => e === "restrict")).toHaveLength(
        beforeEffect ? 2 : 1,
      );
      if (!beforeEffect) expect(test.events).toContain("drain");
    },
  );
  it("keeps an unexpected ACL state fenced on restriction recovery", async () => {
    const test = setup();
    test.flags.lose = "restriction";
    await expect(test.run()).rejects.toThrow("lost reply");
    test.flags.thirdAclState = true;
    await expect(test.run()).rejects.toThrow("restriction_third_state");
    expect(test.events).not.toContain("permit");
  });
  it("observes a committed permit before resolving its lost reply", async () => {
    const test = setup();
    test.flags.lose = "permit";
    await expect(test.run()).rejects.toThrow("lost reply");
    const original = test.journal.bytes("permit.request");
    await expect(test.run()).resolves.toMatchObject({
      outcome: "committed-96",
    });
    expect(test.journal.bytes("permit.request")).toEqual(original);
    expect(test.events.filter((e) => e === "permit")).toHaveLength(1);
  });
  it("resolves a lost epoch CAS with the same nonce and never advances twice", async () => {
    const test = setup();
    test.flags.rollbackOnce = true;
    await expect(test.run()).rejects.toThrow("confirmed fixture rollback");
    test.flags.lose = "epoch";
    await expect(test.run()).rejects.toThrow("lost reply");
    const original = test.journal.bytes("advance-1.request");
    await expect(test.run()).resolves.toMatchObject({
      outcome: "committed-96",
    });
    expect(test.journal.bytes("advance-1.request")).toEqual(original);
    expect(test.events.filter((e) => e === "epoch")).toHaveLength(1);
    expect(test.events.filter((e) => e === "migration")).toHaveLength(2);
  });
  it("reconciles a lost migration COMMIT without replay", async () => {
    const test = setup();
    test.flags.lose = "migration";
    await expect(test.run()).rejects.toThrow("lost reply");
    expect(test.events.some((event) => event.endsWith("-resume"))).toBe(false);
    expect(test.suspended).toEqual(
      new Set(["srv-api", "srv-web", "srv-worker"]),
    );
    test.journal.put("srv-api.resume-intent", {
      operationId: test.journal.get("identity").operationId,
      serviceId: "srv-api",
      recoveryIdentitySha256:
        test.journal.get("binding").recoveryIdentitySha256,
    });
    const restoreRequest = {
      sql: "TEST_ADMISSION_RESTORE",
      original: test.journal.get("original").connectAcl,
    };
    test.journal.put("admission-restore.request", restoreRequest);
    test.journal.put("admission-restore.attempt-0.start", {
      backend: {
        systemIdentifier: "123",
        databaseOid: "16385",
        databaseName: "review_router_dimy",
        pid: 999,
        backendStart: "backend-999",
      },
      requestDigest: digest(restoreRequest),
    });
    test.acl.raw = "{=c/reviewrouter}";
    test.suspended.delete("srv-api");
    await expect(test.run()).resolves.toMatchObject({
      outcome: "committed-96",
    });
    expect(test.events.filter((e) => e === "migration")).toHaveLength(1);
    expect(
      test.events.filter((event) => event.endsWith("-resume")),
    ).toHaveLength(3);
    expect(test.suspended.size).toBe(0);
  });
  it("re-suspends the exact fleet when post-commit resume fails", async () => {
    const test = setup();
    test.flags.failResumeId = "srv-web";
    await expect(test.run()).rejects.toThrow("resume failed");
    expect(test.events).toContain("migration");
    expect(test.events).toContain("srv-api-resume");
    expect(test.events).toContain("srv-web-resume");
    expect(test.events).not.toContain("srv-worker-resume");
    expect(test.suspended).toEqual(
      new Set(["srv-api", "srv-web", "srv-worker"]),
    );
    for (const id of ["srv-api", "srv-web", "srv-worker"])
      expect(
        test.journal.get(`${id}.resume-compensation-result`),
      ).toBeDefined();
    test.flags.failResumeId = "";
    await expect(test.run()).resolves.toMatchObject({
      outcome: "committed-96",
    });
    expect(test.suspended.size).toBe(0);
  });
  it("re-restricts and converges after admission restore completed before output", async () => {
    const test = setup();
    await expect(test.run()).resolves.toMatchObject({
      outcome: "committed-96",
    });
    expect(test.journal.get("admission-restore.complete")).toBeDefined();
    await expect(test.run()).resolves.toMatchObject({
      outcome: "committed-96",
    });
    expect(test.journal.get("terminal-rerestriction.complete")).toBeDefined();
    expect(
      test.journal.get("admission-restore-after-rerestriction.complete"),
    ).toBeDefined();
  });
  it("keeps a lost POST outcome unknown while accepting actual suspended GET observations", async () => {
    const test = setup();
    test.flags.lostPost = true;
    await expect(test.run()).resolves.toMatchObject({
      outcome: "committed-96",
    });
    expect(test.journal.get("srv-api.suspend-0.response")).toEqual({
      outcome: "POST-outcome-unknown",
    });
  });
  it("rejects wrong provider ownership before any suspend", async () => {
    const test = setup();
    test.flags.wrongOwner = true;
    await expect(test.run()).rejects.toThrow("fleet_observation");
    expect(test.events.some((e) => e.endsWith("-post"))).toBe(false);
  });
  it.each(["prepare", "intent", "result", "finalize"])(
    "retains the same durable request after a lost %s reply",
    async (stage) => {
      const test = setup();
      test.flags.lose = stage;
      await expect(test.run()).rejects.toThrow("lost reply");
      const key =
        stage === "prepare" || stage === "finalize"
          ? `${stage}.request`
          : `srv-api-${stage}.request`;
      const original = test.journal.bytes(key);
      await expect(test.run()).resolves.toMatchObject({
        outcome: "committed-96",
      });
      expect(test.journal.bytes(key)).toEqual(original);
    },
  );
});
