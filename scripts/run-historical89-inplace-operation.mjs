#!/usr/bin/env node
// Executable runner for the reviewed managed-historical89-in-place/v1
// operation. This is the exact call sequence proved by the "reaches96 under
// custody and records one protected operation-bound receipt" test in
// scripts/render-historical89-custody.pg17.real.test.ts, rebuilt as a script
// against a real `pg` connection instead of the disposable psql fixture. It
// invents no domain logic of its own: every accept/reject decision is made by
// the already-reviewed library functions under scripts/lib/. This file only
// adds connection handling, ordering glue and JSON reporting.
//
// Like the library it calls, this script never claims production
// authorization: `plan.authorization.authorizesProductionMutation` is false
// today because no independently reviewed expectation registry exists yet
// (see render-historical89-admission.mjs). Running it still performs the real
// schema mutation when pointed at a qualified database - it is the mechanism,
// not the approval.
//
// Scope: this mirrors the "reaches96" test only. It does not withdraw and
// then restore the CONNECT ACL as a separate later step, and it does not
// implement cross-invocation resume (recovering a lost operationId from a
// prior process) - both are explicitly out of this test's sequence and are
// left to the coordinator, matching PLAN.md section 1C/2.
import pg from "pg";
import { randomUUID } from "node:crypto";
import {
  renderManagedEvidenceDigest,
  renderManagedLedgerSql,
  renderManagedMembershipSql,
} from "./lib/render-schema-handoff-policy.mjs";
import { renderManagedCatalogSql } from "./lib/render-managed-catalog.mjs";
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
  renderHistorical89InPlaceTransaction,
} from "./lib/render-historical89-inplace-transaction.mjs";
import {
  renderManagedOperationCurrentPermitSql,
  renderManagedOperationCustodyBootstrap,
} from "./lib/render-managed-operation-custody.mjs";
import {
  renderHistorical89AdmissionRestrictionSql,
  renderHistorical89ConnectAclSql,
} from "./lib/render-historical89-execution-boundary.mjs";
import {
  historical89InPlaceCustodyBinding,
  planHistorical89InPlaceOperation,
  reconcileHistorical89InPlaceOperation,
  renderHistorical89InPlacePreflightSql,
} from "./lib/render-historical89-operation.mjs";

// Pinned to the one production database this phase exists for, exactly as
// render-historical89-admission.mjs pins them internally (it does not export
// the constants, so the caller has to know and restate them, same as the
// disposable test does).
const EXPECTED_PROVIDER_DATABASE_RESOURCE_ID = "dpg-da32ipmk1f9s73dttm90-a";
const EXPECTED_DATABASE_NAME = "review_router_dimy";
const CUSTODY_READER_ROLE = "reviewrouter_operation_custody_reader";
const gateSql = `SET search_path = pg_catalog, public;\n${renderManagedRuntimeGateSql};`;
const nonceOf = () => randomUUID().replaceAll("-", "");

function fail(reason) {
  const error = new Error(reason);
  error.failClosed = true;
  throw error;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) fail(`missing_env:${name}`);
  return value;
}

function readerConnectionString(mainUrl) {
  const override =
    process.env.REVIEW_ROUTER_RELEASE_MIGRATION_CUSTODY_READER_DATABASE_URL;
  if (override) return override;
  // No independent credential exists for the restricted reader role yet (see
  // PR #273's own honest limitations: LOGIN with no password). Derived here
  // by role substitution so this works against the trust-auth disposable
  // fixture; a real run needs a real password issued through the trusted
  // boundary and must set the override env var instead.
  const url = new URL(mainUrl);
  url.username = CUSTODY_READER_ROLE;
  url.password = "";
  return url.toString();
}

function lastResult(result) {
  return Array.isArray(result) ? result[result.length - 1] : result;
}

async function readOne(client, sql) {
  const rows = lastResult(await client.query(sql)).rows;
  if (rows.length !== 1) fail(`unexpected_row_count:${rows.length}`);
  const row = rows[0];
  const keys = Object.keys(row);
  if (keys.length !== 1) fail(`unexpected_column_count:${keys.length}`);
  return row[keys[0]];
}

async function connect(connectionString) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}

async function readReceipt(connectionString, effectReadSql) {
  const reader = await connect(connectionString);
  try {
    return await readOne(reader, effectReadSql);
  } finally {
    await reader.end().catch(() => {});
  }
}

