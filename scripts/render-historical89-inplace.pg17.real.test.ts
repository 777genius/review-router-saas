import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  managedPg17Fixture,
  prepareHistorical89Fixture,
  waitFor,
} from "./lib/render-managed-pg17-fixture";
import {
  renderManagedEvidenceDigest,
  renderManagedLedgerSql,
  renderManagedMembershipSql,
  renderManagedTerminalCustodySql,
} from "./lib/render-schema-handoff-policy.mjs";
import { renderManagedCatalogSql } from "./lib/render-managed-catalog.mjs";
import {
  renderManagedCoordinatorExclusionSql,
  renderRetainedLedgerGuard,
} from "./lib/render-retained-exclusion.mjs";
import {
  readHistorical89PendingIdentities,
  renderHistorical89AdmissionPhase as phase,
  renderHistorical89DefaultAclSql,
  renderHistorical89ObjectAclSql,
  renderHistorical89PendingDigest,
} from "./lib/render-historical89-admission.mjs";
import {
  assertHistorical89InPlaceAclDelta,
  classifyHistorical89InPlaceOutcome,
  inspectHistorical89InPlaceLedger,
  renderHistorical89InPlaceCatalogCheck,
  renderHistorical89InPlaceTransaction,
} from "./lib/render-historical89-inplace-transaction.mjs";

const seed = `INSERT INTO "Workspace" (id,slug,name,"updatedAt") VALUES ('old','old','old',now()),('new','new','new',now());
INSERT INTO "GitHubInstallation" (id,"workspaceId","githubInstallationId","accountLogin","accountType","repositorySelection","updatedAt")
VALUES ('installation','new',1,'disposable','Organization','all',now());
INSERT INTO "RepositoryConnection" (id,"workspaceId","externalRepositoryId","installationId","githubRepositoryId",owner,name,"fullName","defaultBranch",visibility,"updatedAt")
VALUES ('repository','new','1','installation',1,'disposable','test','disposable/test','main','public',now()),
 ('private-repository','new','2','installation',2,'disposable','private','disposable/private','main','private',now());
INSERT INTO "WorkflowProvisioning" (id,"workspaceId","repositoryId",status,branch,"workflowPath","actionVersion","pullRequestUrl","errorMessage","updatedAt")
VALUES ('a','old','repository','not_started','a','test.yml','v1','https://example.invalid/1','stale','2026-01-01'),
 ('b','old','repository','not_started','b','test.yml','v1','https://example.invalid/2','stale','2026-01-02'),
 ('c','old','repository','configured','c','test.yml','v1','https://example.invalid/3','stale','2026-01-02'),
 ('private','new','private-repository','configured','main','test.yml','v1',NULL,NULL,'2026-01-02');`;

// The composed operation pins the production database NAME, so every disposable
// clone carries that exact name. Vitest runs the cases in this file
// sequentially, and each case recreates the database from the guardless
// template before it runs.
const target = "review_router_dimy";

