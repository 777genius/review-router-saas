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
});