/** Everything `prepare()` gathers in the test, read from the live connection. */
async function gatherQualification(client) {
  const gate = await readOne(client, gateSql);
  const operationId = randomUUID();
  const [identity] = lastResult(
    await client.query(
      "SELECT session_user, current_user, current_database() AS db, " +
        "(SELECT system_identifier::text FROM pg_control_system()) AS sysid, " +
        "(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS dboid;",
    ),
  ).rows;
  if (identity.session_user !== identity.current_user)
    fail("creator_role_path:session_user_current_user_mismatch");
  if (identity.db !== EXPECTED_DATABASE_NAME)
    fail(`database_identity:${identity.db}`);
  const recoveryIdentitySha256 = renderManagedEvidenceDigest({
    historical89InPlaceRecovery: identity.db,
    operationId,
  });
  const externalFenceSha256 = renderManagedEvidenceDigest({
    historical89InPlaceFence: identity.db,
    operationId,
  });
  const identityFields = {
    operationId,
    systemIdentifier: identity.sysid,
    databaseOid: identity.dboid,
    databaseName: identity.db,
    recoveryIdentitySha256,
    externalFenceSha256,
  };
  const binding = historical89InPlaceCustodyBinding(identityFields);
  const custody = renderManagedOperationCustodyBootstrap(binding);
  await client.query(custody.bootstrapSql);
  const connectAcl = await readOne(client, renderHistorical89ConnectAclSql);
  await client.query(renderHistorical89AdmissionRestrictionSql(connectAcl));
  const baselineLedger = await readOne(client, renderManagedLedgerSql);
  const baselineCatalog = await readOne(client, renderManagedCatalogSql);
  const baselineDefaultAcl = await readOne(
    client,
    renderHistorical89DefaultAclSql,
  );
  const baselineObjectAcl = await readOne(
    client,
    renderHistorical89ObjectAclSql,
  );
  const originalMembership = (
    await readOne(client, renderManagedMembershipSql)
  )[0];
  const admission = Object.freeze({
    providerDatabaseResourceId: EXPECTED_PROVIDER_DATABASE_RESOURCE_ID,
    ...identityFields,
    providerEffectIds: ["historical89-inplace-runner"],
    qualifiedAt: new Date().toISOString(),
    handoffSourceCommit: phase.handoffSourceCommit,
    cutoverSourceCommit: phase.cutoverSourceCommit,
    sourceTree: "0".repeat(40),
    pendingEntriesSha256: renderHistorical89PendingDigest(
      readHistorical89PendingIdentities(),
    ),
    authorizedBinaryArtifactDigest: renderManagedEvidenceDigest({
      historical89InPlaceRunnerArtifact: true,
      operationId,
    }),
    baselineManifest: phase.baselineManifest,
    targetManifest: phase.targetManifest,
    originalLedgerDigest:
      inspectHistorical89InPlaceLedger(baselineLedger).ledgerDigest,
    catalogDigest: renderManagedEvidenceDigest(baselineCatalog),
    topologyDigest: renderManagedEvidenceDigest({
      historical89InPlaceTopology: identity.db,
      operationId,
    }),
    ownershipDigest: renderManagedEvidenceDigest({
      historical89InPlaceOwnership: identity.db,
      operationId,
    }),
    aclDigest: renderManagedEvidenceDigest(baselineDefaultAcl),
    membershipDigest: renderManagedEvidenceDigest([originalMembership]),
    gateStatus: "closed",
    custodyDigest: renderManagedEvidenceDigest(gate),
  });
  const roleSettings = await readOne(
    client,
    `SET search_path = pg_catalog, public;
     SELECT COALESCE(jsonb_agg(jsonb_build_object('role',COALESCE(r.rolname,'*'),
       'setting',s.setconfig::text,'value','')),'[]'::jsonb)
     FROM pg_db_role_setting s LEFT JOIN pg_roles r ON r.oid=s.setrole;`,
  );
  const securityDefiners = await readOne(
    client,
    `SET search_path = pg_catalog, public;
     SELECT COALESCE(jsonb_agg(jsonb_build_object(
       'identity',format('%I.%I',n.nspname,p.proname),
       'effectiveRole',pg_get_userbyid(p.proowner),'createsObjects',false)),'[]'::jsonb)
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.prosecdef;`,
  );
  const creatorEvidence = {
    sessionUser: identity.session_user,
    currentUser: identity.current_user,
    creatingRoles: [identity.session_user],
    roleSettings,
    securityDefiners,
    // The two reviewed, source-fixed alternative creation paths this
    // operation's seven bodies are known to contain; see
    // render-historical89-admission.mjs's assertHistorical89Creators for why
    // presence alone is not disqualifying and only "creates nothing" is.
    dynamicDdl: [
      {
        identity: "000089 canonical owner transfer",
        effectiveRole: identity.session_user,
        createsObjects: false,
      },
    ],
    triggerCreators: [],
  };
  const identityDigest = assertHistorical89AdmissionIdentity(admission);
  return {
    binding,
    admission,
    connectAcl,
    baselineLedger,
    baselineCatalog,
    baselineDefaultAcl,
    baselineObjectAcl,
    originalMembership,
    creatorEvidence,
    gate,
    identityDigest,
  };
}