// Required mode fails on unavailable Docker; skips are never execution proof.
(process.env.REVIEW_ROUTER_REQUIRE_HANDOFF_PG17 === "1"
  ? describe
  : describe.skip)("historical89 to96 in place, offline PG17.10", () => {
  const pg = managedPg17Fixture();
  let originalMembership: Record<string, unknown>;
  const read = (database: string, sql: string, role = "reviewrouter") =>
    JSON.parse(pg.query(database, sql, role).split("\n").at(-1)!);
  const ledger = (db: string) => read(db, renderManagedLedgerSql);
  const catalog = (db: string) => read(db, renderManagedCatalogSql);
  const defaultAcl = (db: string) => read(db, renderHistorical89DefaultAclSql);
  const objectAcl = (db: string) => read(db, renderHistorical89ObjectAclSql);
  const membership = (db: string) => read(db, renderManagedMembershipSql);
  const custody = (db: string) =>
    read(
      db,
      renderManagedTerminalCustodySql,
      "reviewrouter_comment_token_custody",
    );
  const gateOf = (db: string) => {
    const observed = custody(db);
    delete observed.authorityProbeCount;
    return observed;
  };
  const clone = () => {
    pg.query(
      "postgres",
      `DROP DATABASE IF EXISTS ${target} WITH (FORCE);
       CREATE DATABASE ${target} TEMPLATE historical89 OWNER reviewrouter`,
      "postgres",
    );
    return target;
  };
  // Fixture-local comparison bindings only. They are NOT authorization
  // receipts, production review roots or custody: no production execution,
  // registry or routing consumes anything built here.
  const plan = (db: string) => {
    const baselineLedger = ledger(db);
    const baselineCatalog = catalog(db);
    const baselineDefaultAcl = defaultAcl(db);
    const gate = gateOf(db);
    const admission = {
      providerDatabaseResourceId: "dpg-da32ipmk1f9s73dttm90-a",
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
      operationId: randomUUID(),
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
      externalFenceSha256: renderManagedEvidenceDigest({ offlineFence: db }),
      custodyDigest: renderManagedEvidenceDigest(gate),
    };
    const creatorEvidence = {
      sessionUser: "reviewrouter",
      currentUser: "reviewrouter",
      creatingRoles: ["reviewrouter"],
      // Observed, not asserted: every role-level setting present in the
      // disposable cluster, so a setting on a creating role would be caught.
      roleSettings: read(
        db,
        `SET search_path = pg_catalog, public;
         SELECT COALESCE(jsonb_agg(jsonb_build_object('role',COALESCE(r.rolname,'*'),
           'setting',s.setconfig::text,'value','')),'[]'::jsonb)
         FROM pg_db_role_setting s LEFT JOIN pg_roles r ON r.oid=s.setrole;`,
        "postgres",
      ),
      // Observed SECURITY DEFINER routines of the 89 baseline. The reviewed
      // bodies genuinely contain such routines; none of them creates objects.
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
    };
    const input = {
      admission,
      ledger: baselineLedger,
      originalMembership,
      baselineCatalog,
      defaultAcl: baselineDefaultAcl,
      creatorEvidence,
      gate,
    };
    return {
      input,
      baselineObjectAcl: objectAcl(db),
      built: renderHistorical89InPlaceTransaction(input as never),
    };
  };
  type Plan = ReturnType<typeof plan>;
  const rolledBack = (db: string, p: Plan) => {
    expect(ledger(db)).toEqual(p.input.ledger);
    expect(catalog(db)).toEqual(p.input.baselineCatalog);
    expect(defaultAcl(db)).toEqual(p.input.defaultAcl);
    expect(objectAcl(db)).toEqual(p.baselineObjectAcl);
    expect(membership(db)).toEqual([originalMembership]);
    expect(custody(db)).toEqual({ ...p.input.gate, authorityProbeCount: 0 });
    expect(
      pg.query(
        db,
        "SELECT to_regprocedure('public.reviewrouter_managed_retained_ledger_guard()') IS NULL",
      ),
    ).toBe("t");
  };
  const rehearse = (db: string, p: Plan) => {
    const expected = read(
      db,
      p.built.sql + renderManagedCatalogSql + "\nROLLBACK;",
    );
    return { expected, digest: renderManagedEvidenceDigest(expected) };
  };

  beforeAll(async () => {
    await pg.start();
    ({ originalMembership } = await prepareHistorical89Fixture(
      pg,
      "historical89",
      seed,
    ));
    expect(inspectHistorical89InPlaceLedger(ledger("historical89")).count).toBe(
      89,
    );
    // The template is an AUTHENTIC guardless 89: no retained guard was ever
    // installed, and its manifest is the reviewed 89 baseline.
    expect(
      inspectHistorical89InPlaceLedger(ledger("historical89")).manifest,
    ).toBe(phase.baselineManifest);
    expect(
      pg.query(
        "historical89",
        "SELECT count(*) FROM pg_proc WHERE proname='reviewrouter_managed_retained_ledger_guard'",
      ),
    ).toBe("0");
    expect(defaultAcl("historical89").rows).toHaveLength(4);
  }, 240_000);
  afterAll(() => pg.cleanup());

  it("applies all seven bodies atomically, verifies92 in transaction and keeps the original89 ledger byte-identical", () => {
    const db = clone();
    const p = plan(db);
    const { expected, digest } = rehearse(db, p);
    pg.query(
      db,
      p.built.sql +
        renderHistorical89InPlaceCatalogCheck(expected, digest) +
        "\nCOMMIT;",
    );
    const terminal = ledger(db);
    expect(inspectHistorical89InPlaceLedger(terminal).count).toBe(96);
    expect(inspectHistorical89InPlaceLedger(terminal).manifest).toBe(
      phase.targetManifest,
    );
    // Every original row survives unchanged: ids, timestamps, checksums.
    expect(terminal.slice(0, 89)).toEqual(p.input.ledger);
    // Populated data really transformed, including workspace-transfer effects.
    expect(
      read(
        db,
        `SELECT jsonb_agg(jsonb_build_array(id,"attemptId",revision,"installationId","workspaceId",status,"pullRequestUrl","errorMessage","pullRequestHeadSha") ORDER BY id) FROM "WorkflowProvisioning"`,
      ),
    ).toEqual([
      ["c", "c", 0, "installation", "new", "not_started", null, null, null],
      [
        "private",
        "private",
        0,
        "installation",
        "new",
        "configured",
        null,
        null,
        null,
      ],
    ]);
    expect(
      pg.query(
        db,
        'SELECT sum("inventoryGeneration") FROM "RepositoryConnection"',
      ),
    ).toBe("0");
    expect(
      pg.query(
        db,
        "SELECT nextval('public.\"RepositoryInventoryGeneration\"')",
      ),
    ).toBe("1");
    expect(() =>
      pg.query(
        db,
        `INSERT INTO "WorkflowProvisioning" (id,"attemptId","workspaceId","repositoryId",branch,"workflowPath","actionVersion","updatedAt") VALUES ('duplicate','duplicate','new','repository','duplicate','test.yml','v1',now())`,
      ),
    ).toThrow("WorkflowProvisioning_repositoryId_key");
    // Exact ACL effects: reviewed created objects and exactly two transfers.
    const delta = assertHistorical89InPlaceAclDelta({
      baseline: p.baselineObjectAcl,
      terminal: objectAcl(db),
      creators: p.built.creators,
    } as never);
    expect(delta.created.length).toBeGreaterThan(0);
    expect(delta.ownerTransfers.map((row) => row.identity)).toEqual([
      'public."CodexOAuthSecretNamespace"',
      "public.codex_oauth_secret_namespace_tombstone_guard()",
    ]);
    // Provider default ACLs are untouched, the gate is the same closed gate and
    // the temporary self-grant is gone.
    expect(defaultAcl(db)).toEqual(p.input.defaultAcl);
    expect(gateOf(db)).toEqual(p.input.gate);
    expect(membership(db)).toEqual([originalMembership]);
    expect(() =>
      pg.query(db, "SET ROLE reviewrouter_release_schema_owner"),
    ).toThrow("permission denied");
    expect(() =>
      pg.query(db, 'SELECT * FROM "CodexOAuthSecretNamespace"'),
    ).toThrow("permission denied");
    // Applying schema never opens the pool.
    expect(
      pg.query(
        db,
        `SELECT status FROM "HostedCodexRuntimeGate" WHERE id='global'`,
      ),
    ).toBe("closed");
    // A committed operation cannot be rebuilt from its own terminal state.
    expect(() =>
      renderHistorical89InPlaceTransaction({
        ...p.input,
        ledger: terminal,
      } as never),
    ).toThrow("committed_requires_reconciliation");
    expect(
      classifyHistorical89InPlaceOutcome({
        admission: p.input.admission,
        ledger: terminal,
        backendState: "terminated",
        terminalCatalog: catalog(db),
        reviewedCatalogDigest: digest,
        gate: gateOf(db),
        memberships: membership(db),
        originalMembership,
        aclDelta: delta,
      } as never),
    ).toMatchObject({ status: "committed-candidate", replay: false });
  }, 180_000);

  it("refuses a database that is not authentically guardless89", () => {
    const db = clone();
    const p = plan(db);
    const guard = renderRetainedLedgerGuard({
      operationId: randomUUID(),
      implementationSha: "a".repeat(40),
      custodyDigest: renderManagedEvidenceDigest(p.input.ledger),
    });
    // pg_auth_members is a CLUSTER-wide catalog, so no role membership is
    // granted here: installing the guard only needs ownership of the ledger
    // table and of schema public, both of which reviewrouter already has.
    pg.query(
      db,
      `BEGIN; ${renderManagedCoordinatorExclusionSql} ${guard.installSql} COMMIT;`,
    );
    try {
      expect(() => pg.query(db, p.built.sql + "\nCOMMIT;")).toThrow(
        "historical89_unexpected_retained_custody",
      );
      expect(inspectHistorical89InPlaceLedger(ledger(db)).count).toBe(89);
      expect(ledger(db)).toEqual(p.input.ledger);
    } finally {
      pg.query(
        db,
        `BEGIN; ${renderManagedCoordinatorExclusionSql}
         DROP TRIGGER reviewrouter_managed_retained_ledger_guard ON public._prisma_migrations;
         DROP FUNCTION public.reviewrouter_managed_retained_ledger_guard(); COMMIT;`,
      );
    }
  }, 120_000);

  it.each([
    "historical89-body-1-complete",
    "historical89-body-2-complete",
    "historical89-body-3-complete",
    "historical89-interim92-verified",
    "historical89-body-4-complete",
    "historical89-body-5-complete",
    "historical89-body-6-complete",
    "historical89-body-7-complete",
    "historical89-membership-cleanup-complete",
  ])(
    "rolls the whole operation back to the original89 after %s",
    (marker) => {
      const db = clone();
      const p = plan(db);
      const at = p.built.sql.indexOf(`-- ${marker}`);
      expect(at).toBeGreaterThan(0);
      const partial = p.built.sql.slice(0, at + marker.length + 3);
      expect(() => pg.query(db, partial + "\nSELECT 1/0;\nCOMMIT;")).toThrow(
        "division by zero",
      );
      rolledBack(db, p);
    },
    120_000,
  );

  it.each([
    "reviewrouter_api",
    "reviewrouter_release_migration",
    "reviewrouter_comment_token_custody",
  ])(
    "rejects a reconnected idle %s backend and rolls back the already applied bodies",
    async (role) => {
      const db = clone();
      const p = plan(db);
      const observer = pg.session(db, role);
      observer.write("SELECT 1;\n\\echo observer-ready\n");
      try {
        await waitFor(() => observer.stdout().includes("observer-ready"));
        expect(() => pg.query(db, p.built.sql + "\nCOMMIT;")).toThrow(
          "workflow_provisioning_writer_quiescence_required",
        );
      } finally {
        await observer.terminateAndWait();
      }
      // The failure happens in the fourth body, after the first three already
      // applied inside this transaction. One transaction means 89, not 92.
      rolledBack(db, p);
    },
    120_000,
  );

  it("rejects a concurrent coordinator and a live Prisma engine lock", async () => {
    const db = clone();
    const p = plan(db);
    const canonical = pg.session(db);
    canonical.write(
      "SELECT pg_advisory_lock(1381126735,1129271120);\n\\echo canonical-held\n",
    );
    try {
      await waitFor(() => canonical.stdout().includes("canonical-held"));
      expect(() => pg.query(db, p.built.sql + "\nCOMMIT;")).toThrow(
        "lock timeout",
      );
    } finally {
      await canonical.terminateAndWait();
    }
    const prisma = pg.session(db);
    prisma.write("SELECT pg_advisory_lock(72707369);\n\\echo prisma-held\n");
    try {
      await waitFor(() => prisma.stdout().includes("prisma-held"));
      expect(() => pg.query(db, p.built.sql + "\nCOMMIT;")).toThrow(
        "render_managed_prisma_engine_active",
      );
    } finally {
      await prisma.terminateAndWait();
    }
    rolledBack(db, p);
  }, 120_000);

  it("rejects baseline drift observed after planning", () => {
    const db = clone();
    const p = plan(db);
    pg.query(db, "CREATE TABLE public.historical89_drift_probe (id integer)");
    try {
      expect(() => pg.query(db, p.built.sql + "\nCOMMIT;")).toThrow(
        "historical89_baseline_changed",
      );
    } finally {
      pg.query(db, "DROP TABLE public.historical89_drift_probe");
    }
    rolledBack(db, p);
  }, 120_000);

  it("observes precommit backend death and never infers a commit from a missing response", async () => {
    const db = clone();
    const p = plan(db);
    const session = pg.session(db);
    try {
      session.write(
        p.built.sql + "\nSELECT 'backend:'||pg_backend_pid();\n\\echo ready\n",
      );
      await waitFor(() => {
        if (session.closedResult()) throw new Error(session.stderr());
        return session.stdout().includes("ready");
      });
      const pid = session.stdout().match(/backend:(\d+)/u)![1];
      expect(
        pg.query(db, `SELECT pg_terminate_backend(${pid})`, "postgres"),
      ).toBe("t");
      session.end("SELECT 1;\n");
      await session.result;
      await waitFor(
        () =>
          pg.query(
            db,
            `SELECT count(*) FROM pg_stat_activity WHERE pid=${pid}`,
            "postgres",
          ) === "0",
      );
    } finally {
      await session.terminateAndWait();
    }
    rolledBack(db, p);
    const evidence = {
      admission: p.input.admission,
      ledger: ledger(db),
      backendState: "terminated",
      rollbackConfirmed: true,
      terminalCatalog: catalog(db),
      reviewedCatalogDigest: p.input.admission.catalogDigest,
      gate: gateOf(db),
      memberships: membership(db),
      originalMembership,
      aclDelta: undefined,
    };
    expect(classifyHistorical89InPlaceOutcome(evidence as never)).toMatchObject(
      {
        status: "uncommitted-candidate",
        replay: false,
        requiresOperationBoundReceipt: true,
      },
    );
    expect(
      classifyHistorical89InPlaceOutcome({
        ...evidence,
        backendState: "unknown",
      } as never),
    ).toEqual({ status: "hold-closed", replay: false });
    expect(
      classifyHistorical89InPlaceOutcome({
        ...evidence,
        rollbackConfirmed: false,
      } as never),
    ).toEqual({ status: "hold-closed", replay: false });
  }, 120_000);

  it("loses the actual COMMIT response and reconciles96 without replay", async () => {
    const db = clone();
    const p = plan(db);
    const { expected, digest } = rehearse(db, p);
    const loss = await pg.loseCommitResponse(db);
    try {
      loss.client.write(
        p.built.sql +
          renderHistorical89InPlaceCatalogCheck(expected, digest) +
          "\nSELECT 'backend:'||pg_backend_pid();\n\\echo ready\n",
      );
      await waitFor(() => {
        if (loss.client.closedResult()) throw new Error(loss.client.stderr());
        return loss.client.stdout().includes("ready");
      });
      const pid = loss.client.stdout().match(/backend:(\d+)/u)![1];
      loss.client.end("COMMIT;\n");
      await loss.client.result;
      expect(loss.committedResponseDropped()).toBe(true);
      await waitFor(
        () =>
          pg.query(
            db,
            `SELECT count(*) FROM pg_stat_activity WHERE pid=${pid}`,
            "postgres",
          ) === "0",
      );
      const terminal = ledger(db);
      expect(inspectHistorical89InPlaceLedger(terminal).count).toBe(96);
      expect(terminal.slice(0, 89)).toEqual(p.input.ledger);
      const delta = assertHistorical89InPlaceAclDelta({
        baseline: p.baselineObjectAcl,
        terminal: objectAcl(db),
        creators: p.built.creators,
      } as never);
      const evidence = {
        admission: p.input.admission,
        ledger: terminal,
        backendState: "terminated",
        terminalCatalog: catalog(db),
        reviewedCatalogDigest: digest,
        gate: gateOf(db),
        memberships: membership(db),
        originalMembership,
        aclDelta: delta,
      };
      expect(
        classifyHistorical89InPlaceOutcome(evidence as never),
      ).toMatchObject({ status: "committed-candidate", replay: false });
      for (const change of [
        { backendState: "unknown" },
        { ledger: terminal.slice(0, 95) },
        { reviewedCatalogDigest: `sha256:${"0".repeat(64)}` },
        { aclDelta: undefined },
        {
          ledger: [{ ...terminal[0], finishedAt: null }, ...terminal.slice(1)],
        },
      ])
        expect(
          classifyHistorical89InPlaceOutcome({
            ...evidence,
            ...change,
          } as never),
        ).toEqual({ status: "hold-closed", replay: false });
    } finally {
      await loss.close();
    }
  }, 180_000);
});
