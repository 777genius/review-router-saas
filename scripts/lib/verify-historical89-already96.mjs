import { createHash } from "node:crypto";
import {
  assertHistorical89AdmissionIdentity,
  assertHistorical89Creators,
  renderHistorical89AdmissionPhase as phase,
  renderHistorical89ObjectAclSql,
} from "./render-historical89-admission.mjs";
import {
  assertHistorical89InPlaceAclDelta,
  classifyHistorical89InPlaceOutcome,
} from "./render-historical89-inplace-transaction.mjs";
import { historical89InPlaceCustodyBinding } from "./render-historical89-operation.mjs";
import {
  assertManagedOperationEffectReceipt,
  renderManagedOperationCurrentPermitSql,
  renderManagedOperationCustodyVerifySql,
  renderManagedOperationEffectReadSql,
} from "./render-managed-operation-custody.mjs";
import {
  renderManagedEvidenceDigest,
  renderManagedLedgerSql,
  renderManagedMembershipSql,
} from "./render-schema-handoff-policy.mjs";
import { renderManagedCatalogSql } from "./render-managed-catalog.mjs";
import { renderManagedRuntimeGateSql } from "./render-managed-workflow-cutover.mjs";

const reject = (reason) => {
  throw new Error(`already96_unresolved:${reason}`);
};
const shape = (value) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort().join(",")
    : "";
const same = (a, b) =>
  shape(a) === shape(b) && Object.entries(b).every(([k, v]) => a[k] === v);
export async function readHistorical89One(client, sql) {
  const result = await client.query(sql);
  const rows = (Array.isArray(result) ? result.at(-1) : result).rows;
  if (rows.length !== 1 || Object.keys(rows[0]).length !== 1)
    reject("ambiguous_read");
  return Object.values(rows[0])[0];
}

// Caller supplies the ORIGINAL durable qualification, never reconstructed from
// the current permit/receipt. The independent digest pins the exact file bytes;
// it is an integrity contract, not an independent production approval root.
export function parseHistorical89Verification(
  bytes,
  operationId,
  expectedDigest,
) {
  if (
    !operationId ||
    !/^sha256:[a-f0-9]{64}$/.test(expectedDigest ?? "") ||
    `sha256:${createHash("sha256").update(bytes).digest("hex")}` !==
      expectedDigest
  )
    reject("missing_or_mismatched_durable_request");
  const request = JSON.parse(bytes.toString());
  if (
    shape(request) !==
      [
        "version",
        "admission",
        "coordinates",
        "reviewedTerminalCatalogDigest",
        "originalMembership",
        "baselineObjectAcl",
        "creatorEvidence",
      ]
        .sort()
        .join(",") ||
    request.version !== 1
  )
    reject("durable_request_shape");
  if (request.admission?.operationId !== operationId)
    reject("requested_operation_mismatch");
  const identityDigest = assertHistorical89AdmissionIdentity(request.admission);
  const binding = historical89InPlaceCustodyBinding(request.admission);
  if (
    renderManagedEvidenceDigest([request.originalMembership]) !==
    request.admission.membershipDigest
  )
    reject("original_membership_binding");
  const c = request.coordinates;
  if (
    shape(c) !== "epoch,generation,nonce" ||
    ![c.epoch, c.generation].every((n) => Number.isSafeInteger(n) && n > 0) ||
    !/^[a-f0-9]{32}$/.test(c.nonce ?? "") ||
    !/^sha256:[a-f0-9]{64}$/.test(request.reviewedTerminalCatalogDigest ?? "")
  )
    reject("coordinates");
  return {
    ...request,
    identityDigest,
    binding,
    creators: assertHistorical89Creators(request.creatorEvidence),
  };
}