/** Rehearse the terminal catalog once, on the database that now carries
 * custody, inside its own transaction, then roll it back. This is what lets
 * the plan carry a `disposable-rehearsal` terminal-catalog provenance instead
 * of the still-empty `reviewed-registry` one. */
async function rehearseTerminalCatalog(client, qualification) {
  const built = renderHistorical89InPlaceTransaction({
    admission: qualification.admission,
    ledger: qualification.baselineLedger,
    originalMembership: qualification.originalMembership,
    baselineCatalog: qualification.baselineCatalog,
    defaultAcl: qualification.baselineDefaultAcl,
    creatorEvidence: qualification.creatorEvidence,
    gate: qualification.gate,
    preflightSql: renderHistorical89InPlacePreflightSql(qualification.binding),
  });
  await client.query(built.sql);
  const expected = await readOne(client, renderManagedCatalogSql);
  await client.query("ROLLBACK;");
  return { expected, digest: renderManagedEvidenceDigest(expected) };
}

function buildPreconditions(qualification) {
  const now = new Date().toISOString();
  return {
    recovery: {
      recoveryIdentitySha256: qualification.admission.recoveryIdentitySha256,
      artifactDigest: renderManagedEvidenceDigest({
        historical89InPlaceRecoveryArtifact:
          qualification.admission.operationId,
      }),
      qualifiedAt: now,
      restoreVerified: true,
    },
    admission: {
      status: "closed",
      connectAclDigest: renderManagedEvidenceDigest(qualification.connectAcl),
      restrictedAt: now,
    },
    automation: {
      automaticMigrationsDisabled: true,
      declaredServices: [
        {
          serviceId: "srv-historical89runner",
          autoDeploy: "no",
          suspended: "suspended",
        },
      ],
    },
    fence: {
      externalFenceSha256: qualification.admission.externalFenceSha256,
      holder: "historical89-inplace-runner",
      scope: ["srv-historical89runner"],
      durable: true,
      survivesCoordinatorDeath: true,
      establishedAt: now,
    },
  };
}

async function reconcileAfter(mainUrl, readerUrl, plan, opts) {
  const post = await connect(mainUrl);
  let terminalCatalog;
  let terminalLedger;
  let gateNow;
  let membershipNow;
  let currentPermit;
  try {
    terminalLedger = await readOne(post, renderManagedLedgerSql);
    terminalCatalog = await readOne(post, renderManagedCatalogSql);
    gateNow = await readOne(post, gateSql);
    membershipNow = await readOne(post, renderManagedMembershipSql);
    currentPermit = await readOne(
      post,
      renderManagedOperationCurrentPermitSql(plan.binding),
    );
  } finally {
    await post.end().catch(() => {});
  }
  let receipt;
  try {
    receipt = await readReceipt(readerUrl, plan.effectReadSql);
  } catch {
    // A failed read is unknown evidence, not proof that no receipt exists.
    receipt = undefined;
  }
  const inspected = inspectHistorical89InPlaceLedger(terminalLedger);
  const rollbackConfirmed = inspected.count === phase.baselineCount;
  let aclDelta;
  if (inspected.count === phase.targetCount) {
    const objectAclClient = await connect(mainUrl);
    try {
      const terminalObjectAcl = await readOne(
        objectAclClient,
        renderHistorical89ObjectAclSql,
      );
      aclDelta = assertHistorical89InPlaceAclDelta({
        baseline: opts.baselineObjectAcl,
        terminal: terminalObjectAcl,
        creators: plan.creators,
      });
    } finally {
      await objectAclClient.end().catch(() => {});
    }
  }
  const reconciliation = reconcileHistorical89InPlaceOperation({
    plan,
    backendState: "terminated",
    rollbackConfirmed,
    ledger: terminalLedger,
    terminalCatalog,
    gate: gateNow,
    memberships: membershipNow,
    originalMembership: opts.originalMembership,
    aclDelta,
    receipt,
    currentPermit,
    fenceHeld: true,
  });
  return { reconciliation, receipt };
}

