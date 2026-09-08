import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  managedPg17Fixture,
  prepareHistorical89Fixture,
  waitFor,
} from "./lib/render-managed-pg17-fixture";
import {
  renderManagedEvidenceDigest,
  renderManagedLedgerSql,
} from "./lib/render-schema-handoff-policy.mjs";
import { renderManagedCatalogSql } from "./lib/render-managed-catalog.mjs";
import { renderManagedRuntimeGateSql } from "./lib/render-managed-workflow-cutover.mjs";
import {
  readHistorical89PendingIdentities,
  renderHistorical89AdmissionPhase as phase,
  renderHistorical89DefaultAclSql,
  renderHistorical89ObjectAclSql,
  renderHistorical89PendingDigest,
} from "./lib/render-historical89-admission.mjs";
import {
  inspectHistorical89InPlaceLedger,
  renderHistorical89InPlaceTransaction,
} from "./lib/render-historical89-inplace-transaction.mjs";
import { renderManagedOperationCustodyBootstrap } from "./lib/render-managed-operation-custody.mjs";
import {
  renderHistorical89AdmissionRestrictionSql,
  renderHistorical89ConnectAclSql,
} from "./lib/render-historical89-execution-boundary.mjs";
import {
  historical89InPlaceCustodyBinding,
  planHistorical89InPlaceOperation,
  renderHistorical89InPlacePreflightSql,
} from "./lib/render-historical89-operation.mjs";

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistentFixtureClient } from "./lib/render-managed-pg17-persistent.fixture";
import {
  parseHistorical89Verification,
  verifyHistorical89Already96,
} from "./lib/verify-historical89-already96.mjs";

const seed = `INSERT INTO "Workspace" (id,slug,name,"updatedAt") VALUES ('old','old','old',now()),('new','new','new',now());
INSERT INTO "GitHubInstallation" (id,"workspaceId","githubInstallationId","accountLogin","accountType","repositorySelection","updatedAt")
VALUES ('installation','new',1,'disposable','Organization','all',now());
INSERT INTO "RepositoryConnection" (id,"workspaceId","externalRepositoryId","installationId","githubRepositoryId",owner,name,"fullName","defaultBranch",visibility,"updatedAt")
VALUES ('repository','new','1','installation',1,'disposable','test','disposable/test','main','public',now());
INSERT INTO "WorkflowProvisioning" (id,"workspaceId","repositoryId",status,branch,"workflowPath","actionVersion","updatedAt")
VALUES ('c','new','repository','configured','c','test.yml','v1','2026-01-02');`;

const target = "review_router_dimy";
const nonceOf = () => randomUUID().replaceAll("-", "");

