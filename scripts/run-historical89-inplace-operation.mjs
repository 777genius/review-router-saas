#!/usr/bin/env node
// Source-qualified preparation and one-operation migration. The reviewed bundle
// pins the exact baseline, terminal state, and fleet; recovery is captured fresh
// on retained storage only after that exact fleet is suspended and re-observed.
import pg from "pg";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  parseHistorical89Verification,
  verifyHistorical89Already96,
  readHistorical89One,
} from "./lib/verify-historical89-already96.mjs";
import {
  renderManagedEvidenceDigest as digest,
  renderManagedLedgerSql,
  renderManagedMembershipSql,
} from "./lib/render-schema-handoff-policy.mjs";
import { renderManagedCatalogSql } from "./lib/render-managed-catalog.mjs";
import { renderManagedRuntimeGateSql } from "./lib/render-managed-workflow-cutover.mjs";
import {
  readReviewedHistorical89Bundle,
  readReviewedHistorical89BundleDigest,
  compareHistorical89Original,
  compareHistorical89PreparationStage,
  historical89OriginalDatabaseAcl,
  materializeHistorical89ReviewedTerminal,
  renderHistorical89AdmissionPhase as phase,
  renderHistorical89DefaultAclSql,
  renderHistorical89ObjectAclSql,
} from "./lib/render-historical89-admission.mjs";
import {
  assertHistorical89InPlaceAclDelta,
  inspectHistorical89InPlaceLedger,
} from "./lib/render-historical89-inplace-transaction.mjs";
import {
  renderManagedOperationCurrentPermitSql,
  renderManagedOperationAdvanceEpochSql,
} from "./lib/render-managed-operation-custody.mjs";
import {
  renderHistorical89AdmissionRestrictionSql,
  renderHistorical89ConnectAclSql,
  renderHistorical89SessionDrainSql,
  renderHistorical89FleetQuiescenceGuardSql,
  assertHistorical89OriginalConnectAcl,
} from "./lib/render-historical89-execution-boundary.mjs";
import {
  historical89InPlaceCustodyBinding,
  planHistorical89InPlaceOperation,
  reconcileHistorical89InPlaceOperation,
} from "./lib/render-historical89-operation.mjs";
import {
  renderHistorical89PreparationPrepareParts,
  renderHistorical89PreparationFinalizeParts,
  renderHistorical89PreparationReadSql,
  renderHistorical89PreparationService,
  renderHistorical89PreparationObserve,
} from "./lib/render-historical89-preparation-custody.mjs";
import { captureHistorical89Prerequisites } from "./lib/render-historical89-prerequisite-capture.mjs";
import {
  assertHistorical89ExecutingSource,
  connectHistorical89Reader,
  provisionHistorical89Reader,
  createHistorical89Journal,
  createHistorical89Render,
  captureHistorical89RetainedBackup,
  verifyHistorical89RetainedBackup,
  readHistorical89Json as readJson,
  submitHistorical89Transition,
  historical89BackendSql,
  historical89BackendState,
} from "./lib/historical89-preparation-coordinator.mjs";

const fail = (reason) => {
  throw new Error(`historical89_coordinator:${reason}`);
};
const requireEnv = (name) => process.env[name] || fail(`missing_env:${name}`);
const nonce = () => randomUUID().replaceAll("-", "");
const gateSql = `SET search_path = pg_catalog, public;\n${renderManagedRuntimeGateSql};`;
const same = (a, b) => digest(a) === digest(b);
const readerRole = "reviewrouter_operation_custody_reader";
async function connect(connectionString) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}

async function observe(client, bundle) {
  const identity = await readJson(
    client,
    `SELECT jsonb_build_object('sessionUser',session_user,'currentUser',current_user)`,
  );
  const membership = await readJson(client, renderManagedMembershipSql);
  if (membership.length !== 1) fail("original_membership_shape");
  const observation = {};
  for (const [key, sql] of Object.entries({
    ledger: renderManagedLedgerSql,
    catalog: renderManagedCatalogSql,
    defaultAcl: renderHistorical89DefaultAclSql,
    objectAcl: renderHistorical89ObjectAclSql,
    gate: gateSql,
    connectAcl: renderHistorical89ConnectAclSql,
  }))
    observation[key] = await readJson(client, sql);
  // Creator-path classification is independently reviewed, source-bound evidence.
  // The full catalog checkpoint binds actual definitions/settings/authority;
  // session identity is observed afresh. No runtime DDL paths are inferred.
  return {
    ...observation,
    originalMembership: membership[0],
    creatorEvidence: { ...bundle.migration.creatorEvidence, ...identity },
  };
}

function checkService(expected, observed, requireSuspended = false) {
  if (
    observed.id !== expected.serviceId ||
    observed.ownerId !== expected.ownerId ||
    observed.type !== expected.type ||
    observed.autoDeploy !== "no" ||
    !["not_suspended", "suspended"].includes(observed.suspended) ||
    observed.serviceDetails?.preDeployCommand !== "" ||
    (requireSuspended && observed.suspended !== "suspended")
  )
    fail("fleet_observation");
  return observed;
}
async function observeFleet(render, fleet) {
  const observations = [];
  for (const expected of fleet)
    observations.push(
      checkService(expected, await render.getService(expected.serviceId), true),
    );
  return observations;
}