async function run() {
  const mainUrl = requireEnv("REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL");
  const readerUrl = readerConnectionString(mainUrl);
  const client = await connect(mainUrl);
  let closed = false;
  try {
    const currentLedger = await readOne(client, renderManagedLedgerSql);
    const currentInspect = inspectHistorical89InPlaceLedger(currentLedger);
    if (currentInspect.count === phase.targetCount) {
      // Idempotent: already at 96. Best-effort receipt lookup only; a 96
      // reached by any path other than this custody mechanism has no receipt
      // to find, and that is reported as null rather than treated as failure.
      let receiptDigest = null;
      try {
        const effectReadSql = `SELECT release_operation_custody.custody_read_effect(
          (SELECT operation_id FROM release_operation_custody.operation_permit LIMIT 1)
        )::jsonb;`;
        const receipt = await readReceipt(readerUrl, effectReadSql);
        receiptDigest = receipt?.effectFingerprint ?? null;
      } catch {
        receiptDigest = null;
      }
      return {
        outcome: "already-96",
        receiptDigest,
        timestamp: new Date().toISOString(),
      };
    }
    if (currentInspect.count !== phase.baselineCount)
      fail(`unexpected_ledger_state:count=${currentInspect.count}`);

    let qualification;
    try {
      qualification = await gatherQualification(client);
    } catch (error) {
      if (String(error?.message ?? "").includes("custody_already_present")) {
        // Custody schema/roles already exist from an earlier, unresolved
        // attempt whose operationId this process never knew. Recovering it
        // requires the durable external fence record from that attempt, which
        // this script does not have. Failing closed here, not guessing.
        return {
          outcome: "fenced-unresolved",
          receiptDigest: null,
          timestamp: new Date().toISOString(),
          reason: "custody_already_present_from_prior_attempt",
        };
      }
      throw error;
    }

    const rehearsal = await rehearseTerminalCatalog(client, qualification);
    const coordinates = { epoch: 1, nonce: nonceOf(), generation: 1 };
    const plan = planHistorical89InPlaceOperation({
      admission: qualification.admission,
      ledger: qualification.baselineLedger,
      originalMembership: qualification.originalMembership,
      baselineCatalog: qualification.baselineCatalog,
      defaultAcl: qualification.baselineDefaultAcl,
      creatorEvidence: qualification.creatorEvidence,
      gate: qualification.gate,
      connectAcl: qualification.connectAcl,
      preconditions: buildPreconditions(qualification),
      coordinates,
      reviewedTerminalCatalog: rehearsal.expected,
      reviewedTerminalCatalogDigest: rehearsal.digest,
      // No independently reviewed expectation registry exists yet (see
      // readReviewedHistorical89Contract in render-historical89-admission.mjs),
      // so `reviewed-registry` provenance is not achievable today and
      // plan.authorization.authorizesProductionMutation is always false.
      terminalCatalogProvenance: "disposable-rehearsal",
    });

    await readOne(client, plan.openPermitSql);

    try {
      await client.query(plan.transactionSql);
    } catch (transactionError) {
      await client.end().catch(() => {});
      closed = true;
      const { reconciliation } = await reconcileAfter(
        mainUrl,
        readerUrl,
        plan,
        {
          originalMembership: qualification.originalMembership,
          baselineObjectAcl: qualification.baselineObjectAcl,
        },
      );
      if (reconciliation.decision === "resume-same-operation")
        return {
          outcome: "resumed-same-operation",
          receiptDigest: null,
          timestamp: new Date().toISOString(),
          reasons: reconciliation.reasons,
          transactionError: transactionError.message,
        };
      return {
        outcome: "fenced-unresolved",
        receiptDigest: null,
        timestamp: new Date().toISOString(),
        reasons: reconciliation.reasons,
        transactionError: transactionError.message,
      };
    }

    await client.end();
    closed = true;
    const { reconciliation } = await reconcileAfter(mainUrl, readerUrl, plan, {
      originalMembership: qualification.originalMembership,
      baselineObjectAcl: qualification.baselineObjectAcl,
    });
    if (reconciliation.decision !== "reconciled-without-replay")
      return {
        outcome: "fenced-unresolved",
        receiptDigest: null,
        timestamp: new Date().toISOString(),
        reasons: reconciliation.reasons,
      };
    return {
      outcome: "committed-96",
      receiptDigest: reconciliation.effectFingerprint,
      timestamp: new Date().toISOString(),
    };
  } finally {
    if (!closed) await client.end().catch(() => {});
  }
}

function redact(text, secrets) {
  let result = text;
  for (const secret of secrets) {
    if (!secret) continue;
    result = result.split(secret).join("[redacted]");
    try {
      const password = new URL(secret).password;
      if (password) result = result.split(password).join("[redacted]");
    } catch {
      // not a URL; nothing further to strip
    }
  }
  return result;
}

async function main() {
  const secrets = [
    process.env.REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL,
    process.env.REVIEW_ROUTER_RELEASE_MIGRATION_CUSTODY_READER_DATABASE_URL,
  ];
  try {
    const result = await run();
    console.log(JSON.stringify(result));
    process.exit(
      result.outcome === "committed-96" || result.outcome === "already-96"
        ? 0
        : 1,
    );
  } catch (error) {
    const message = redact(String(error?.message ?? error), secrets);
    console.error(`historical89_inplace_failed:${message}`);
    process.exit(1);
  }
}

await main();