(process.env.REVIEW_ROUTER_REQUIRE_HANDOFF_PG17 === "1"
  ? describe
  : describe.skip)("already96 verification, offline PG17.10", () => {
  const pg = managedPg17Fixture();
  let originalMembership: Record<string, unknown>;
  const read = (database: string, sql: string, role = "reviewrouter") =>
    JSON.parse(pg.query(database, sql, role).split("\n").at(-1)!);
  const ledger = (db: string) => read(db, renderManagedLedgerSql);
  const catalog = (db: string) => read(db, renderManagedCatalogSql);
  const defaultAcl = (db: string) => read(db, renderHistorical89DefaultAclSql);
  const objectAcl = (db: string) => read(db, renderHistorical89ObjectAclSql);
  const connectAclOf = (db: string) =>
    read(db, renderHistorical89ConnectAclSql);
  const gateOf = (db: string) =>
    read(
      db,
      `SET search_path = pg_catalog, public;\n${renderManagedRuntimeGateSql};`,
    );
  const clone = () => {
    pg.query(
      "postgres",
      `DROP DATABASE IF EXISTS ${target} WITH (FORCE);
       DROP ROLE IF EXISTS reviewrouter_operation_custody_reader;
       DROP ROLE IF EXISTS reviewrouter_operation_custody_owner;
       CREATE DATABASE ${target} TEMPLATE historical89 OWNER reviewrouter`,
      "postgres",
    );
    return target;
  };

  const creatorEvidenceOf = (db: string) => ({
    sessionUser: "reviewrouter",
    currentUser: "reviewrouter",
    creatingRoles: ["reviewrouter"],
    roleSettings: read(
      db,
      `SET search_path = pg_catalog, public;
       SELECT COALESCE(jsonb_agg(jsonb_build_object('role',COALESCE(r.rolname,'*'),
         'setting',s.setconfig::text,'value','')),'[]'::jsonb)
       FROM pg_db_role_setting s LEFT JOIN pg_roles r ON r.oid=s.setrole;`,
      "postgres",
    ),
    securityDefiners: read(
      db,
      `SET search_path = pg_catalog, public;
       SELECT COALESCE(jsonb_agg(jsonb_build_object(
         'identity',format('%I.%I',n.nspname,p.proname),
         'effectiveRole',pg_get_userbyid(p.proowner),'createsObjects',false)),'[]'::jsonb)
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.prosecdef;`,
    ),
    dynamicDdl: [
      {
        identity: "000089 canonical owner transfer",
        effectiveRole: "reviewrouter",
        createsObjects: false,
      },
    ],
    triggerCreators: [],
  });

  // Disposable qualification declarations only, never production recovery/fence evidence.
  const preconditionsOf = (db: string, connectAcl: unknown) => ({
    recovery: {
      recoveryIdentitySha256: renderManagedEvidenceDigest({
        offlineRecovery: db,
      }),
      artifactDigest: renderManagedEvidenceDigest({ offlineArtifact: db }),
      qualifiedAt: "2026-09-07T00:00:00.000Z",
      restoreVerified: true,
    },
    admission: {
      status: "closed",
      connectAclDigest: renderManagedEvidenceDigest(connectAcl),
      restrictedAt: "2026-09-07T00:01:00.000Z",
    },
    automation: {
      automaticMigrationsDisabled: true,
      declaredServices: [
        {
          serviceId: "srv-offlineapi",
          autoDeploy: "no",
          suspended: "suspended",
        },
      ],
    },
    fence: {
      externalFenceSha256: renderManagedEvidenceDigest({ offlineFence: db }),
      holder: "disposable-operator",
      scope: ["srv-offlineapi"],
      durable: true,
      survivesCoordinatorDeath: true,
      establishedAt: "2026-09-07T00:00:30.000Z",
    },
  });

  // Same disposable custody recipe as render-historical89-custody.pg17.real.test.ts.
  const prepare = (db: string) => {
    const gate = gateOf(db);
    const operationId = randomUUID();
    const identity = {
      operationId,
      systemIdentifier: pg.query(
        db,
        "SELECT system_identifier FROM pg_control_system()",
        "postgres",
      ),
      databaseOid: pg.query(
        db,
        "SELECT oid FROM pg_database WHERE datname=current_database()",
        "postgres",
      ),
      databaseName: db,
      recoveryIdentitySha256: renderManagedEvidenceDigest({
        offlineRecovery: db,
      }),
      externalFenceSha256: renderManagedEvidenceDigest({ offlineFence: db }),
    };
    const binding = historical89InPlaceCustodyBinding(identity as never);
    const custody = renderManagedOperationCustodyBootstrap(binding);
    pg.query(db, custody.bootstrapSql);
    const connectAcl = connectAclOf(db);
    pg.query(db, renderHistorical89AdmissionRestrictionSql(connectAcl));
    const baselineLedger = ledger(db);
    const baselineCatalog = catalog(db);
    const baselineDefaultAcl = defaultAcl(db);
    const admission = {
      providerDatabaseResourceId: "dpg-da32ipmk1f9s73dttm90-a",
      ...identity,
      providerEffectIds: ["offline-fixture-effect"],
      qualifiedAt: "2026-09-07T00:00:00.000Z",
      handoffSourceCommit: phase.handoffSourceCommit,
      cutoverSourceCommit: phase.cutoverSourceCommit,
      sourceTree: "0".repeat(40),
      pendingEntriesSha256: renderHistorical89PendingDigest(
        readHistorical89PendingIdentities(),
      ),
      authorizedBinaryArtifactDigest: renderManagedEvidenceDigest({
        offlineBinary: true,
      }),
      baselineManifest: phase.baselineManifest,
      targetManifest: phase.targetManifest,
      originalLedgerDigest:
        inspectHistorical89InPlaceLedger(baselineLedger).ledgerDigest,
      catalogDigest: renderManagedEvidenceDigest(baselineCatalog),
      topologyDigest: renderManagedEvidenceDigest({ offlineTopology: db }),
      ownershipDigest: renderManagedEvidenceDigest({ offlineOwnership: db }),
      aclDigest: renderManagedEvidenceDigest(baselineDefaultAcl),
      membershipDigest: renderManagedEvidenceDigest([originalMembership]),
      gateStatus: "closed",
      custodyDigest: renderManagedEvidenceDigest(gate),
    };
    const creatorEvidence = creatorEvidenceOf(db);
    const shared = {
      admission,
      ledger: baselineLedger,
      originalMembership,
      baselineCatalog,
      defaultAcl: baselineDefaultAcl,
      creatorEvidence,
      gate,
    };
    return {
      db,
      binding,
      connectAcl,
      shared,
      baselineObjectAcl: objectAcl(db),
    };
  };
  type Prepared = ReturnType<typeof prepare>;

  const rehearse = (prepared: Prepared) => {
    const built = renderHistorical89InPlaceTransaction({
      ...prepared.shared,
      preflightSql: renderHistorical89InPlacePreflightSql(prepared.binding),
    } as never);
    const expected = read(
      prepared.db,
      `${built.sql}${renderManagedCatalogSql}\nROLLBACK;`,
    );
    return { expected, digest: renderManagedEvidenceDigest(expected) };
  };

  const planned = (prepared: Prepared) => {
    const { expected, digest } = rehearse(prepared);
    const coordinates = { epoch: 1, nonce: nonceOf(), generation: 3 };
    const plan = planHistorical89InPlaceOperation({
      ...prepared.shared,
      connectAcl: prepared.connectAcl,
      preconditions: preconditionsOf(prepared.db, prepared.connectAcl),
      coordinates,
      reviewedTerminalCatalog: expected,
      reviewedTerminalCatalogDigest: digest,
      terminalCatalogProvenance: "disposable-rehearsal",
    } as never);
    return { plan, digest, coordinates };
  };

  const openPermit = (prepared: Prepared, plan: { openPermitSql: string }) =>
    JSON.parse(pg.query(prepared.db, plan.openPermitSql));

  const directory = mkdtempSync(join(tmpdir(), "rr-startup96-realpg-request-"));
  beforeAll(async () => {
    await pg.start();
    ({ originalMembership } = await prepareHistorical89Fixture(
      pg,
      "historical89",
      seed,
    ));
  }, 240_000);
  afterAll(() => {
    try {
      pg.cleanup();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("verifies the committed request through real shared snapshots and rejects another operation", async () => {
    const prepared = prepare(clone());
    const { plan, digest, coordinates } = planned(prepared);
    // Capture ORIGINAL fixture bytes before permit/effect; this is not a
    // production persistence implementation or an independent approval root.
    const path = join(directory, "request.json");
    const bytes = Buffer.from(
      JSON.stringify({
        version: 1,
        admission: prepared.shared.admission,
        coordinates,
        reviewedTerminalCatalogDigest: digest,
        originalMembership,
        baselineObjectAcl: prepared.baselineObjectAcl,
        creatorEvidence: prepared.shared.creatorEvidence,
      }),
    );
    const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600, flush: true });
    const request = parseHistorical89Verification(
      readFileSync(path),
      plan.operationId,
      hash,
    );
    openPermit(prepared, plan);
    pg.query(prepared.db, plan.transactionSql);
    expect(inspectHistorical89InPlaceLedger(ledger(prepared.db)).count).toBe(
      96,
    );
    const receipt = read(
      prepared.db,
      plan.effectReadSql,
      "reviewrouter_operation_custody_reader",
    );
    expect(receipt.permitState).toBe("terminal");
    const client = persistentFixtureClient(pg, prepared.db, "reviewrouter");
    const reader = persistentFixtureClient(
      pg,
      prepared.db,
      "reviewrouter_operation_custody_reader",
    );
    const identitySql =
      "SELECT jsonb_build_object('pid',pg_backend_pid(),'session',session_user,'current',current_user);";
    let pids: number[] = [];
    try {
      const a = (await client.query(identitySql)).rows[0].value as any;
      const b = (await reader.query(identitySql)).rows[0].value as any;
      pids = [a.pid, b.pid];
      expect(a.session).toBe("reviewrouter");
      expect(b).toMatchObject({
        session: "reviewrouter_operation_custody_reader",
        current: "reviewrouter_operation_custody_reader",
      });
      expect(a.pid).not.toBe(b.pid);
      expect(pids).not.toContain(receipt.backendPid);
      await expect(
        verifyHistorical89Already96(client, reader, request),
      ).resolves.toMatchObject({
        outcome: "already-96",
        receiptDigest: receipt.effectFingerprint,
        verification: "read-only-snapshot",
        authorizesProductionMutation: false,
      });
      for (const connection of [client, reader]) {
        expect(connection.queries).toContain(
          "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;",
        );
        expect(connection.queries.at(-1)).toBe("ROLLBACK;");
      }
      expect(readFileSync(path)).toEqual(bytes);
      expect(client.queries).toContain("SELECT pg_export_snapshot();");
      expect(
        reader.queries.some((sql) =>
          /^SET TRANSACTION SNAPSHOT '[A-Fa-f0-9]+-[A-Fa-f0-9]+-[0-9]+';$/.test(
            sql,
          ),
        ),
      ).toBe(true);
      // A separately parsed durable request for another operation cannot borrow
      // this real current permit or its protected receipt: custody itself is
      // operation-bound and PostgreSQL rejects its attestation first.
      const otherId = randomUUID();
      const otherBytes = Buffer.from(
        JSON.stringify({
          ...JSON.parse(bytes.toString()),
          admission: { ...request.admission, operationId: otherId },
        }),
      );
      const other = parseHistorical89Verification(
        otherBytes,
        otherId,
        `sha256:${createHash("sha256").update(otherBytes).digest("hex")}`,
      );
      await expect(
        verifyHistorical89Already96(client, reader, other),
      ).rejects.toThrow("custody_attestation_failed");
      for (const connection of [client, reader])
        expect(connection.queries.at(-1)).toBe("ROLLBACK;");
      const states = read(
        prepared.db,
        `SELECT jsonb_agg(jsonb_build_object('state',state,'xact',xact_start)) FROM pg_stat_activity WHERE pid IN (${pids.join(",")});`,
        "postgres",
      );
      expect(states).toEqual([
        { state: "idle", xact: null },
        { state: "idle", xact: null },
      ]);
    } finally {
      await Promise.allSettled([client.end(), reader.end()]);
      if (pids.length)
        await waitFor(
          () =>
            pg.query(
              prepared.db,
              `SELECT count(*) FROM pg_stat_activity WHERE pid IN (${pids.join(",")})`,
              "postgres",
            ) === "0",
        );
    }
  }, 300_000);
});
