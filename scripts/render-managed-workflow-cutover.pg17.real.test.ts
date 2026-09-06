import type { ReleaseMigrationTransitionV1 } from "../packages/features/release-rollout/src/domain/release-migration-transition";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  managedPg17Fixture,
  prepareManaged92Fixture,
  waitFor,
} from "./lib/render-managed-pg17-fixture";
import {
  inspectRenderManagedWorkflowCutoverLedger,
  renderManagedWorkflowCutoverTransaction,
  renderManagedWorkflowCutoverCatalogCheck,
  renderManagedWorkflowCutoverPhase as phase,
  assertRenderManagedWorkflowCutoverTerminal,
  reconcileRenderManagedWorkflowCutover,
} from "./lib/render-managed-workflow-cutover.mjs";
import {
  renderManagedLedgerSql,
  renderManagedMembershipSql,
  renderManagedEvidenceDigest,
  renderManagedTerminalCustodySql,
  renderSchemaHandoffDefaultAclSql,
  readRenderManagedCheckoutInventory,
} from "./lib/render-schema-handoff-policy.mjs";
import { renderManagedCatalogSql } from "./lib/render-managed-catalog.mjs";
import { withDrainedTargetAuthorityPools } from "./lib/quiesced-target-authority";

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

// Required mode fails on unavailable Docker; skips are never execution proof.
(process.env.REVIEW_ROUTER_REQUIRE_HANDOFF_PG17 === "1"
  ? describe
  : describe.skip)("managed92 to96 offline PG17.10", () => {
  const pg = managedPg17Fixture();
  let originalMembership: Record<string, unknown>;
  const read = (database: string, sql: string, role = "reviewrouter") =>
    JSON.parse(pg.query(database, sql, role).split("\n").at(-1)!);
  const ledger = (db: string) => read(db, renderManagedLedgerSql);
  const custody = (db: string) =>
    read(
      db,
      renderManagedTerminalCustodySql,
      "reviewrouter_comment_token_custody",
    );
  const scope = (db: string) =>
    read(
      db,
      "SELECT public.reviewrouter_provider_scope_concurrency_status()",
      "reviewrouter_release_migration",
    );
  const capture = (db: string) => read(db, renderManagedCatalogSql);
  const clone = (db: string) =>
    pg.query(
      "postgres",
      `CREATE DATABASE ${db} TEMPLATE cutover92 OWNER reviewrouter`,
      "postgres",
    );
  const plan = (db: string) => {
    const baselineCatalog = capture(db);
    const gate = custody(db);
    delete gate.authorityProbeCount;
    // Local comparison bindings only, not authorization receipts or production
    // review roots. No production execution or routing consumes this fixture.
    const binding = {
      operationId: randomUUID(),
      targetSystemIdentifier: pg.query(
        db,
        "SELECT system_identifier FROM pg_control_system()",
        "postgres",
      ),
      predecessorReceiptSha256: renderManagedEvidenceDigest(ledger(db)),
      transitionSha256: renderManagedEvidenceDigest({ test: "transition" }),
      original92LedgerDigest: inspectRenderManagedWorkflowCutoverLedger(
        ledger(db),
      ).ledgerDigest,
      targetRecoveryWitnessSha256: renderManagedEvidenceDigest({
        database: db,
      }),
      custodyDigest: renderManagedEvidenceDigest(gate),
      externalExclusionSha256: renderManagedEvidenceDigest({
        offline: true,
        database: db,
      }),
      reviewedCatalogDigest: renderManagedEvidenceDigest(baselineCatalog),
    };
    const input = {
      ledger: ledger(db),
      originalMembership,
      baselineCatalog,
      defaultAcl: read(db, renderSchemaHandoffDefaultAclSql),
      gate,
      binding,
    };
    return { input, sql: renderManagedWorkflowCutoverTransaction(input) };
  };
  const terminal = (
    db: string,
    p: ReturnType<typeof plan>,
    expected: string,
  ) => ({
    ledger: ledger(db),
    original92: p.input.ledger,
    catalog: capture(db),
    reviewedCatalogDigest: expected,
    custody: custody(db),
    originalGate: p.input.gate,
    scopeStatus: scope(db),
    memberships: read(db, renderManagedMembershipSql),
    originalMembership,
  });
  const rolledBack = (db: string, p: ReturnType<typeof plan>) => {
    expect(ledger(db)).toEqual(p.input.ledger);
    expect(capture(db)).toEqual(p.input.baselineCatalog);
    expect(custody(db)).toEqual({ ...p.input.gate, authorityProbeCount: 0 });
    expect(scope(db)).toMatchObject({ activated: false });
  };
  beforeAll(async () => {
    await pg.start();
    ({ originalMembership } = await prepareManaged92Fixture(
      pg,
      "cutover92",
      seed,
    ));
    expect(
      inspectRenderManagedWorkflowCutoverLedger(ledger("cutover92")).count,
    ).toBe(92);
  }, 180_000);
  afterAll(() => pg.cleanup());

  it("applies four bodies as owner, preserves the complete prefix/security and checks populated effects", () => {
    const db = "cutover_success";
    clone(db);
    const p = plan(db);
    // A local rollback rehearsal supplies comparison evidence, not an approved
    // catalog. OID preservation is additionally enforced inside the SQL builder.
    const expected = read(db, p.sql + renderManagedCatalogSql + "\nROLLBACK;");
    const expectedDigest = renderManagedEvidenceDigest(expected);
    pg.query(
      db,
      p.sql +
        renderManagedWorkflowCutoverCatalogCheck(expected, expectedDigest) +
        "\nCOMMIT;",
    );
    assertRenderManagedWorkflowCutoverTerminal(terminal(db, p, expectedDigest));
    expect(ledger(db).slice(0, 92)).toEqual(p.input.ledger);
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
    for (const repositoryConnectionId of ["repository", "private-repository"]) {
      const args = JSON.stringify({
        mintId: randomUUID(),
        purpose: "initial",
        repositoryConnectionId,
        runtimeAuthzEpoch: p.input.gate.authzEpoch,
        runtimeGateRevision: p.input.gate.revision,
      });
      expect(() =>
        pg.query(
          db,
          `SELECT * FROM public.hosted_codex_mutate_comment_token_mint('prepare','${args}'::jsonb)`,
          "reviewrouter_comment_token_custody",
        ),
      ).toThrow("hosted_codex_comment_token_mint_insert_authority_invalid");
    }
    expect(() =>
      pg.query(db, "SET ROLE reviewrouter_release_schema_owner"),
    ).toThrow("permission denied");
    expect(() =>
      pg.query(db, 'SELECT * FROM "CodexOAuthSecretNamespace"'),
    ).toThrow("permission denied");
    expect(() =>
      renderManagedWorkflowCutoverTransaction({
        ...p.input,
        ledger: ledger(db),
      }),
    ).toThrow("committed_requires_reconciliation");
  }, 90_000);

  it("rejects actual unfinished, logged, duplicate and changed-prefix histories", () => {
    const db = "cutover_history";
    clone(db);
    const p = plan(db);
    for (const change of [
      "finished_at=NULL",
      "rolled_back_at=clock_timestamp()",
      "logs='disposable diagnostic'",
      `migration_name='${p.input.ledger[1].migrationName}'`,
      "id=gen_random_uuid()::text",
    ]) {
      const observed = read(
        db,
        `BEGIN; UPDATE public._prisma_migrations SET ${change}
        WHERE migration_name='${p.input.ledger[0].migrationName}'; ${renderManagedLedgerSql} ROLLBACK;`,
      );
      expect(() =>
        inspectRenderManagedWorkflowCutoverLedger(observed, p.input.ledger),
      ).toThrow();
    }
    rolledBack(db, p);
  }, 60_000);

  it.each([1, 2, 3, 4, 5])(
    "rolls back after body/cleanup %i",
    async (step) => {
      const db = `cutover_fault_${step}`;
      clone(db);
      const p = plan(db);
      const marker =
        step === 5
          ? "-- cutover-membership-cleanup-complete"
          : `-- cutover-body-${step}-complete`;
      const partial = p.sql.slice(0, p.sql.indexOf(marker) + marker.length);
      expect(() => pg.query(db, partial + "\nSELECT 1/0;\nCOMMIT;")).toThrow(
        "division by zero",
      );
      rolledBack(db, p);
    },
    60_000,
  );

  it.each(["direct", "inherited", "column"])(
    "unchanged guard rejects %s effective writer privileges",
    (mode) => {
      const db = `cutover_writer_${mode}`;
      clone(db);
      const grant =
        mode === "column"
          ? 'GRANT UPDATE ("workspaceId") ON "WorkflowProvisioning" TO reviewrouter_api;'
          : `GRANT UPDATE ON "WorkflowProvisioning" TO ${mode === "inherited" ? "cutover_inherited" : "reviewrouter_api"};`;
      pg.query(db, grant);
      if (mode === "inherited")
        pg.query(db, "GRANT cutover_inherited TO reviewrouter_api", "postgres");
      try {
        const p = plan(db);
        expect(() => pg.query(db, p.sql + "\nCOMMIT;")).toThrow(
          "workflow_provisioning_writer_quiescence_required",
        );
        rolledBack(db, p);
      } finally {
        if (mode === "inherited")
          pg.query(
            db,
            "REVOKE cutover_inherited FROM reviewrouter_api",
            "postgres",
          );
      }
    },
    60_000,
  );

  it.each([
    "reviewrouter_api",
    "reviewrouter_release_migration",
    "reviewrouter_comment_token_custody",
  ])(
    "rejects reconnected/idle %s backend until drained",
    async (role) => {
      const db = `cutover_idle_${role.replace("reviewrouter_", "")}`;
      clone(db);
      const p = plan(db);
      const observer = pg.session(db, role);
      observer.write("SELECT 1;\n\\echo observer-ready\n");
      try {
        await waitFor(() => observer.stdout().includes("observer-ready"));
        expect(() => pg.query(db, p.sql + "\nCOMMIT;")).toThrow(
          "workflow_provisioning_writer_quiescence_required",
        );
      } finally {
        await observer.terminateAndWait();
      }
      rolledBack(db, p);
    },
    60_000,
  );

  it("drains both real authority pools before the unchanged guard", async () => {
    const db = "cutover_drained";
    clone(db);
    const p = plan(db);
    const { Pool } = createRequire(import.meta.url)("pg");
    const pools = [
      "reviewrouter_release_migration",
      "reviewrouter_comment_token_custody",
    ].map(
      (user) =>
        new Pool({
          user,
          database: db,
          host: "127.0.0.1",
          ssl: false,
          stream: pg.wireStream,
          max: 1,
          connectionTimeoutMillis: 5000,
          password: () => {
            throw new Error("offline_fixture_auth_unexpected");
          },
        }),
    );
    const ended = new Set<number>();
    const disconnect = async (index: number) => {
      if (!ended.has(index)) {
        ended.add(index);
        await pools[index].end();
      }
    };
    try {
      const pids: string[] = [];
      for (const pool of pools)
        pids.push(
          String(
            (await pool.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
          ),
        );
      expect(() => pg.query(db, p.sql + "\nCOMMIT;")).toThrow(
        "workflow_provisioning_writer_quiescence_required",
      );
      await withDrainedTargetAuthorityPools(
        {
          permitInstallerPrisma: { $disconnect: () => disconnect(0) },
          targetReceiptReaderPrisma: { $disconnect: () => disconnect(1) },
        },
        async () => {
          await waitFor(
            () =>
              pg.query(
                db,
                `SELECT count(*) FROM pg_stat_activity WHERE pid IN (${pids.join(",")})`,
                "postgres",
              ) === "0",
          );
          pg.query(db, p.sql + "\nROLLBACK;");
        },
      );
    } finally {
      await Promise.all([disconnect(0), disconnect(1)]);
    }
    rolledBack(db, p);
  }, 60_000);

  it("observes precommit backend death and does not infer a commit from missing response", async () => {
    const db = "cutover_death";
    clone(db);
    const p = plan(db);
    const session = pg.session(db);
    try {
      session.write(
        p.sql + "\nSELECT 'backend:'||pg_backend_pid();\n\\echo ready\n",
      );
      await waitFor(() => {
        if (session.closedResult()) throw new Error(session.stderr());
        return session.stdout().includes("ready");
      });
      const pid = session.stdout().match(/backend:(\d+)/u)![1];
      expect(() =>
        pg.query(
          db,
          `BEGIN; SET LOCAL lock_timeout='100ms';
        SELECT 1 FROM public."HostedCodexRuntimeGate" WHERE id='global' FOR UPDATE; ROLLBACK;`,
          "postgres",
        ),
      ).toThrow("lock timeout");
      expect(
        pg.query(db, `SELECT pg_terminate_backend(${pid})`, "postgres"),
      ).toBe("t");
      session.end("SELECT 1;\n");
      await session.result;
      expect(
        pg.query(
          db,
          `SELECT count(*) FROM pg_stat_activity WHERE pid=${pid}`,
          "postgres",
        ),
      ).toBe("0");
    } finally {
      await session.terminateAndWait();
    }
    rolledBack(db, p);
    const evidence = {
      original92: p.input.ledger,
      ledger: ledger(db),
      binding: p.input.binding,
      durableBinding: p.input.binding,
      backendState: "terminated",
      rollbackConfirmed: true,
      baselineCatalog: capture(db),
      terminal: terminal(db, p, renderManagedEvidenceDigest(capture(db))),
    };
    expect(reconcileRenderManagedWorkflowCutover(evidence)).toMatchObject({
      status: "uncommitted-candidate",
      replay: false,
    });
    expect(
      reconcileRenderManagedWorkflowCutover({
        ...evidence,
        backendState: "unknown",
      }),
    ).toMatchObject({ status: "hold-closed" });
    expect(
      reconcileRenderManagedWorkflowCutover({
        ...evidence,
        durableBinding: { ...p.input.binding, operationId: randomUUID() },
      }),
    ).toMatchObject({ status: "hold-closed" });
  }, 60_000);

  it("loses the actual COMMIT response, verifies96 without DDL replay, holds without authority provenance", async () => {
    const db = "cutover_response_loss";
    clone(db);
    const p = plan(db);
    const expectedCatalog = read(
      db,
      p.sql + renderManagedCatalogSql + "\nROLLBACK;",
    );
    const expected = renderManagedEvidenceDigest(expectedCatalog);
    // Test-local transition and permit observations, not authorization receipts.
    const unsigned = {
      schemaVersion: 1 as const,
      commitSha: phase.sourceCommit,
      releaseImageDigest: renderManagedEvidenceDigest({
        fixture: "offline-PG17.10",
      }),
      migrationArtifactDigest: phase.migrationArtifactDigest,
      orderedMigrationEntries: readRenderManagedCheckoutInventory()
        .slice(92)
        .map((row) => ({
          migrationName: row.migrationName,
          migrationSqlSha256: row.checksum,
        })),
      preManifestIdentity: phase.baselineManifest,
      postManifestIdentity: phase.targetManifest,
      orderedPendingEntriesSha256: phase.orderedPendingEntriesSha256,
      migrationBundleSha256: phase.migrationBundleSha256,
      allowedResumeManifestIdentities: [
        phase.baselineManifest,
        phase.targetManifest,
      ],
      postCatalogDigest: expected,
    };
    const transition: ReleaseMigrationTransitionV1 = {
      ...unsigned,
      transitionSha256: renderManagedEvidenceDigest(unsigned),
    };
    const permit = {
      rolloutId: p.input.binding.operationId,
      targetSystemIdentifier: p.input.binding.targetSystemIdentifier,
      targetRecoveryWitnessSha256: p.input.binding.targetRecoveryWitnessSha256,
      transitionSha256: transition.transitionSha256,
      expectedPreviousReceiptSha256: p.input.binding.predecessorReceiptSha256,
      sourceLegacyAmbiguity: {
        inventorySha256: renderManagedEvidenceDigest(p.input.ledger),
      },
      eligibilityCutoff: "2026-09-06T00:00:00.000Z",
      epoch: 1,
      nonce: randomUUID(),
    };
    const observation = {
      transitionSha256: transition.transitionSha256,
      migrationArtifactDigest: phase.migrationArtifactDigest,
      migrationBundleSha256: phase.migrationBundleSha256,
      preManifestIdentity: phase.baselineManifest,
      postManifestIdentity: phase.targetManifest,
      postCatalogDigest: expected,
      permitEpoch: permit.epoch,
      permitNonce: permit.nonce,
      targetSystemIdentifier: permit.targetSystemIdentifier,
      targetRecoveryWitnessSha256: permit.targetRecoveryWitnessSha256,
      sourceLegacyAmbiguitySha256: permit.sourceLegacyAmbiguity.inventorySha256,
      eligibilityCutoff: permit.eligibilityCutoff,
    };
    p.input.binding.transitionSha256 = transition.transitionSha256;
    p.sql = renderManagedWorkflowCutoverTransaction(p.input);
    const loss = await pg.loseCommitResponse(db);
    try {
      loss.client.write(
        p.sql +
          renderManagedWorkflowCutoverCatalogCheck(expectedCatalog, expected) +
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
      assertRenderManagedWorkflowCutoverTerminal(terminal(db, p, expected));
      const evidence = {
        original92: p.input.ledger,
        ledger: ledger(db),
        binding: p.input.binding,
        durableBinding: p.input.binding,
        backendState: "terminated",
        transition,
        permit,
        observation,
        terminal: terminal(db, p, expected),
      };
      expect(reconcileRenderManagedWorkflowCutover(evidence)).toMatchObject({
        status: "committed-candidate",
        replay: false,
      });
      for (const change of [
        { durableBinding: null },
        { backendState: "unknown" },
        { observation: { ...observation, permitNonce: randomUUID() } },
        { ledger: ledger(db).slice(0, 95) },
        {
          ledger: [
            { ...ledger(db)[0], finishedAt: null },
            ...ledger(db).slice(1),
          ],
        },
      ])
        expect(
          reconcileRenderManagedWorkflowCutover({ ...evidence, ...change }),
        ).toMatchObject({ status: "hold-closed", replay: false });
      expect(
        reconcileRenderManagedWorkflowCutover({
          original92: p.input.ledger,
          ledger: ledger(db),
          binding: p.input.binding,
          backendState: "terminated",
        }),
      ).toEqual({ status: "hold-closed", replay: false });
    } finally {
      await loss.close();
    }
  }, 90_000);
});
