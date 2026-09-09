import {
  renderHistorical89PreparationPrepare,
  renderHistorical89PreparationReadSql,
  renderHistorical89PreparationService,
  renderHistorical89PreparationObserve,
  renderHistorical89PreparationFinalize,
} from "./lib/render-historical89-preparation-custody.mjs";
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
} from "./lib/render-schema-handoff-policy.mjs";
import { renderManagedCatalogSql } from "./lib/render-managed-catalog.mjs";
import { renderManagedCoordinatorExclusionSql } from "./lib/render-retained-exclusion.mjs";
import { renderManagedRuntimeGateSql } from "./lib/render-managed-workflow-cutover.mjs";
import {
  historical89StableReviewedCatalog,
  assertHistorical89AdmissionIdentity,
  readHistorical89PendingIdentities,
  renderHistorical89AdmissionPhase as phase,
  renderHistorical89DefaultAclSql,
  renderHistorical89ObjectAclSql,
  renderHistorical89PendingDigest,
} from "./lib/render-historical89-admission.mjs";
import {
  assertHistorical89InPlaceAclDelta,
  inspectHistorical89InPlaceLedger,
  renderHistorical89InPlaceCatalogCheck,
  renderHistorical89InPlaceTransaction,
} from "./lib/render-historical89-inplace-transaction.mjs";
import {
  assertManagedOperationEffectReceipt,
  renderManagedOperationAdvanceEpochSql,
  renderManagedOperationCurrentPermitSql,
  renderManagedOperationCustodyBootstrap,
  renderManagedOperationCustodyProjectionSql,
  renderManagedOperationRecordEffectSql,
} from "./lib/render-managed-operation-custody.mjs";
import {
  renderHistorical89AdmissionRestrictionSql,
  renderHistorical89ConnectAclSql,
  renderHistorical89SessionDrainSql,
} from "./lib/render-historical89-execution-boundary.mjs";
import {
  historical89InPlaceCustodyBinding,
  planHistorical89InPlaceOperation,
  reconcileHistorical89InPlaceOperation,
  renderHistorical89InPlacePreflightSql,
} from "./lib/render-historical89-operation.mjs";

const seed = `INSERT INTO "Workspace" (id,slug,name,"updatedAt") VALUES ('old','old','old',now()),('new','new','new',now());
INSERT INTO "GitHubInstallation" (id,"workspaceId","githubInstallationId","accountLogin","accountType","repositorySelection","updatedAt")
VALUES ('installation','new',1,'disposable','Organization','all',now());
INSERT INTO "RepositoryConnection" (id,"workspaceId","externalRepositoryId","installationId","githubRepositoryId",owner,name,"fullName","defaultBranch",visibility,"updatedAt")
VALUES ('repository','new','1','installation',1,'disposable','test','disposable/test','main','public',now());
INSERT INTO "WorkflowProvisioning" (id,"workspaceId","repositoryId",status,branch,"workflowPath","actionVersion","updatedAt")
VALUES ('c','new','repository','configured','c','test.yml','v1','2026-01-02');`;

// The operation pins the production database NAME, so every disposable clone
// carries that exact name and is recreated from the guardless template.
const target = "review_router_dimy";
const nonceOf = () => randomUUID().replaceAll("-", "");