async function authenticateReader(openReader, client, identity, binding) {
  const reader = await openReader();
  try {
    for (const key of ["host", "port", "database"])
      if (
        !client.connectionParameters?.[key] ||
        reader.connectionParameters?.[key] !== client.connectionParameters[key]
      )
        fail("reader_endpoint");
    const auth = await readJson(
      reader,
      `SELECT jsonb_build_object('sessionUser',session_user,'currentUser',current_user)`,
    );
    if (auth.sessionUser !== readerRole || auth.currentUser !== readerRole)
      fail("reader_authentication");
    return await readJson(
      reader,
      renderHistorical89PreparationReadSql(identity, binding),
    );
  } finally {
    await reader.end();
  }
}

function expectedPermit(plan, state = "open") {
  return {
    ...plan.binding,
    kind: phase.kind,
    admissionIdentityDigest: plan.identityDigest,
    terminalCatalogDigest: plan.reviewedTerminalCatalogDigest,
    epoch: String(plan.coordinates.epoch),
    generation: String(plan.coordinates.generation),
    nonce: plan.coordinates.nonce,
    state,
  };
}

/** Public composition accepts real connection/provider/storage adapters only.
 * Request data cannot select a registry, provide SQL, or assert authorization. */
export async function runHistorical89Operation({
  coordinator,
  openReader,
  readerPassword,
  render,
  journal,
  captureBackup,
  request,
}) {
  const bundle = readReviewedHistorical89Bundle();
  const approvalReference = readReviewedHistorical89BundleDigest();
  if (
    Object.keys(request).sort().join() !== "artifactPath,sourceCommit" ||
    !/^[a-f0-9]{40}$/u.test(request.sourceCommit)
  )
    fail("request_shape");
  const artifactDigest = assertHistorical89ExecutingSource(
    request,
    bundle.migration.identity,
  );
  journal.put("invocation", {
    request,
    approvalReference,
    artifactDigest,
  });
  const fleet = [...bundle.preparation.fleet].sort((a, b) =>
    a.role.localeCompare(b.role, "en"),
  );
  let client = await coordinator.open();
  const submit = (key, exact, execute) =>
    submitHistorical89Transition({
      client,
      journal,
      key,
      request: exact,
      execute,
    });
  try {
    const backend = await readJson(client, historical89BackendSql);
    for (const key of ["systemIdentifier", "databaseOid", "databaseName"])
      if (backend[key] !== bundle.migration.identity[key])
        fail("database_identity");
    // Serialize this bounded coordinator independently of the accepted xact lock.
    if (
      (await readHistorical89One(
        client,
        "SELECT pg_try_advisory_lock(1783285769,90)",
      )) !== true
    )
      fail("coordinator_active");
    let original = journal.get("original");
    let identity = journal.get("identity");
    if (!identity) {
      const capture = await captureHistorical89Prerequisites({
        client,
        idleClient: true,
        expected: {
          ...Object.fromEntries(
            ["systemIdentifier", "databaseOid", "databaseName"].map((k) => [
              k,
              backend[k],
            ]),
          ),
          sessionUser: "reviewrouter",
          currentRole: "reviewrouter",
        },
        source: {
          commit: request.sourceCommit,
          label: "historical89-preparation",
        },
      });
      if (!capture.collectionComplete) fail("preliminary_capture");
      original = await observe(client, bundle);
      compareHistorical89Original(bundle, original);
      identity = journal.once("identity", () => ({
        operationId: randomUUID(),
        ...Object.fromEntries(
          ["systemIdentifier", "databaseOid", "databaseName"].map((k) => [
            k,
            backend[k],
          ]),
        ),
        sourceCommit: request.sourceCommit,
        artifactReference: artifactDigest,
        approvalReference,
        baselineReference: digest(original),
        fleetReference: digest(fleet),
        serviceIds: fleet.map((s) => s.serviceId),
      }));
    }
    for (const [key, value] of Object.entries({
      sourceCommit: request.sourceCommit,
      artifactReference: artifactDigest,
      approvalReference,
      fleetReference: digest(fleet),
      serviceIds: fleet.map((s) => s.serviceId),
    }))
      if (!same(identity[key], value)) fail("durable_identity_conflict");
    let binding = journal.get("binding");
    let recovery = journal.get("recovery");
    const terminalResumeStarted = fleet.some((service) =>
      journal.get(`${service.serviceId}.resume-intent`),
    );
    const admissionRestoreStarted = !!journal.get("admission-restore.request");
    const validateRetainedService = (service) => {
      const intent = journal.get(`${service.serviceId}.intent`);
      const result = journal.get(`${service.serviceId}.result`);
      if (!intent || !result || result.intentDigest !== digest(intent))
        fail("retained_service");
      for (const link of [...result.attempts, ...result.transport]) {
        const retained = journal.get(link.key);
        if (!retained || digest(retained) !== link.digest)
          fail("retained_transport");
      }
      checkService(service, result.observed, true);
      return {
        serviceId: service.serviceId,
        intent: digest(intent),
        result: digest(result),
      };
    };
    // Partial preparation can retain service results before binding publication.
    // Verify their linked bytes before any resumed checkpoint or provider call.
    for (const service of fleet)
      if (journal.get(`${service.serviceId}.result`))
        validateRetainedService(service);
    const validateRetainedFence = async () => {
      const fence = journal.get("fence");
      if (recovery) await verifyHistorical89RetainedBackup(journal, recovery);
      if (
        !recovery ||
        !fence ||
        digest(fence) !== binding.externalFenceSha256 ||
        fence.operationId !== identity.operationId ||
        !same(journal.get("recovery"), recovery) ||
        binding.recoveryIdentitySha256 !== recovery.sha256 ||
        !same(
          binding,
          historical89InPlaceCustodyBinding({
            ...identity,
            externalFenceSha256: digest(fence),
            recoveryIdentitySha256: recovery.sha256,
          }),
        )
      )
        fail("retained_fence");
      const expectedServices = fleet.map(validateRetainedService);
      if (
        !same(fence.services, expectedServices) ||
        fence.fleet.length !== fleet.length
      )
        fail("retained_service");
      fleet.forEach((service, index) =>
        checkService(service, fence.fleet[index], true),
      );
    };
    const effectiveDatabaseAcl = (observation) => {
      const effective = { ...historical89OriginalDatabaseAcl(observation) };
      delete effective.raw;
      return effective;
    };
    const restoreFleetAfterCommit = async (result) => {
      try {
        for (const service of fleet) {
          journal.put(`${service.serviceId}.resume-intent`, {
            operationId: identity.operationId,
            serviceId: service.serviceId,
            recoveryIdentitySha256: binding.recoveryIdentitySha256,
          });
          await render.resume(service.serviceId);
        }
        for (const service of fleet) {
          let observed;
          for (let poll = 0; poll < 6; poll++) {
            observed = checkService(
              service,
              await render.getService(service.serviceId),
            );
            if (observed.suspended === "not_suspended") break;
            if (poll < 5) await delay(250);
          }
          if (observed?.suspended !== "not_suspended")
            fail("resume_unobserved");
          journal.once(`${service.serviceId}.resume-result`, () => ({
            observed,
            observedAt: new Date().toISOString(),
          }));
        }
        await submit(
          admissionRestoreStarted
            ? "admission-restore-after-rerestriction"
            : "admission-restore",
          { sql: plan.admissionRestoreSql, original: original.connectAcl },
          async () => {
            await client.query(plan.admissionRestoreSql);
            const restored = await readJson(
              client,
              renderHistorical89ConnectAclSql,
            );
            if (
              !same(
                effectiveDatabaseAcl(restored),
                effectiveDatabaseAcl(original.connectAcl),
              )
            )
              fail("admission_restore_unverified");
            return { restored: true };
          },
        );
        return result;
      } catch (error) {
        const unresolved = [];
        for (const service of fleet) {
          journal.once(
            `${service.serviceId}.resume-compensation-intent`,
            () => ({
              operationId: identity.operationId,
              serviceId: service.serviceId,
            }),
          );
          try {
            await render.suspend(service.serviceId);
            let observed;
            for (let poll = 0; poll < 6; poll++) {
              observed = checkService(
                service,
                await render.getService(service.serviceId),
              );
              if (observed.suspended === "suspended") break;
              if (poll < 5) await delay(250);
            }
            if (observed?.suspended !== "suspended")
              throw new Error("compensation_unobserved", { cause: error });
            journal.once(
              `${service.serviceId}.resume-compensation-result`,
              () => ({ observed }),
            );
          } catch {
            unresolved.push(service.serviceId);
          }
        }
        if (unresolved.length)
          fail(`resume_compensation_partial:${unresolved.join(",")}`);
        throw error;
      }
    };
    if (binding) {
      await validateRetainedFence();
      if (!terminalResumeStarted) await observeFleet(render, fleet);
    }
    const checkpoint = async (key, parts, stage, binding) =>
      submit(
        key,
        { identity, binding: binding ?? null, parts },
        async ({ rollbackConfirmed }) => {
          let committing = false;
          try {
            await client.query(parts.beginSql);
            const presence = await readJson(
              client,
              "SELECT jsonb_build_object('present',to_regnamespace('release_operation_custody') IS NOT NULL,'roles',(SELECT count(*) FROM pg_roles WHERE rolname IN ('reviewrouter_operation_custody_reader','reviewrouter_operation_custody_owner')))",
            );
            if (stage === "prepared" && !presence.present) {
              if (presence.roles !== 0) fail("preparation_roles_present");
              const actual = await observe(client, bundle);
              compareHistorical89Original(bundle, actual);
              if (digest(actual) !== identity.baselineReference)
                fail("original_changed");
              journal.put("original", actual);
              original = actual;
            }
            if (!original) fail("durable_original_missing");
            await client.query(parts.bodySql);
            const row = await readJson(client, parts.readSql);
            const actual = await observe(client, bundle);
            compareHistorical89PreparationStage(
              bundle,
              stage,
              { ...actual, preparation: row },
              identity,
              binding,
            );
            committing = true;
            await client.query(parts.commitSql);
            return row;
          } catch (error) {
            if (!committing) {
              const result = await client.query("ROLLBACK;");
              if (result.command === "ROLLBACK") rollbackConfirmed();
            }
            throw error;
          }
        },
      );
    await checkpoint(
      "prepare",
      renderHistorical89PreparationPrepareParts(identity),
      "prepared",
    );
    original = journal.get("original");
    if (!original || digest(original) !== identity.baselineReference)
      fail("original_reference");
    const finalizedHint = await readJson(
      client,
      "SELECT jsonb_build_object('finalized',to_regclass('release_operation_custody.operation_permit') IS NOT NULL)",
    );
    if (finalizedHint.finalized && !binding) fail("durable_binding_missing");
    let row = await readJson(
      client,
      renderHistorical89PreparationReadSql(
        identity,
        finalizedHint.finalized ? binding : undefined,
      ),
    );
    const validatePreparationEvidence = () => {
      for (const key of ["externalFenceSha256", "recoveryIdentitySha256"])
        if (row.evidence[key] !== binding[key])
          fail("retained_preparation_evidence");
      for (const service of fleet)
        if (
          row.services[service.serviceId]?.intentSha256 !==
            digest(journal.get(`${service.serviceId}.intent`)) ||
          row.services[service.serviceId]?.resultSha256 !==
            digest(journal.get(`${service.serviceId}.result`))
        )
          fail("final_service_evidence");
    };
    if (binding) validatePreparationEvidence();
    const transition = async (key, make, field, expected) => {
      const persisted = journal.get(`${key}.request`);
      const input = persisted?.transition ?? make(Number(row.revision));
      const rendered =
        field === "evidence"
          ? renderHistorical89PreparationObserve(identity, input)
          : renderHistorical89PreparationService(identity, input);
      await submit(key, { transition: input, sql: rendered.sql }, async () =>
        readJson(client, rendered.sql),
      );
      row = await readJson(
        client,
        renderHistorical89PreparationReadSql(identity),
      );
      if (
        !same(
          field === "evidence"
            ? row.evidence[input.kind]
            : row.services[input.serviceId]?.[
                input.phase === "intent" ? "intentSha256" : "resultSha256"
              ],
          expected,
        )
      )
        fail("transition_observation");
    };
    if (admissionRestoreStarted)
      await restrictAdmission("terminal-rerestriction");
    await provisionHistorical89Reader(
      client,
      identity,
      finalizedHint.finalized ? binding : undefined,
      readerPassword,
    );
    // A missing original CONNECT capability fails closed; never suspend services
    // first or widen admission just to make this authentication check pass.
    await authenticateReader(
      openReader,
      client,
      identity,
      finalizedHint.finalized ? binding : undefined,
    );
    if (!binding) {
      for (const service of fleet) {
        const key = service.serviceId;
        const observed = checkService(service, await render.getService(key));
        const intent = journal.once(`${key}.intent`, () => ({
          operationId: identity.operationId,
          serviceId: key,
          method: "POST",
          resource: `/services/${key}/suspend`,
          observed,
        }));
        const intentDigest = digest(intent);
        await transition(
          `${key}-intent`,
          (expectedRevision) => ({
            expectedRevision,
            serviceId: key,
            phase: "intent",
            digest: intentDigest,
          }),
          "service",
          intentDigest,
        );
        let result = journal.get(`${key}.result`);
        if (!result) {
          let latest = observed;
          const attempts = journal
            .keys(`${key}.suspend-`)
            .filter((k) => k.endsWith(".request"));
          if (latest.suspended !== "suspended" && attempts.length < 2) {
            const attempt = `${key}.suspend-${attempts.length}`;
            journal.put(`${attempt}.request`, {
              intentDigest,
              attemptedAt: new Date().toISOString(),
            });
            try {
              await render.suspend(key);
              journal.put(`${attempt}.response`, {
                outcome: "acknowledged-202",
              });
            } catch {
              journal.put(`${attempt}.response`, {
                outcome: "POST-outcome-unknown",
              });
            }
          }
          for (let poll = 0; poll < 6; poll++) {
            latest = checkService(service, await render.getService(key));
            if (latest.suspended === "suspended") break;
            if (poll < 5) await delay(250);
          }
          if (latest.suspended !== "suspended") fail("suspension_unobserved");
          result = {
            intentDigest,
            observed: latest,
            observedAt: new Date().toISOString(),
            attempts: journal
              .keys(`${key}.suspend-`)
              .map((k) => ({ key: k, digest: digest(journal.get(k)) })),
            transport: journal
              .keys("provider-")
              .map((k) => ({ key: k, digest: digest(journal.get(k)) })),
          };
          journal.put(`${key}.result`, result);
        }
        const resultDigest = digest(result);
        await transition(
          `${key}-result`,
          (expectedRevision) => ({
            expectedRevision,
            serviceId: key,
            phase: "result",
            digest: resultDigest,
          }),
          "service",
          resultDigest,
        );
      }
      const fleetNow = await observeFleet(render, fleet);
      await restrictAdmission();
      await client.query(renderHistorical89FleetQuiescenceGuardSql);
      recovery = await captureBackup(identity);
      await client.query(renderHistorical89FleetQuiescenceGuardSql);
      if (
        recovery?.format !== "postgresql-custom-gpg" ||
        !/^sha256:[a-f0-9]{64}$/u.test(recovery?.sha256 ?? "") ||
        !Number.isSafeInteger(recovery?.bytes) ||
        recovery.bytes <= 0
      )
        fail("backup_metadata");
      const fence = journal.once("fence", () => ({
        operationId: identity.operationId,
        holder: `coordinator:${identity.operationId}`,
        fleet: fleetNow,
        services: fleet.map((s) => ({
          serviceId: s.serviceId,
          intent: digest(journal.get(`${s.serviceId}.intent`)),
          result: digest(journal.get(`${s.serviceId}.result`)),
        })),
        establishedAt: new Date().toISOString(),
      }));
      const evidence = {
        recoveryIdentitySha256: recovery.sha256,
        externalFenceSha256: digest(fence),
      };
      for (const [kind, value] of Object.entries(evidence))
        await transition(
          `evidence-${kind.toLowerCase()}`,
          (expectedRevision) => ({ expectedRevision, kind, digest: value }),
          "evidence",
          value,
        );
      binding = historical89InPlaceCustodyBinding({ ...identity, ...evidence });
      // Binding publication is intent, not proof of a committed Finalize.
      journal.put("binding", binding);
    }
    await validateRetainedFence();
    validatePreparationEvidence();
    if (!terminalResumeStarted) await observeFleet(render, fleet);
    if (!journal.get("finalize.complete")) {
      const expectedRevision = journal.once("finalize-revision", () =>
        Number(row.revision),
      );
      await checkpoint(
        "finalize",
        renderHistorical89PreparationFinalizeParts(
          identity,
          binding,
          expectedRevision,
        ),
        "finalized",
        binding,
      );
    }
    row = await readJson(
      client,
      renderHistorical89PreparationReadSql(identity, binding),
    );
    for (const service of fleet)
      if (
        row.services[service.serviceId]?.intentSha256 !==
          digest(journal.get(`${service.serviceId}.intent`)) ||
        row.services[service.serviceId]?.resultSha256 !==
          digest(journal.get(`${service.serviceId}.result`))
      )
        fail("final_service_evidence");
    if (!terminalResumeStarted) await observeFleet(render, fleet);
    async function restrictAdmission(transitionKey = "restriction") {
      const restrictionSql = renderHistorical89AdmissionRestrictionSql(
        original.connectAcl,
      );
      await submit(
        transitionKey,
        { sql: restrictionSql, original: original.connectAcl },
        async () => {
          const actual = await readJson(
            client,
            renderHistorical89ConnectAclSql,
          );
          if (
            same(
              effectiveDatabaseAcl(actual),
              effectiveDatabaseAcl(original.connectAcl),
            )
          ) {
            await client.query(restrictionSql);
          } else {
            const acl = assertHistorical89OriginalConnectAcl(
              original.connectAcl,
            );
            const roles = await readJson(
              client,
              "SELECT jsonb_build_object('reader',(SELECT oid::text FROM pg_roles WHERE rolname='reviewrouter_operation_custody_reader'),'owner',(SELECT oid::text FROM pg_roles WHERE rolname='reviewrouter'))",
            );
            const entries = original.connectAcl.entries.filter(
              (entry) => !acl.withdraw.some((w) => same(w, entry)),
            );
            entries.push({
              grantee: readerRole,
              granteeOid: roles.reader,
              grantor: "reviewrouter",
              grantorOid: roles.owner,
              privilege: "CONNECT",
              grantable: false,
            });
            const sort = (values) =>
              [...values].sort(
                (a, b) =>
                  a.privilege.localeCompare(b.privilege, "en") ||
                  Number(a.granteeOid) - Number(b.granteeOid) ||
                  Number(a.grantorOid) - Number(b.grantorOid),
              );
            if (
              !same(sort(actual.entries), sort(entries)) ||
              actual.raw === null ||
              ["database", "allowConnections", "connectionLimit", "owner"].some(
                (key) => actual[key] !== original.connectAcl[key],
              )
            )
              fail("restriction_third_state");
            await client.query(renderHistorical89SessionDrainSql);
          }
          return { restrictedAt: new Date().toISOString() };
        },
      );
    }
    await restrictAdmission();
    await authenticateReader(openReader, client, identity, binding);
    await client.query(renderHistorical89FleetQuiescenceGuardSql);
    let input = journal.get("plan-input");
    if (!input) {
      const actual = await observe(client, bundle);
      const terminal = materializeHistorical89ReviewedTerminal(
        bundle.migration,
        binding,
      );
      const fence = journal.get("fence");
      input = {
        admission: {
          ...bundle.migration.identity,
          ...binding,
          catalogDigest: digest(actual.catalog),
          providerEffectIds: fleet.map(
            (s) =>
              `durable-request:${digest(journal.get(`${s.serviceId}.intent`))}`,
          ),
          qualifiedAt: new Date().toISOString(),
          gateStatus: "closed",
          custodyDigest: digest(actual.gate),
        },
        ledger: actual.ledger,
        baselineCatalog: actual.catalog,
        defaultAcl: actual.defaultAcl,
        creatorEvidence: actual.creatorEvidence,
        originalMembership: original.originalMembership,
        gate: actual.gate,
        connectAcl: original.connectAcl,
        coordinates: { epoch: 1, nonce: nonce(), generation: 1 },
        reviewedTerminalCatalog: terminal.catalog,
        reviewedTerminalCatalogDigest: terminal.digest,
        terminalCatalogProvenance: "reviewed-registry",
        preconditions: {
          recovery: {
            recoveryIdentitySha256: binding.recoveryIdentitySha256,
            artifactDigest: recovery.sha256,
            capturedAt: recovery.capturedAt,
            dumpReadable: true,
            retained: true,
          },
          admission: {
            status: "closed",
            connectAclDigest: digest(original.connectAcl),
            restrictedAt: journal.get("restriction.complete").value
              .restrictedAt,
          },
          automation: {
            automaticMigrationsDisabled: true,
            declaredServices: fleet.map((s) => ({
              serviceId: s.serviceId,
              autoDeploy: "no",
              suspended: "suspended",
            })),
          },
          fence: {
            externalFenceSha256: binding.externalFenceSha256,
            holder: fence.holder,
            scope: identity.serviceIds,
            durable: true,
            survivesCoordinatorDeath: true,
            establishedAt: fence.establishedAt,
          },
        },
      };
      journal.put("plan-input", input);
    }
    let plan = planHistorical89InPlaceOperation(input);
    if (plan.authorization.authorizesProductionMutation !== true)
      fail("production_mutation_not_authorized");
    // Durable plan inputs are never refreshed on restart. Re-observe and match
    // them before opening a permit, including non-CONNECT grants and the gate.
    const currentBaseline = await observe(client, bundle);
    const retainedTerminalRestart =
      inspectHistorical89InPlaceLedger(currentBaseline.ledger).count ===
        phase.targetCount &&
      !!binding &&
      journal
        .keys("migration-")
        .some((key) => key.endsWith(".attempt-0.start"));
    if (!retainedTerminalRestart)
      for (const [actual, expected] of [
        [currentBaseline.catalog, input.baselineCatalog],
        [currentBaseline.ledger, input.ledger],
        [currentBaseline.defaultAcl, input.defaultAcl],
        [currentBaseline.originalMembership, input.originalMembership],
        [currentBaseline.gate, input.gate],
        [currentBaseline.creatorEvidence, input.creatorEvidence],
      ])
        if (!same(actual, expected)) fail("persisted_baseline_changed");
    const saveVerification = (coordinates) => {
      const verification = {
        version: 1,
        admission: plan.admission,
        coordinates,
        reviewedTerminalCatalogDigest: plan.reviewedTerminalCatalogDigest,
        originalMembership: original.originalMembership,
        baselineObjectAcl: original.objectAcl,
        creatorEvidence: original.creatorEvidence,
      };
      const key = `verification-${coordinates.epoch}`;
      const pin = journal.putBytes(
        `${key}.request`,
        JSON.stringify(verification),
      );
      journal.put(`${key}.pin`, {
        digest: pin,
        operationId: identity.operationId,
      });
      parseHistorical89Verification(
        journal.bytes(`${key}.request`),
        identity.operationId,
        pin,
      );
    };
    saveVerification(input.coordinates);
    await submit("permit", { sql: plan.openPermitSql }, async () => {
      const current = await readHistorical89One(
        client,
        renderManagedOperationCurrentPermitSql(binding),
      );
      if (current === null) return readJson(client, plan.openPermitSql);
      if (!same(current, expectedPermit(plan))) fail("permit_request_conflict");
      return current;
    });
    const reconcile = async (migrationKey) => {
      await client.end();
      client = await coordinator.open();
      if (
        (await readHistorical89One(
          client,
          "SELECT pg_try_advisory_lock(1783285769,90)",
        )) !== true
      )
        fail("coordinator_active");
      const attemptKeys = journal
        .keys(`${migrationKey}.attempt-`)
        .filter((k) => k.endsWith(".start"));
      const submitted = journal.get(attemptKeys.at(-1));
      const backendState = await historical89BackendState(
        client,
        submitted.backend,
      );
      const actual = await observe(client, bundle);
      const currentPermit = await readHistorical89One(
        client,
        renderManagedOperationCurrentPermitSql(binding),
      );
      let receipt;
      const reader = await openReader();
      try {
        for (const key of ["host", "port", "database"])
          if (
            !client.connectionParameters?.[key] ||
            reader.connectionParameters?.[key] !==
              client.connectionParameters[key]
          )
            fail("reader_endpoint");
        const auth = await readJson(
          reader,
          "SELECT jsonb_build_object('role',session_user,'currentRole',current_user)",
        );
        if (auth.role !== readerRole || auth.currentRole !== readerRole)
          fail("reader_authentication");
        await readJson(
          reader,
          renderHistorical89PreparationReadSql(identity, binding),
        );
        receipt = await readHistorical89One(reader, plan.effectReadSql);
      } finally {
        await reader.end();
      }
      await validateRetainedFence();
      if (!terminalResumeStarted) await observeFleet(render, fleet);
      const history = inspectHistorical89InPlaceLedger(actual.ledger);
      const aclDelta =
        history.count === phase.targetCount
          ? assertHistorical89InPlaceAclDelta({
              baseline: original.objectAcl,
              terminal: actual.objectAcl,
              creators: plan.creators,
            })
          : undefined;
      return reconcileHistorical89InPlaceOperation({
        plan,
        backendState,
        rollbackConfirmed:
          history.count === phase.baselineCount &&
          digest(actual.catalog) === plan.admission.catalogDigest,
        ledger: actual.ledger,
        terminalCatalog: actual.catalog,
        gate: actual.gate,
        memberships: [actual.originalMembership],
        originalMembership: original.originalMembership,
        aclDelta,
        receipt,
        currentPermit,
        fenceHeld: true,
      });
    };
    const advanceEpoch = async (epoch, advance) => {
      if (
        advance.expectedEpoch !== epoch ||
        advance.expectedNonce !== plan.coordinates.nonce
      )
        fail("epoch_request_conflict");
      const sql = renderManagedOperationAdvanceEpochSql(binding, advance);
      const nextCoordinates = {
        epoch: epoch + 1,
        generation: input.coordinates.generation,
        nonce: advance.nextNonce,
      };
      const nextPlan = planHistorical89InPlaceOperation({
        ...input,
        coordinates: nextCoordinates,
      });
      journal.put(`plan-input-${epoch + 1}`, {
        ...input,
        coordinates: nextCoordinates,
      });
      // Persist the original strict verifier request and its independent pin
      // before the epoch effect; no new migration can outrun these bytes.
      saveVerification(nextCoordinates);
      await submit(`advance-${epoch}`, { advance, sql }, async () => {
        const current = await readHistorical89One(
          client,
          renderManagedOperationCurrentPermitSql(binding),
        );
        if (same(current, expectedPermit(nextPlan))) return current;
        if (!same(current, expectedPermit(plan))) fail("epoch_permit_mismatch");
        return readJson(client, sql);
      });
      if (
        !same(
          await readHistorical89One(
            client,
            renderManagedOperationCurrentPermitSql(binding),
          ),
          expectedPermit(nextPlan),
        )
      )
        fail("epoch_permit_mismatch");
      plan = nextPlan;
    };
    // At most one new migration attempt per invocation. A previously submitted
    // transaction is reconciled before any epoch CAS or further migration SQL.
    for (let epoch = 1; epoch <= 8; epoch++) {
      const migrationKey = `migration-${epoch}`;
      const submittedAttempts = journal
        .keys(`${migrationKey}.attempt-`)
        .filter((key) => key.endsWith(".start"));
      if (submittedAttempts.length > 0) {
        const pendingAdvance = journal.get(`epoch-${epoch}`);
        if (pendingAdvance) {
          const advancedPlan = planHistorical89InPlaceOperation({
            ...input,
            coordinates: {
              epoch: epoch + 1,
              generation: input.coordinates.generation,
              nonce: pendingAdvance.nextNonce,
            },
          });
          const current = await readHistorical89One(
            client,
            renderManagedOperationCurrentPermitSql(binding),
          );
          if (same(current, expectedPermit(advancedPlan))) {
            if (!journal.get(`advance-${epoch}.request`))
              fail("epoch_request_missing");
            await advanceEpoch(epoch, pendingAdvance);
            continue;
          }
        }
        const result = await reconcile(migrationKey);
        if (result.decision === "reconciled-without-replay")
          return restoreFleetAfterCommit({
            outcome: "committed-96",
            receiptDigest: result.effectFingerprint,
          });
        if (result.decision !== "resume-same-operation")
          return { outcome: "fenced-unresolved", reasons: result.reasons };
        const advance = journal.once(`epoch-${epoch}`, () => ({
          expectedEpoch: epoch,
          expectedNonce: plan.coordinates.nonce,
          nextNonce: nonce(),
        }));
        await advanceEpoch(epoch, advance);
        continue;
      }
      if (
        !same(
          await readHistorical89One(
            client,
            renderManagedOperationCurrentPermitSql(binding),
          ),
          expectedPermit(plan),
        )
      )
        fail("permit_coordinates");
      await validateRetainedFence();
      await authenticateReader(openReader, client, identity, binding);
      if (!terminalResumeStarted) await observeFleet(render, fleet);
      await submit(
        migrationKey,
        { sql: plan.transactionSql, coordinates: plan.coordinates },
        async () => {
          await client.query(plan.transactionSql);
          return null;
        },
      );
      const result = await reconcile(migrationKey);
      return result.decision === "reconciled-without-replay"
        ? restoreFleetAfterCommit({
            outcome: "committed-96",
            receiptDigest: result.effectFingerprint,
          })
        : { outcome: "fenced-unresolved", reasons: result.reasons };
    }
    fail("epoch_budget");
  } finally {
    await client.end().catch(() => {});
  }
}