// Point-in-time verification only: both authenticated connections use the same
// read-only snapshot. No fence ownership, replay, admission restore or production
// authorization is inferred. An original backend still present is unresolved.
export async function verifyHistorical89Already96(client, reader, request) {
  const read = (sql) => readHistorical89One(client, sql);
  for (const key of ["host", "port", "database"])
    if (
      !client.connectionParameters?.[key] ||
      client.connectionParameters[key] !== reader.connectionParameters?.[key]
    )
      reject("reader_endpoint_mismatch");
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;");
    const identity =
      await read(`SELECT jsonb_build_object('systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()),
      'databaseOid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),'databaseName',current_database());`);
    if (
      !same(identity, {
        systemIdentifier: request.binding.systemIdentifier,
        databaseOid: request.binding.databaseOid,
        databaseName: request.binding.databaseName,
      })
    )
      reject("database_identity");
    await client.query(renderManagedOperationCustodyVerifySql(request.binding));
    const permit = await read(
      renderManagedOperationCurrentPermitSql(request.binding),
    );
    const expectedPermit = {
      ...request.binding,
      kind: phase.kind,
      admissionIdentityDigest: request.identityDigest,
      terminalCatalogDigest: request.reviewedTerminalCatalogDigest,
      epoch: String(request.coordinates.epoch),
      generation: String(request.coordinates.generation),
      nonce: request.coordinates.nonce,
      state: "terminal",
    };
    if (!same(permit, expectedPermit)) reject("terminal_permit_mismatch");
    const snapshot = await read("SELECT pg_export_snapshot();");
    if (
      typeof snapshot !== "string" ||
      !/^[A-Fa-f0-9]+-[A-Fa-f0-9]+-[0-9]+$/.test(snapshot)
    )
      reject("snapshot");
    await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;");
    await reader.query(`SET TRANSACTION SNAPSHOT '${snapshot}';`);
    const role = await readHistorical89One(
      reader,
      "SELECT jsonb_build_object('session',session_user,'current',current_user);",
    );
    if (
      !same(role, {
        session: "reviewrouter_operation_custody_reader",
        current: "reviewrouter_operation_custody_reader",
      })
    )
      reject("receipt_reader_identity");
    const receipt = assertManagedOperationEffectReceipt(
      await readHistorical89One(
        reader,
        renderManagedOperationEffectReadSql(request.binding),
      ),
      {
        binding: request.binding,
        ...request.coordinates,
        terminalCatalogDigest: request.reviewedTerminalCatalogDigest,
        admissionIdentityDigest: request.identityDigest,
      },
    );
    const backendPresent = await read(
      `SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity WHERE pid=${receipt.backendPid});`,
    );
    if (backendPresent !== false) reject("original_backend_unresolved");
    const ledger = await read(renderManagedLedgerSql);
    const terminalCatalog = await read(renderManagedCatalogSql);
    const gate = await read(
      `SET search_path = pg_catalog, public;\n${renderManagedRuntimeGateSql};`,
    );
    const memberships = await read(renderManagedMembershipSql);
    const aclDelta = assertHistorical89InPlaceAclDelta({
      baseline: request.baselineObjectAcl,
      terminal: await read(renderHistorical89ObjectAclSql),
      creators: request.creators,
    });
    const outcome = classifyHistorical89InPlaceOutcome({
      admission: request.admission,
      ledger,
      backendState: "terminated",
      rollbackConfirmed: false,
      terminalCatalog,
      reviewedCatalogDigest: request.reviewedTerminalCatalogDigest,
      gate,
      memberships,
      originalMembership: request.originalMembership,
      aclDelta,
    });
    if (outcome.status !== "committed-candidate")
      reject("current_postconditions");
    return {
      outcome: "already-96",
      receiptDigest: receipt.effectFingerprint,
      verification: "read-only-snapshot",
      authorizesProductionMutation: false,
      timestamp: new Date().toISOString(),
    };
  } finally {
    await reader.query("ROLLBACK;").catch(() => {});
    await client.query("ROLLBACK;").catch(() => {});
  }
}