// Required mode fails on unavailable Docker; skips are never execution proof.
(process.env.REVIEW_ROUTER_REQUIRE_HANDOFF_PG17 === "1"
  ? describe
  : describe.skip)("historical89 operation custody, offline PG17.10", () => {
  const pg = managedPg17Fixture();
  let originalMembership: Record<string, unknown>;
  const read = (database: string, sql: string, role = "reviewrouter") =>
    JSON.parse(pg.query(database, sql, role).split("\n").at(-1)!);
  const ledger = (db: string) => read(db, renderManagedLedgerSql);
  const catalog = (db: string) => read(db, renderManagedCatalogSql);
  const defaultAcl = (db: string) => read(db, renderHistorical89DefaultAclSql);
  const objectAcl = (db: string) => read(db, renderHistorical89ObjectAclSql);
  const membership = (db: string) => read(db, renderManagedMembershipSql);
  const connectAclOf = (db: string) =>
    read(db, renderHistorical89ConnectAclSql);
  const gateOf = (db: string) =>
    read(
      db,
      `SET search_path = pg_catalog, public;\n${renderManagedRuntimeGateSql};`,
    );
  const custodyTopology = (db: string) =>
    read(db, renderManagedOperationCustodyProjectionSql);
  // Roles are cluster-wide, so a clone must also remove the previous case's
  // custody roles. Their objects and grants lived only in the dropped database.
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

  // Fixture-local evidence only. Nothing built here is a production receipt, a
  // review root or custody for any real database: the operation identity, the
  // fence and the recovery witness are all disposable values of this container.
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

  /**
   * The operator sequence, in the only order that works:
   * gate -> custody -> admission withdrawal + drain -> baseline capture ->
   * terminal-catalog rehearsal -> permit -> plan.
   */
  const prepare = (
    db: string,
    options: {
      bootstrapCustody?: boolean;
      restrictAdmission?: boolean;
      afterCustody?: (db: string) => void;
    } = {},
  ) => {
    const bootstrapCustody = options.bootstrapCustody !== false;
    const restrictAdmission = options.restrictAdmission !== false;
    // Observed through its own custody role while admission is still open.
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
    if (bootstrapCustody) pg.query(db, custody.bootstrapSql);
    // Any tampering happens BEFORE the baseline is captured, so the forged
    // custody is part of a self-consistent baseline and has to be caught by the
    // attestation rather than incidentally by baseline drift.
    options.afterCustody?.(db);
    const connectAcl = connectAclOf(db);
    if (restrictAdmission)
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
      custody,
      connectAcl,
      shared,
      identityDigest: assertHistorical89AdmissionIdentity(admission as never),
      baselineObjectAcl: objectAcl(db),
    };
  };
  type Prepared = ReturnType<typeof prepare>;

  /** Rehearse the terminal catalog on a database that already carries custody. */
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

  // The generation is deliberately not 1: a receipt fingerprint that joined the
  // epoch and the generation in the wrong order would be indistinguishable if
  // both were the same value.
  const planned = (
    prepared: Prepared,
    generation = 3,
    // Reusing an existing epoch/nonce is what makes a single coordinate the
    // ONLY difference between a plan and the permit the database holds.
    reuse?: { epoch: number; nonce: string },
  ) => {
    const { expected, digest } = rehearse(prepared);
    const coordinates = {
      epoch: reuse?.epoch ?? 1,
      nonce: reuse?.nonce ?? nonceOf(),
      generation,
    };
    const plan = planHistorical89InPlaceOperation({
      ...prepared.shared,
      connectAcl: prepared.connectAcl,
      preconditions: preconditionsOf(prepared.db, prepared.connectAcl),
      coordinates,
      reviewedTerminalCatalog: expected,
      reviewedTerminalCatalogDigest: digest,
      terminalCatalogProvenance: "disposable-rehearsal",
    } as never);
    return { plan, expected, digest, coordinates };
  };

  const openPermit = (prepared: Prepared, plan: { openPermitSql: string }) =>
    JSON.parse(pg.query(prepared.db, plan.openPermitSql));

  const readReceipt = (prepared: Prepared, plan: { effectReadSql: string }) => {
    const raw = pg.query(
      prepared.db,
      plan.effectReadSql,
      "reviewrouter_operation_custody_reader",
    );
    return raw === "null" ? null : JSON.parse(raw);
  };

  const rolledBackTo89 = (prepared: Prepared) => {
    expect(ledger(prepared.db)).toEqual(prepared.shared.ledger);
    expect(catalog(prepared.db)).toEqual(prepared.shared.baselineCatalog);
    expect(defaultAcl(prepared.db)).toEqual(prepared.shared.defaultAcl);
    expect(objectAcl(prepared.db)).toEqual(prepared.baselineObjectAcl);
    expect(membership(prepared.db)).toEqual([originalMembership]);
    expect(gateOf(prepared.db)).toEqual(prepared.shared.gate);
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
  }, 240_000);
  afterAll(() => pg.cleanup());

  it("validates real PG17 custody function definitions before stable comparison", () => {
    const prepared = prepare(clone());
    expect(() =>
      historical89StableReviewedCatalog(
        prepared.shared.baselineCatalog,
        prepared.shared.admission,
      ),
    ).not.toThrow();
    expect(() =>
      historical89StableReviewedCatalog(prepared.shared.baselineCatalog, {
        ...prepared.shared.admission,
        operationId: randomUUID(),
      }),
    ).toThrow("review_custody_definition");
  });

  it("reaches96 under custody and records one protected operation-bound receipt", () => {
    const prepared = prepare(clone());
    const { plan, digest, coordinates } = planned(prepared);
    // The plan never claims production authorization, and names why.
    expect(plan.authorization.authorizesProductionMutation).toBe(false);
    expect(plan.authorization.blockedBy).toContain(
      "admission_qualification:independent_review_missing",
    );
    const permit = openPermit(prepared, plan);
    expect(permit).toMatchObject({
      kind: phase.kind,
      operationId: plan.operationId,
      epoch: "1",
      state: "open",
      admissionIdentityDigest: prepared.identityDigest,
      terminalCatalogDigest: digest,
    });
    pg.query(prepared.db, plan.transactionSql);
    const terminal = ledger(prepared.db);
    expect(inspectHistorical89InPlaceLedger(terminal).count).toBe(96);
    expect(inspectHistorical89InPlaceLedger(terminal).manifest).toBe(
      phase.targetManifest,
    );
    expect(terminal.slice(0, 89)).toEqual(prepared.shared.ledger);
    // Applying schema never opens the gate.
    expect(gateOf(prepared.db)).toEqual(prepared.shared.gate);
    // The receipt is read back through the restricted role, not reported by the
    // coordinator, and verifies against its own recomputed fingerprint.
    const receipt = readReceipt(prepared, plan);
    const verified = assertManagedOperationEffectReceipt(receipt, {
      binding: plan.binding,
      epoch: coordinates.epoch,
      nonce: coordinates.nonce,
      generation: coordinates.generation,
      terminalCatalogDigest: digest,
      admissionIdentityDigest: prepared.identityDigest,
    } as never);
    expect(verified.permitState).toBe("terminal");
    expect(verified.ledgerManifest).toBe(phase.targetManifest);
    // A second effect for the same operation is impossible, not merely unlikely.
    expect(() =>
      pg.query(
        prepared.db,
        renderManagedOperationRecordEffectSql(plan.binding, {
          ...coordinates,
          terminalCatalogDigest: digest,
          admissionIdentityDigest: prepared.identityDigest,
        } as never),
      ),
    ).toThrow("custody_effect_outside_exclusive_transaction");
    // Reconciliation of the finished operation asks for no replay.
    const delta = assertHistorical89InPlaceAclDelta({
      baseline: prepared.baselineObjectAcl,
      terminal: objectAcl(prepared.db),
      creators: plan.creators,
    } as never);
    expect(
      reconcileHistorical89InPlaceOperation({
        plan,
        backendState: "terminated",
        rollbackConfirmed: false,
        ledger: terminal,
        terminalCatalog: catalog(prepared.db),
        gate: gateOf(prepared.db),
        memberships: membership(prepared.db),
        originalMembership,
        aclDelta: delta,
        receipt,
        currentPermit: JSON.parse(
          pg.query(
            prepared.db,
            renderManagedOperationCurrentPermitSql(plan.binding),
          ),
        ),
        fenceHeld: true,
      } as never),
    ).toMatchObject({
      decision: "reconciled-without-replay",
      replay: false,
      gate: "closed",
    });
  }, 240_000);

  it("refuses missing custody and refuses a look-alike custody the owner built", () => {
    const prepared = prepare(clone(), {
      bootstrapCustody: false,
      // Admission still closes: withdrawing CONNECT admits the restricted
      // reader, so that role has to exist even when custody does not. Closing
      // admission first is what makes this a custody test and not a fleet test.
      afterCustody: (db) =>
        pg.query(
          db,
          "CREATE ROLE reviewrouter_operation_custody_reader LOGIN",
          "postgres",
        ),
    });
    const preflight = renderHistorical89InPlacePreflightSql(prepared.binding);
    const attempt = () =>
      pg.query(
        prepared.db,
        `BEGIN; ${renderManagedCoordinatorExclusionSql} ${preflight} ROLLBACK;`,
      );
    expect(attempt).toThrow("custody_attestation_failed");
    // A schema with the same name, the same routine names and the same bodies,
    // created by the coordinator itself, is exactly what a forged custody looks
    // like. Ownership, security mode and ACL are what distinguish it.
    pg.query(
      prepared.db,
      `CREATE SCHEMA release_operation_custody;
       CREATE TABLE release_operation_custody.operation_permit (operation_id uuid PRIMARY KEY);
       CREATE TABLE release_operation_custody.operation_effect_receipt (operation_id uuid PRIMARY KEY);
       CREATE FUNCTION release_operation_custody.custody_record_effect(p_request jsonb)
         RETURNS jsonb LANGUAGE plpgsql AS $forged$ BEGIN RETURN '{}'::jsonb; END $forged$;`,
    );
    expect(attempt).toThrow("custody_attestation_failed");
    expect(inspectHistorical89InPlaceLedger(ledger(prepared.db)).count).toBe(
      89,
    );
  }, 180_000);

  it("rolls the whole operation back to89 when the custody routines were tampered with", () => {
    const prepared = prepare(clone(), {
      afterCustody: (db) =>
        // The owner CAN reach its own custody by re-granting itself SET; that
        // limit is documented rather than denied. What it cannot do is make the
        // tampered custody attest, and the membership is put back so the
        // baseline stays self-consistent.
        pg.query(
          db,
          `GRANT reviewrouter_operation_custody_owner TO reviewrouter WITH INHERIT TRUE, SET TRUE;
           SET ROLE reviewrouter_operation_custody_owner;
           CREATE OR REPLACE FUNCTION release_operation_custody.custody_record_effect(p_request jsonb)
             RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
             AS $tampered$ BEGIN RETURN '{"tampered":true}'::jsonb; END $tampered$;
           RESET ROLE;
           REVOKE reviewrouter_operation_custody_owner FROM reviewrouter GRANTED BY reviewrouter RESTRICT;`,
        ),
    });
    const preflight = renderHistorical89InPlacePreflightSql(prepared.binding);
    expect(() =>
      pg.query(
        prepared.db,
        `BEGIN; ${renderManagedCoordinatorExclusionSql} ${preflight} ROLLBACK;`,
      ),
    ).toThrow("custody_attestation_failed");
    rolledBackTo89(prepared);
  }, 180_000);

  it("keeps the custody tables and routines out of the coordinator's direct reach", () => {
    const prepared = prepare(clone());
    for (const statement of [
      "SELECT * FROM release_operation_custody.operation_permit",
      "SELECT * FROM release_operation_custody.operation_effect_receipt",
      "INSERT INTO release_operation_custody.operation_effect_receipt (operation_id) VALUES (gen_random_uuid())",
    ])
      expect(() => pg.query(prepared.db, statement)).toThrow(
        "permission denied",
      );
    expect(() =>
      pg.query(
        prepared.db,
        "DROP FUNCTION release_operation_custody.custody_record_effect(jsonb)",
      ),
    ).toThrow("must be owner");
    // The restricted reader can execute exactly one routine and nothing else.
    expect(() =>
      pg.query(
        prepared.db,
        "SELECT release_operation_custody.custody_current_permit(gen_random_uuid(),false)",
        "reviewrouter_operation_custody_reader",
      ),
    ).toThrow("permission denied");
    const topology = custodyTopology(prepared.db);
    expect(topology.roles).toHaveLength(2);
    expect(
      topology.routines.filter(
        (row: { securityDefiner: boolean }) => row.securityDefiner,
      ),
    ).toHaveLength(5);
    expect(
      topology.ownerReadGrants.map((row: { identity: string }) => row.identity),
    ).toEqual(['public."HostedCodexRuntimeGate"', "public._prisma_migrations"]);
  }, 180_000);

  it("refuses an absent permit and each stale coordinate on its own, and rolls back to89", () => {
    const prepared = prepare(clone());
    const { plan, coordinates } = planned(prepared);
    // No permit at all: the operation cannot start.
    expect(() => pg.query(prepared.db, plan.transactionSql)).toThrow(
      "custody_permit_absent",
    );
    rolledBackTo89(prepared);
    openPermit(prepared, plan);
    // Each coordinate is isolated: this plan carries the permit's OWN epoch and
    // nonce and differs only in the generation, so nothing but the generation
    // comparison can refuse it.
    const otherGeneration = planned(prepared, 7, coordinates);
    expect(() =>
      pg.query(prepared.db, otherGeneration.plan.transactionSql),
    ).toThrow("historical89_permit_stale");
    rolledBackTo89(prepared);
    // A concurrent coordinator advances the epoch through the same CAS.
    const advanced = JSON.parse(
      pg.query(
        prepared.db,
        renderManagedOperationAdvanceEpochSql(plan.binding, {
          expectedEpoch: coordinates.epoch,
          expectedNonce: coordinates.nonce,
          nextNonce: nonceOf(),
        } as never),
      ),
    );
    expect(advanced.epoch).toBe("2");
    expect(() => pg.query(prepared.db, plan.transactionSql)).toThrow(
      "historical89_permit_stale",
    );
    rolledBackTo89(prepared);
    // Same isolation for the nonce: the advanced epoch with the RETIRED nonce.
    const retiredNonce = planned(prepared, coordinates.generation, {
      epoch: Number(advanced.epoch),
      nonce: coordinates.nonce,
    });
    expect(() =>
      pg.query(prepared.db, retiredNonce.plan.transactionSql),
    ).toThrow("historical89_permit_stale");
    rolledBackTo89(prepared);
    // And the rotated nonce at the advanced epoch is accepted, so the three
    // cases above are refusals of a stale coordinate, not of every plan.
    const current = planned(prepared, coordinates.generation, {
      epoch: Number(advanced.epoch),
      nonce: advanced.nonce,
    });
    pg.query(prepared.db, current.plan.transactionSql);
    expect(inspectHistorical89InPlaceLedger(ledger(prepared.db)).count).toBe(
      96,
    );
  }, 300_000);

  it("refuses an open admission and a reconnected observer, and rolls back to89", async () => {
    const open = prepare(clone(), {
      restrictAdmission: false,
      afterCustody: () => {},
    });
    const preflight = (prepared: Prepared) =>
      pg.query(
        prepared.db,
        `BEGIN; ${renderManagedCoordinatorExclusionSql} ${renderHistorical89InPlacePreflightSql(prepared.binding)} ROLLBACK;`,
      );
    // Every login role still holds CONNECT through PUBLIC until it is withdrawn.
    expect(() => preflight(open)).toThrow("historical89_admission_open");
    pg.query(
      open.db,
      renderHistorical89AdmissionRestrictionSql(open.connectAcl),
    );
    expect(() => preflight(open)).not.toThrow();

    const prepared = prepare(clone());
    const { plan } = planned(prepared);
    openPermit(prepared, plan);
    // The one role still admitted under the fence is an OBSERVER that owns
    // nothing and writes nothing. It is still enough to abort the operation.
    const observer = pg.session(
      prepared.db,
      "reviewrouter_operation_custody_reader",
    );
    observer.write("SELECT 1;\n\\echo observer-ready\n");
    try {
      await waitFor(() => observer.stdout().includes("observer-ready"));
      expect(() => pg.query(prepared.db, plan.transactionSql)).toThrow(
        "historical89_fleet_not_quiesced",
      );
    } finally {
      await observer.terminateAndWait();
    }
    rolledBackTo89(prepared);
    // With the observer gone the same plan completes.
    pg.query(prepared.db, plan.transactionSql);
    expect(inspectHistorical89InPlaceLedger(ledger(prepared.db)).count).toBe(
      96,
    );
  }, 300_000);

  it("re-derives its own postconditions and refuses an effect outside the exclusive transaction", () => {
    const prepared = prepare(clone());
    const { plan, expected, digest, coordinates } = planned(prepared);
    openPermit(prepared, plan);
    const effectSql = renderManagedOperationRecordEffectSql(plan.binding, {
      ...coordinates,
      terminalCatalogDigest: digest,
      admissionIdentityDigest: prepared.identityDigest,
    } as never);
    // Without the coordinator's own exclusion, no receipt exists at all.
    expect(() => pg.query(prepared.db, effectSql)).toThrow(
      "custody_effect_outside_exclusive_transaction",
    );
    // With the exclusion but a ledger still at89, the routine refuses: it reads
    // the ledger itself instead of believing the caller.
    expect(() =>
      pg.query(
        prepared.db,
        `BEGIN; ${renderManagedCoordinatorExclusionSql} ${effectSql} COMMIT;`,
      ),
    ).toThrow("custody_effect_postcondition_ledger");
    // Reach96 through the reviewed transaction WITHOUT its receipt, then open
    // the gate. Schema completion still cannot produce an effect receipt.
    const built = renderHistorical89InPlaceTransaction({
      ...prepared.shared,
      preflightSql: renderHistorical89InPlacePreflightSql(
        plan.binding,
        plan.coordinates,
      ),
    } as never);
    pg.query(
      prepared.db,
      `${built.sql}${renderHistorical89InPlaceCatalogCheck(expected, digest)}\nCOMMIT;`,
    );
    expect(inspectHistorical89InPlaceLedger(ledger(prepared.db)).count).toBe(
      96,
    );
    // The gate branch of the protected writer stays defence in depth here on
    // purpose. The published 000081/000083 guards refuse both an activation
    // without a complete closure and any id transition, so a valid96 state with
    // an open or missing gate is unreachable in this suite - which is a
    // stronger fact than a synthetic trigger of that branch would be. Both
    // reachable branches below are exercised for real.
    expect(
      pg.query(
        prepared.db,
        `SELECT status FROM public."HostedCodexRuntimeGate" WHERE id='global'`,
      ),
    ).toBe("closed");
    // A terminal catalog other than the one fixed in the immutable permit is
    // refused even when the ledger and the gate are exactly right.
    expect(() =>
      pg.query(
        prepared.db,
        `BEGIN; ${renderManagedCoordinatorExclusionSql}
         ${renderManagedOperationRecordEffectSql(plan.binding, {
           ...coordinates,
           terminalCatalogDigest: `sha256:${"0".repeat(64)}`,
           admissionIdentityDigest: prepared.identityDigest,
         } as never)} COMMIT;`,
      ),
    ).toThrow("custody_effect_postcondition_catalog");
    // The genuine coordinates do produce exactly one receipt, and only one.
    pg.query(
      prepared.db,
      `BEGIN; ${renderManagedCoordinatorExclusionSql} ${effectSql} COMMIT;`,
    );
    expect(readReceipt(prepared, plan)).toMatchObject({
      permitState: "terminal",
    });
    expect(() =>
      pg.query(
        prepared.db,
        `BEGIN; ${renderManagedCoordinatorExclusionSql} ${effectSql} COMMIT;`,
      ),
    ).toThrow("custody_permit_stale");
  }, 300_000);

  it("restores the exact original CONNECT grants after the operation", () => {
    const prepared = prepare(clone());
    const { plan } = planned(prepared);
    openPermit(prepared, plan);
    pg.query(prepared.db, plan.transactionSql);
    const restricted = connectAclOf(prepared.db);
    expect(restricted.entries).not.toEqual(prepared.connectAcl.entries);
    pg.query(prepared.db, plan.admissionRestoreSql);
    const restored = connectAclOf(prepared.db);
    expect(restored.entries).toEqual(prepared.connectAcl.entries);
    expect(restored.connectCapableRoles).toEqual(
      prepared.connectAcl.connectCapableRoles,
    );
  }, 240_000);

  it("resumes the SAME operation after a confirmed rollback, and fences an unresolved one", async () => {
    const prepared = prepare(clone());
    const { plan } = planned(prepared);
    openPermit(prepared, plan);
    const withoutCommit = plan.transactionSql.slice(
      0,
      plan.transactionSql.lastIndexOf("COMMIT;"),
    );
    const session = pg.session(prepared.db);
    try {
      session.write(
        `${withoutCommit}\nSELECT 'backend:'||pg_backend_pid();\n\\echo ready\n`,
      );
      await waitFor(() => {
        if (session.closedResult()) throw new Error(session.stderr());
        return session.stdout().includes("ready");
      });
      const pid = session.stdout().match(/backend:(\d+)/u)![1];
      expect(
        pg.query(
          prepared.db,
          `SELECT pg_terminate_backend(${pid})`,
          "postgres",
        ),
      ).toBe("t");
      session.end("SELECT 1;\n");
      await session.result;
      await waitFor(
        () =>
          pg.query(
            prepared.db,
            `SELECT count(*) FROM pg_stat_activity WHERE pid=${pid}`,
            "postgres",
          ) === "0",
      );
    } finally {
      await session.terminateAndWait();
    }
    rolledBackTo89(prepared);
    expect(readReceipt(prepared, plan)).toBeNull();
    const evidence = {
      plan,
      backendState: "terminated",
      rollbackConfirmed: true,
      ledger: ledger(prepared.db),
      terminalCatalog: catalog(prepared.db),
      gate: gateOf(prepared.db),
      memberships: membership(prepared.db),
      originalMembership,
      aclDelta: undefined,
      receipt: null,
      currentPermit: JSON.parse(
        pg.query(
          prepared.db,
          renderManagedOperationCurrentPermitSql(plan.binding),
        ),
      ),
      fenceHeld: true,
    };
    expect(
      reconcileHistorical89InPlaceOperation(evidence as never),
    ).toMatchObject({
      decision: "resume-same-operation",
      replay: false,
      continueOperation: true,
      requiresPermitEpochAdvance: true,
    });
    for (const change of [
      { fenceHeld: false },
      { backendState: "unknown" },
      { rollbackConfirmed: false },
      { receipt: { forged: true } },
    ])
      expect(
        reconcileHistorical89InPlaceOperation({
          ...evidence,
          ...change,
        } as never),
      ).toMatchObject({ decision: "fenced", replay: false });
  }, 300_000);

  it("loses the actual COMMIT response and reconciles96 from the protected receipt without replay", async () => {
    const prepared = prepare(clone());
    const { plan, digest, coordinates } = planned(prepared);
    openPermit(prepared, plan);
    const withoutCommit = plan.transactionSql.slice(
      0,
      plan.transactionSql.lastIndexOf("COMMIT;"),
    );
    const loss = await pg.loseCommitResponse(prepared.db);
    try {
      loss.client.write(
        `${withoutCommit}\nSELECT 'backend:'||pg_backend_pid();\n\\echo ready\n`,
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
            prepared.db,
            `SELECT count(*) FROM pg_stat_activity WHERE pid=${pid}`,
            "postgres",
          ) === "0",
      );
    } finally {
      await loss.close();
    }
    const terminal = ledger(prepared.db);
    expect(inspectHistorical89InPlaceLedger(terminal).count).toBe(96);
    expect(terminal.slice(0, 89)).toEqual(prepared.shared.ledger);
    // The receipt is read on a FRESH restricted connection after the original
    // backend is provably gone. That order is the whole point.
    const receipt = readReceipt(prepared, plan);
    expect(
      assertManagedOperationEffectReceipt(receipt, {
        binding: plan.binding,
        epoch: coordinates.epoch,
        nonce: coordinates.nonce,
        generation: coordinates.generation,
        terminalCatalogDigest: digest,
        admissionIdentityDigest: prepared.identityDigest,
      } as never).permitState,
    ).toBe("terminal");
    const evidence = {
      plan,
      backendState: "terminated",
      rollbackConfirmed: false,
      ledger: terminal,
      terminalCatalog: catalog(prepared.db),
      gate: gateOf(prepared.db),
      memberships: membership(prepared.db),
      originalMembership,
      aclDelta: assertHistorical89InPlaceAclDelta({
        baseline: prepared.baselineObjectAcl,
        terminal: objectAcl(prepared.db),
        creators: plan.creators,
      } as never),
      receipt,
      currentPermit: JSON.parse(
        pg.query(
          prepared.db,
          renderManagedOperationCurrentPermitSql(plan.binding),
        ),
      ),
      fenceHeld: true,
    };
    expect(
      reconcileHistorical89InPlaceOperation(evidence as never),
    ).toMatchObject({
      decision: "reconciled-without-replay",
      replay: false,
      continueOperation: false,
      effectFingerprint: receipt.effectFingerprint,
    });
    for (const change of [
      { fenceHeld: false },
      { backendState: "unknown" },
      { receipt: null },
      {
        receipt: { ...receipt, effectFingerprint: `sha256:${"0".repeat(64)}` },
      },
      { receipt: { ...receipt, nonce: nonceOf() } },
      { receipt: { ...receipt, ledgerManifest: `sha256:${"1".repeat(64)}` } },
      { ledger: terminal.slice(0, 95) },
    ])
      expect(
        reconcileHistorical89InPlaceOperation({
          ...evidence,
          ...change,
        } as never),
      ).toMatchObject({ decision: "fenced", replay: false });
  }, 300_000);

  it("refuses to drain a foreign backend without terminate privilege, and succeeds once granted", async () => {
    // A role reviewrouter never created and has no membership in - unlike
    // reviewrouter_api or reviewrouter_release_migration, which reviewrouter's
    // own CREATEROLE already lets it terminate through inherited privileges.
    const db = clone();
    pg.query("postgres", "CREATE ROLE rr_foreign_observer LOGIN;", "postgres");
    const foreign = pg.session(db, "rr_foreign_observer");
    try {
      foreign.write(
        "SELECT 'backend:'||pg_backend_pid();\n\\echo foreign-ready\n",
      );
      await waitFor(() => foreign.stdout().includes("foreign-ready"));
      const pid = foreign.stdout().match(/backend:(\d+)/u)![1];
      expect(() => pg.query(db, renderHistorical89SessionDrainSql)).toThrow(
        "historical89_terminate_privilege_missing",
      );
      // Fail-fast: the precondition rejects before any backend, including ones
      // it COULD have terminated, is touched.
      expect(
        pg.query(
          db,
          `SELECT count(*) FROM pg_stat_activity WHERE pid=${pid}`,
          "postgres",
        ),
      ).toBe("1");
      pg.query(
        "postgres",
        "GRANT pg_signal_backend TO reviewrouter;",
        "postgres",
      );
      try {
        pg.query(db, renderHistorical89SessionDrainSql);
        await waitFor(
          () =>
            pg.query(
              db,
              `SELECT count(*) FROM pg_stat_activity WHERE pid=${pid}`,
              "postgres",
            ) === "0",
        );
      } finally {
        pg.query(
          "postgres",
          "REVOKE pg_signal_backend FROM reviewrouter;",
          "postgres",
        );
      }
    } finally {
      await foreign.terminateAndWait();
      pg.query(
        "postgres",
        "DROP ROLE IF EXISTS rr_foreign_observer;",
        "postgres",
      );
    }
  }, 60_000);

  // Staged preparation deliberately uses no fabricated future fence/recovery.
  // Every query below uses a fresh fixture connection; effects are disposable.
  const stagedIdentity = (db: string) => ({
    operationId: randomUUID(),
    systemIdentifier: pg.query(
      db,
      "SELECT system_identifier::text FROM pg_control_system()",
    ),
    databaseOid: pg.query(
      db,
      "SELECT oid::text FROM pg_database WHERE datname=current_database()",
    ),
    databaseName: db,
    sourceCommit: "fc6366bbc09fe03fa71b0e22744e33d6004ba9ef",
    artifactReference: renderManagedEvidenceDigest({ disposableArtifact: db }),
    approvalReference: renderManagedEvidenceDigest({ unapprovedReference: db }),
    baselineReference: renderManagedEvidenceDigest({ ledger: ledger(db) }),
    fleetReference: renderManagedEvidenceDigest({
      serviceIds: ["srv-disposable"],
    }),
    serviceIds: ["srv-disposable"],
  });
  type StagedIdentity = ReturnType<typeof stagedIdentity>;
  const stageService = (
    b: StagedIdentity,
    expectedRevision: number,
    phase: string,
    digest: string,
  ) =>
    read(
      b.databaseName,
      renderHistorical89PreparationService(b, {
        expectedRevision,
        serviceId: "srv-disposable",
        phase,
        digest,
      }).sql,
    );
  const stageObservation = (
    b: StagedIdentity,
    expectedRevision: number,
    kind: string,
    digest: string,
  ) =>
    read(
      b.databaseName,
      renderHistorical89PreparationObserve(b, {
        expectedRevision,
        kind,
        digest,
      }).sql,
    );
  const observedStaging = () => {
    const b = stagedIdentity(clone());
    read(b.databaseName, renderHistorical89PreparationPrepare(b).sql);
    stageService(
      b,
      1,
      "intent",
      renderManagedEvidenceDigest({ intent: "disposable-stop" }),
    );
    stageService(
      b,
      2,
      "result",
      renderManagedEvidenceDigest({ observed: "disposable-stopped" }),
    );
    const binding = {
      operationId: b.operationId,
      systemIdentifier: b.systemIdentifier,
      databaseOid: b.databaseOid,
      databaseName: b.databaseName,
      recoveryIdentitySha256: renderManagedEvidenceDigest({
        observedRecovery: "disposable",
      }),
      externalFenceSha256: renderManagedEvidenceDigest({
        observedFence: "disposable",
      }),
    };
    stageObservation(
      b,
      3,
      "recoveryIdentitySha256",
      binding.recoveryIdentitySha256,
    );
    stageObservation(b, 4, "externalFenceSha256", binding.externalFenceSha256);
    return { b, binding };
  };

  it("stages and reads across connections before CONNECT withdrawal, preserving original grantors", () => {
    const db = clone();
    const original = connectAclOf(db);
    const b = stagedIdentity(db);
    const prepared = read(db, renderHistorical89PreparationPrepare(b).sql);
    expect(prepared.revision).toBe("1");
    expect(prepared.evidence).toEqual({});
    expect(prepared.independentlyApproved).toBe(false);
    expect(prepared.originalConnect.entries).toEqual(
      expect.arrayContaining(
        original.entries.filter(
          (entry: { privilege: string }) => entry.privilege === "CONNECT",
        ),
      ),
    );
    pg.query(db, renderHistorical89AdmissionRestrictionSql(connectAclOf(db)));
    const restoredRead = read(
      db,
      renderHistorical89PreparationReadSql(b),
      "reviewrouter_operation_custody_reader",
    );
    expect(restoredRead).toEqual(prepared);
    expect(() =>
      pg.query(
        db,
        renderHistorical89PreparationReadSql({ ...b, databaseOid: "99999999" }),
        "reviewrouter_operation_custody_reader",
      ),
    ).toThrow("preparation_database_identity");
    expect(read(db, renderHistorical89PreparationPrepare(b).sql)).toEqual(
      prepared,
    );
    expect(() =>
      pg.query(
        db,
        renderHistorical89PreparationPrepare({
          ...b,
          operationId: randomUUID(),
        }).sql,
      ),
    ).toThrow("preparation_identity_conflict");
    expect(() =>
      pg.query(
        db,
        renderHistorical89PreparationPrepare({
          ...b,
          approvalReference: renderManagedEvidenceDigest({ changed: true }),
        }).sql,
      ),
    ).toThrow("preparation_identity_conflict");
  });

  it("requires committed service intent, enforces stale CAS, and refuses contradictory observations", () => {
    const b = stagedIdentity(clone());
    read(b.databaseName, renderHistorical89PreparationPrepare(b).sql);
    const d = renderManagedEvidenceDigest({ disposable: "intent" });
    const other = renderManagedEvidenceDigest({ disposable: "other" });
    expect(() => stageService(b, 1, "result", d)).toThrow(
      "preparation_intent_before_result",
    );
    expect(stageService(b, 1, "intent", d).revision).toBe("2");
    // Exact last-request retry after a lost commit ACK does not advance again.
    expect(stageService(b, 1, "intent", d).revision).toBe("2");
    expect(() => stageService(b, 1, "result", d)).toThrow(
      "preparation_stale_revision",
    );
    expect(stageService(b, 2, "intent", d).revision).toBe("2");
    expect(() => stageService(b, 2, "intent", other)).toThrow(
      "preparation_service_conflict",
    );
    expect(stageService(b, 2, "result", d).revision).toBe("3");
    expect(() => stageService(b, 3, "result", other)).toThrow(
      "preparation_service_conflict",
    );
    expect(stageObservation(b, 3, "recoveryIdentitySha256", d).revision).toBe(
      "4",
    );
    expect(() =>
      stageObservation(b, 4, "recoveryIdentitySha256", other),
    ).toThrow("preparation_evidence_conflict");
    expect(stageObservation(b, 4, "recoveryIdentitySha256", d).revision).toBe(
      "4",
    );
  });

  it("finalizes only actual recorded bindings, installs accepted routines once, and preserves restore entries", () => {
    const { b, binding } = observedStaging();
    const before = read(
      b.databaseName,
      renderHistorical89PreparationReadSql(b),
    );
    const wrong = {
      ...binding,
      externalFenceSha256: renderManagedEvidenceDigest({ wrong: true }),
    };
    expect(() =>
      pg.query(
        b.databaseName,
        renderHistorical89PreparationFinalize(b, wrong, 5).sql,
      ),
    ).toThrow("preparation_finalization_binding");
    expect(() =>
      pg.query(
        b.databaseName,
        renderHistorical89PreparationFinalize(b, binding, 4).sql,
      ),
    ).toThrow("preparation_stale_revision");
    const sql = renderHistorical89PreparationFinalize(b, binding, 5).sql;
    const finalized = read(b.databaseName, sql);
    expect(finalized.revision).toBe("6");
    expect(finalized.originalConnect).toEqual(before.originalConnect);
    expect(read(b.databaseName, sql)).toEqual(finalized);
    expect(
      read(
        b.databaseName,
        renderHistorical89PreparationReadSql(b, binding),
        "reviewrouter_operation_custody_reader",
      ),
    ).toEqual(finalized);
    // The accepted attestation is also used by the existing final operation API.
    pg.query(
      b.databaseName,
      renderManagedOperationCustodyBootstrap(binding).verifySql,
    );
    expect(() =>
      pg.query(
        b.databaseName,
        renderHistorical89PreparationFinalize(b, wrong, 5).sql,
      ),
    ).toThrow("preparation_finalization_conflict");
    expect(() =>
      pg.query(
        b.databaseName,
        renderHistorical89PreparationFinalize(b, binding, 6).sql,
      ),
    ).toThrow("preparation_finalization_conflict");
    expect(() =>
      stageObservation(
        b,
        6,
        "externalFenceSha256",
        binding.externalFenceSha256,
      ),
    ).toThrow("preparation_use_final_binding");
    expect(
      pg.query(
        b.databaseName,
        "SELECT count(*) FROM release_operation_custody.operation_permit",
        "postgres",
      ),
    ).toBe("0");
  });

  it("refuses finalization before required service results and observations exist", () => {
    const b = stagedIdentity(clone());
    read(b.databaseName, renderHistorical89PreparationPrepare(b).sql);
    const d = renderManagedEvidenceDigest({ disposable: true });
    const binding = {
      operationId: b.operationId,
      systemIdentifier: b.systemIdentifier,
      databaseOid: b.databaseOid,
      databaseName: b.databaseName,
      recoveryIdentitySha256: d,
      externalFenceSha256: d,
    };
    expect(() =>
      pg.query(
        b.databaseName,
        renderHistorical89PreparationFinalize(b, binding, 1).sql,
      ),
    ).toThrow("preparation_finalization_binding");
    stageObservation(b, 1, "recoveryIdentitySha256", d);
    stageObservation(b, 2, "externalFenceSha256", d);
    expect(() =>
      pg.query(
        b.databaseName,
        renderHistorical89PreparationFinalize(b, binding, 3).sql,
      ),
    ).toThrow("preparation_finalization_binding");
  });

  it("does not adopt an impostor schema or existing role", () => {
    let db = clone();
    let b = stagedIdentity(db);
    pg.query(db, "CREATE SCHEMA release_operation_custody");
    expect(() =>
      pg.query(db, renderHistorical89PreparationPrepare(b).sql),
    ).toThrow("preparation_catalog_attestation");
    db = clone();
    b = stagedIdentity(db);
    pg.query(db, "CREATE ROLE reviewrouter_operation_custody_reader LOGIN");
    expect(() =>
      pg.query(db, renderHistorical89PreparationPrepare(b).sql),
    ).toThrow("preparation_roles_present");
  });

  it.each([
    "ALTER TABLE release_operation_custody.historical89_preparation ADD COLUMN impostor text",
    "ALTER TABLE release_operation_custody.historical89_preparation ALTER COLUMN services SET DEFAULT '{}'::jsonb",
    "ALTER TABLE release_operation_custody.historical89_preparation DISABLE TRIGGER historical89_preparation_immutable",
    "DROP TRIGGER historical89_preparation_immutable ON release_operation_custody.historical89_preparation; CREATE TRIGGER historical89_preparation_immutable BEFORE INSERT OR UPDATE OF identity OR DELETE ON release_operation_custody.historical89_preparation FOR EACH ROW EXECUTE FUNCTION release_operation_custody.historical89_preparation_immutable(); ALTER TABLE release_operation_custody.historical89_preparation ENABLE ALWAYS TRIGGER historical89_preparation_immutable",
    "CREATE OR REPLACE FUNCTION release_operation_custody.historical89_preparation_immutable() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'",
    "GRANT UPDATE ON release_operation_custody.historical89_preparation TO reviewrouter_operation_custody_reader",
    "GRANT EXECUTE ON FUNCTION release_operation_custody.historical89_preparation_immutable() TO PUBLIC",
    "GRANT reviewrouter_operation_custody_owner TO reviewrouter_operation_custody_reader WITH SET TRUE",
    "CREATE FUNCTION release_operation_custody.impostor() RETURNS integer LANGUAGE sql AS 'SELECT 1'",
  ])("rejects staged routine/catalog/ACL drift: %s", (tamper) => {
    const b = stagedIdentity(clone());
    pg.query(b.databaseName, renderHistorical89PreparationPrepare(b).sql);
    pg.query(b.databaseName, tamper, "postgres");
    expect(() =>
      pg.query(b.databaseName, renderHistorical89PreparationPrepare(b).sql),
    ).toThrow("preparation_catalog_attestation");
  });

  it.each([
    ["TABLE preparation_public_probe", "INSERT"],
    ["TABLE preparation_public_probe", "UPDATE (value)"],
    ["TABLE preparation_public_probe", "INSERT (value)"],
    ["TABLE preparation_public_probe", "REFERENCES (value)"],
    ["TABLE preparation_public_probe", "MAINTAIN"],
    ["SCHEMA public", "CREATE"],
    ["SCHEMA preparation_no_usage", "CREATE"],
    [`DATABASE ${target}`, "CREATE"],
    ["SEQUENCE preparation_public_sequence", "USAGE"],
    ["SEQUENCE preparation_no_usage.private_sequence", "USAGE"],
    ["FUNCTION public.preparation_public_definer()", "EXECUTE"],
    ["FUNCTION public.preparation_public_trigger()", "EXECUTE"],
    ["FUNCTION preparation_no_usage.private_definer()", "EXECUTE"],
    ["PROCEDURE public.preparation_public_procedure()", "EXECUTE"],
  ])(
    "rejects effective PUBLIC %s %s without revoking it",
    (object, privilege) => {
      const db = clone();
      const b = stagedIdentity(db);
      pg.query(
        db,
        `
      CREATE TABLE public.preparation_public_probe (value integer);
      CREATE SCHEMA preparation_no_usage;
      CREATE SEQUENCE preparation_no_usage.private_sequence;
      CREATE FUNCTION preparation_no_usage.private_definer() RETURNS integer
        LANGUAGE plpgsql SECURITY DEFINER AS 'BEGIN INSERT INTO public.preparation_public_probe VALUES (1); RETURN 1; END';
      REVOKE EXECUTE ON FUNCTION preparation_no_usage.private_definer() FROM PUBLIC;
      CREATE VIEW public.preparation_private_view AS SELECT preparation_no_usage.private_definer() AS value;
      GRANT SELECT ON public.preparation_private_view TO PUBLIC;
      CREATE SEQUENCE public.preparation_public_sequence;
      CREATE FUNCTION public.preparation_public_definer() RETURNS integer
        LANGUAGE sql SECURITY DEFINER AS 'SELECT 1';
      CREATE PROCEDURE public.preparation_public_procedure()
        LANGUAGE plpgsql SECURITY DEFINER AS 'BEGIN NULL; END';
      CREATE FUNCTION public.preparation_public_trigger() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER AS 'BEGIN INSERT INTO public.preparation_public_probe VALUES (NEW.value); RETURN NEW; END';
      REVOKE EXECUTE ON FUNCTION public.preparation_public_definer() FROM PUBLIC;
      REVOKE EXECUTE ON PROCEDURE public.preparation_public_procedure() FROM PUBLIC;
      REVOKE EXECUTE ON FUNCTION public.preparation_public_trigger() FROM PUBLIC;
    `,
      );
      const grant = `GRANT ${privilege} ON ${object} TO PUBLIC`;
      const revoke = `REVOKE ${privilege} ON ${object} FROM PUBLIC`;
      pg.query(db, grant);
      expect(() =>
        pg.query(db, renderHistorical89PreparationPrepare(b).sql),
      ).toThrow("preparation_catalog_attestation");
      expect(
        pg.query(
          db,
          `
      SELECT count(*) FROM pg_roles WHERE rolname IN
        ('reviewrouter_operation_custody_reader','reviewrouter_operation_custody_owner')
    `,
        ),
      ).toBe("0");
      // A repeat still fails: preflight did not silently remove the PUBLIC grant.
      expect(() =>
        pg.query(db, renderHistorical89PreparationPrepare(b).sql),
      ).toThrow("preparation_catalog_attestation");
      pg.query(db, revoke);
      const baseline = read(db, renderHistorical89PreparationPrepare(b).sql);
      pg.query(db, grant);
      if (object === "SEQUENCE preparation_no_usage.private_sequence") {
        const sequenceOid = pg.query(
          db,
          "SELECT 'preparation_no_usage.private_sequence'::regclass::oid",
        );
        expect(
          pg.query(
            db,
            `SELECT nextval(${sequenceOid}::oid::regclass)`,
            "reviewrouter_operation_custody_reader",
          ),
        ).toBe("1");
      }
      if (object === "FUNCTION preparation_no_usage.private_definer()") {
        expect(
          pg.query(
            db,
            "SELECT value FROM public.preparation_private_view",
            "reviewrouter_operation_custody_reader",
          ),
        ).toBe("1");
        expect(
          pg.query(db, "SELECT value FROM public.preparation_public_probe"),
        ).toBe("1");
      }
      if (object === "FUNCTION public.preparation_public_trigger()") {
        // A reader can attach a PUBLIC definer trigger to its own temporary table.
        pg.query(
          db,
          `CREATE TEMP TABLE preparation_trigger_input (value integer);
        CREATE TRIGGER exploit AFTER INSERT ON preparation_trigger_input
          FOR EACH ROW EXECUTE FUNCTION public.preparation_public_trigger();
        INSERT INTO preparation_trigger_input VALUES (1);`,
          "reviewrouter_operation_custody_reader",
        );
        expect(
          pg.query(db, "SELECT value FROM public.preparation_public_probe"),
        ).toBe("1");
      }
      expect(() =>
        pg.query(
          db,
          renderHistorical89PreparationReadSql(b),
          "reviewrouter_operation_custody_reader",
        ),
      ).toThrow("preparation_catalog_attestation");
      const digest = renderManagedEvidenceDigest({
        publicPrivilege: privilege,
      });
      expect(() =>
        stageObservation(b, 1, "recoveryIdentitySha256", digest),
      ).toThrow("preparation_catalog_attestation");
      pg.query(db, revoke);
      expect(
        read(
          db,
          renderHistorical89PreparationReadSql(b),
          "reviewrouter_operation_custody_reader",
        ),
      ).toEqual(baseline);
      expect(
        stageObservation(b, 1, "recoveryIdentitySha256", digest).revision,
      ).toBe("2");
    },
  );

  it("allows PUBLIC schema USAGE, invoker functions and database TEMP", () => {
    const db = clone();
    const b = stagedIdentity(db);
    pg.query(
      db,
      `
      GRANT USAGE ON SCHEMA public TO PUBLIC;
      GRANT TEMPORARY ON DATABASE ${target} TO PUBLIC;
      CREATE FUNCTION public.preparation_public_invoker() RETURNS integer
        LANGUAGE sql SECURITY INVOKER AS 'SELECT 1';
      GRANT EXECUTE ON FUNCTION public.preparation_public_invoker() TO PUBLIC;
    `,
    );
    const baseline = read(db, renderHistorical89PreparationPrepare(b).sql);
    expect(
      pg.query(
        db,
        `
      CREATE TEMP TABLE preparation_temp_probe (value integer);
      SELECT public.preparation_public_invoker() + pg_catalog.length('x');
    `,
        "reviewrouter_operation_custody_reader",
      ),
    ).toBe("2");
    expect(
      read(
        db,
        renderHistorical89PreparationReadSql(b),
        "reviewrouter_operation_custody_reader",
      ),
    ).toEqual(baseline);
  });

  it.each(["recoveryIdentitySha256", "externalFenceSha256"])(
    "rejects owner DML containing JSON null evidence for %s",
    (kind) => {
      const db = clone();
      const b = stagedIdentity(db);
      const baseline = read(db, renderHistorical89PreparationPrepare(b).sql);
      expect(() =>
        pg.query(
          db,
          `
        BEGIN;
        GRANT reviewrouter_operation_custody_owner TO reviewrouter
          WITH INHERIT TRUE, SET TRUE;
        SET LOCAL ROLE reviewrouter_operation_custody_owner;
        UPDATE release_operation_custody.historical89_preparation
          SET revision=revision+1,evidence=jsonb_build_object('${kind}',NULL);
        COMMIT;
      `,
        ),
      ).toThrow("preparation_evidence_shape");
      expect(
        read(
          db,
          renderHistorical89PreparationReadSql(b),
          "reviewrouter_operation_custody_reader",
        ),
      ).toEqual(baseline);
      const digest = renderManagedEvidenceDigest({ validObservation: kind });
      const observed = stageObservation(b, 1, kind, digest);
      expect(observed.revision).toBe("2");
      expect(observed.evidence).toEqual({ [kind]: digest });
      expect(() =>
        stageObservation(
          b,
          2,
          kind,
          renderManagedEvidenceDigest({ conflictingObservation: kind }),
        ),
      ).toThrow("preparation_evidence_conflict");
      expect(
        read(
          db,
          renderHistorical89PreparationReadSql(b),
          "reviewrouter_operation_custody_reader",
        ),
      ).toEqual(observed);
    },
  );

  it("denies restricted-role writes and owner-only transitions", () => {
    const b = stagedIdentity(clone());
    pg.query(b.databaseName, renderHistorical89PreparationPrepare(b).sql);
    for (const role of [
      "reviewrouter",
      "reviewrouter_operation_custody_reader",
      "reviewrouter_api",
    ])
      for (const statement of [
        "UPDATE release_operation_custody.historical89_preparation SET revision=revision+1",
        "DELETE FROM release_operation_custody.historical89_preparation",
        "TRUNCATE release_operation_custody.historical89_preparation",
      ])
        expect(() => pg.query(b.databaseName, statement, role)).toThrow(
          /permission denied/u,
        );
    expect(() =>
      pg.query(
        b.databaseName,
        renderHistorical89PreparationService(b, {
          expectedRevision: 1,
          serviceId: "srv-disposable",
          phase: "intent",
          digest: renderManagedEvidenceDigest({ disposable: true }),
        }).sql,
        "reviewrouter_operation_custody_reader",
      ),
    ).toThrow("preparation_database_identity");
  });

  it("enforces immutable identity, original grants, and monotonic revision in the table itself", () => {
    const b = stagedIdentity(clone());
    pg.query(b.databaseName, renderHistorical89PreparationPrepare(b).sql);
    for (const update of [
      "identity=jsonb_set(identity,'{operationId}',to_jsonb('99999999-2222-3333-4444-555555555555'::text))",
      "original_connect='{}'::jsonb",
    ])
      expect(() =>
        pg.query(
          b.databaseName,
          `UPDATE release_operation_custody.historical89_preparation SET ${update},revision=revision+1`,
          "postgres",
        ),
      ).toThrow("preparation_identity_immutable");
    expect(() =>
      pg.query(
        b.databaseName,
        "UPDATE release_operation_custody.historical89_preparation SET revision=revision+2",
        "postgres",
      ),
    ).toThrow("preparation_revision");
    expect(() =>
      pg.query(
        b.databaseName,
        "DELETE FROM release_operation_custody.historical89_preparation",
        "postgres",
      ),
    ).toThrow("preparation_delete_forbidden");
    expect(
      read(b.databaseName, renderHistorical89PreparationReadSql(b)).revision,
    ).toBe("1");
  });
});