export async function run({
  databaseConnect = connect,
  retainedOperation,
} = {}) {
  const mainUrl = requireEnv("REVIEW_ROUTER_RELEASE_MIGRATION_DATABASE_URL");
  const operationDirectory = requireEnv(
    "REVIEW_ROUTER_HISTORICAL89_OPERATION_DIRECTORY",
  );
  const client = await databaseConnect(mainUrl);
  try {
    const history = inspectHistorical89InPlaceLedger(
      await readHistorical89One(client, renderManagedLedgerSql),
    );
    if (
      history.count === phase.targetCount &&
      !existsSync(operationDirectory)
    ) {
      let reader;
      try {
        const verification = parseHistorical89Verification(
          readFileSync(
            requireEnv("REVIEW_ROUTER_HISTORICAL89_VERIFICATION_PATH"),
          ),
          requireEnv("REVIEW_ROUTER_HISTORICAL89_OPERATION_ID"),
          requireEnv("REVIEW_ROUTER_HISTORICAL89_VERIFICATION_SHA256"),
        );
        reader = await connect(
          requireEnv(
            "REVIEW_ROUTER_RELEASE_MIGRATION_CUSTODY_READER_DATABASE_URL",
          ),
        );
        return await verifyHistorical89Already96(client, reader, verification);
      } catch {
        return {
          outcome: "fenced-unresolved",
          receiptDigest: null,
          timestamp: new Date().toISOString(),
          reason: "already96_verification_failed",
        };
      } finally {
        if (reader) await reader.end().catch(() => {});
      }
    }
    if (
      history.count !== phase.baselineCount &&
      !(history.count === phase.targetCount && existsSync(operationDirectory))
    )
      fail("unexpected_ledger_state");
  } finally {
    await client.end();
  }
  if (retainedOperation) return retainedOperation();
  // Reject absent review before even constructing a mutable adapter.
  const bundle = readReviewedHistorical89Bundle();
  const readerUrl = requireEnv(
    "REVIEW_ROUTER_RELEASE_MIGRATION_CUSTODY_READER_DATABASE_URL",
  );
  const journal = createHistorical89Journal(operationDirectory);
  const render = createHistorical89Render({
    token: requireEnv("RENDER_API_KEY"),
    journal,
    serviceIds: bundle.preparation.fleet.map((s) => s.serviceId),
  });
  return runHistorical89Operation({
    coordinator: { open: () => connect(mainUrl) },
    openReader: () =>
      connectHistorical89Reader({ connectionString: readerUrl }),
    readerPassword: decodeURIComponent(new URL(readerUrl).password),
    render,
    journal,
    captureBackup: (identity) =>
      captureHistorical89RetainedBackup({
        databaseUrl: mainUrl,
        journal,
        operationId: identity.operationId,
        retentionKey: requireEnv("REVIEW_ROUTER_HISTORICAL89_RETENTION_KEY"),
      }),
    request: {
      sourceCommit: requireEnv("REVIEW_ROUTER_HISTORICAL89_SOURCE_COMMIT"),
      artifactPath: requireEnv("REVIEW_ROUTER_HISTORICAL89_ARTIFACT_PATH"),
    },
  });
}

export async function runHistorical89Cli() {
  try {
    const result = await run();
    console.log(JSON.stringify(result));
    process.exit(
      result.outcome === "committed-96" || result.outcome === "already-96"
        ? 0
        : 1,
    );
  } catch (error) {
    const raw = String(error?.message ?? "");
    let message =
      /^(?:historical89_coordinator|historical89_capture|render_historical89_admission_rejected|render_historical89_operation_rejected|render_historical89_boundary_rejected|render_managed_cutover_rejected|render_managed_catalog_rejected|render_schema_handoff_rejected):[a-zA-Z0-9_:.-]+$/u.test(
        raw,
      )
        ? raw
        : "operation_unresolved";
    // Never the raw message (may embed connection details or query text).
    // A Postgres SQLSTATE code and the thrown error's constructor name are
    // both short, well-known, non-sensitive classifiers safe to surface.
    if (message === "operation_unresolved") {
      const sqlstate = /^[0-9A-Z]{5}$/u.test(error?.code ?? "")
        ? error.code
        : null;
      const kind = /^[A-Za-z][A-Za-z0-9]{0,39}$/u.test(
        error?.constructor?.name ?? "",
      )
        ? error.constructor.name
        : null;
      if (sqlstate || kind)
        message = `operation_unresolved:${[kind, sqlstate].filter(Boolean).join("_")}`;
    }
    console.error(`historical89_inplace_failed:${message}`);
    process.exit(1);
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  await runHistorical89Cli();
