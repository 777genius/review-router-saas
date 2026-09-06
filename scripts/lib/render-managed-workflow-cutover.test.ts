import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  inspectRenderManagedWorkflowCutoverLedger,
  reconcileRenderManagedWorkflowCutover,
  renderManagedWorkflowCutoverPhase as phase,
  renderManagedWorkflowCutoverTransaction,
} from "./render-managed-workflow-cutover.mjs";
import {
  inspectRenderManagedLedger,
  readRenderManagedCheckoutInventory,
  readRenderSchemaHandoffCatalog,
  readReviewedRenderManagedContract,
  renderManagedEvidenceDigest,
} from "./render-schema-handoff-policy.mjs";
import { deriveOrderedPendingEntriesSha256 } from "../../packages/features/release-rollout/src/domain/release-migration-transition";

const catalog = readRenderManagedCheckoutInventory();
const rows = catalog.map((entry, i) => ({
  ...entry,
  id: randomUUID(),
  startedAt: "2026-09-06T00:00:00.123456Z",
  finishedAt: "2026-09-06T00:00:00.123457Z",
  rolledBackAt: null,
  appliedStepsCount: 1,
  logsPresent: i % 2 === 0,
  hasLogs: false,
  logsDigest:
    i % 2 === 0
      ? "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      : null,
}));
const pre = rows.slice(0, 92);
describe("bounded managed atomic workflow cutover", () => {
  it("pins the full-name inventory and both manifests, separately from old execution bounds", () => {
    expect(inspectRenderManagedWorkflowCutoverLedger(pre)).toMatchObject({
      count: 92,
      position: "baseline",
      manifest: phase.baselineManifest,
    });
    expect(inspectRenderManagedWorkflowCutoverLedger(rows, pre)).toMatchObject({
      count: 96,
      position: "target",
      manifest: phase.targetManifest,
      pending: [],
    });
    expect(
      deriveOrderedPendingEntriesSha256(
        catalog.slice(92).map((r) => ({
          migrationName: r.migrationName,
          migrationSqlSha256: r.checksum,
        })),
      ),
    ).toBe(phase.orderedPendingEntriesSha256);
    expect(
      catalog.filter((r) => r.migrationName.startsWith("000089")),
    ).toHaveLength(2);
    const entries = catalog.slice(92).map((row) => ({
      migrationName: row.migrationName,
      migrationSqlSha256: row.checksum,
    }));
    expect(renderManagedEvidenceDigest(entries)).toBe(
      phase.migrationArtifactDigest,
    );
    const framed = entries.map((row) => {
      const bytes = readFileSync(
        new URL(
          `../../packages/platform/db/prisma/migrations/${row.migrationName}/migration.sql`,
          import.meta.url,
        ),
      );
      return Buffer.concat([
        Buffer.from(`${row.migrationName}\0${bytes.length}\0`),
        bytes,
      ]);
    });
    expect(
      `sha256:${createHash("sha256").update(Buffer.concat(framed)).digest("hex")}`,
    ).toBe(phase.migrationBundleSha256);
    expect(readRenderSchemaHandoffCatalog()).toHaveLength(92);
    expect(() =>
      inspectRenderManagedLedger(
        readRenderSchemaHandoffCatalog(),
        rows,
        "managed-schema-handoff",
      ),
    ).toThrow("count");
    expect(() =>
      readReviewedRenderManagedContract("managed-schema-handoff"),
    ).toThrow("independent_review_missing");
  });
  it.each([0, 76, 89, 91, 93, 94, 95, 97])(
    "rejects nonendpoint count %i",
    (count) => {
      expect(() =>
        inspectRenderManagedWorkflowCutoverLedger(
          [...rows, ...rows].slice(0, count),
        ),
      ).toThrow("count");
    },
  );
  it.each([
    { id: rows[1]!.id },
    { migrationName: "000089_unknown" },
    { checksum: rows[1]!.checksum },
    { finishedAt: null },
    { finishedAt: "2026-09-06T00:00:00.123455Z" },
    { rolledBackAt: rows[0]!.startedAt },
    { appliedStepsCount: 0 },
    { hasLogs: true },
    { logsPresent: false, logsDigest: rows[0]!.logsDigest },
    { logsPresent: true, logsDigest: null },
    { startedAt: "2026-02-30T00:00:00.123456Z" },
    { extra: true },
  ])("rejects ambiguous ledger metadata %#", (change) => {
    expect(() =>
      inspectRenderManagedWorkflowCutoverLedger([
        { ...pre[0], ...change },
        ...pre.slice(1),
      ]),
    ).toThrow("history");
  });
  it.each([
    { id: randomUUID() },
    { startedAt: "2026-09-06T00:00:00.123455Z" },
    { finishedAt: "2026-09-06T00:00:00.123458Z" },
    { logsPresent: false, logsDigest: null },
  ])("retains every original prefix field %#", (change) => {
    expect(() =>
      inspectRenderManagedWorkflowCutoverLedger(
        [{ ...rows[0], ...change }, ...rows.slice(1)],
        pre,
      ),
    ).toThrow("original92_changed");
  });
  it("accepts input ordering differences without losing metadata distinctions", () => {
    expect(
      inspectRenderManagedWorkflowCutoverLedger([...rows].reverse(), pre)
        .ledgerDigest,
    ).toBe(renderManagedEvidenceDigest(rows));
  });
  it("a manifest cannot authorize construction or prove a commit", () => {
    expect(() =>
      renderManagedWorkflowCutoverTransaction({ ledger: pre } as never),
    ).toThrow("predecessor_binding");
    expect(() =>
      renderManagedWorkflowCutoverTransaction({ ledger: rows } as never),
    ).toThrow("committed_requires_reconciliation");
    expect(
      reconcileRenderManagedWorkflowCutover({ ledger: rows, original92: pre }),
    ).toEqual({ status: "hold-closed", replay: false });
  });
});

it("constructs an explicit four-body transaction with complete fenced evidence checks", () => {
  const role = {
    superuser: false,
    bypassRls: false,
    replication: false,
    createDatabase: false,
    createRole: false,
  };
  const baselineCatalog = {
    version: 1,
    serverVersionNum: 170010,
    database: "unit",
    sessionUser: "reviewrouter",
    currentUser: "reviewrouter",
    facts: [
      {
        family: "authority",
        fact: {
          roles: [
            {
              ...role,
              name: "reviewrouter_release_schema_owner",
              canLogin: false,
            },
            { ...role, name: "reviewrouter_release_migration", canLogin: true },
          ],
        },
      },
    ],
  };
  const originalMembership = {
    role: "reviewrouter_release_schema_owner",
    member: "reviewrouter",
    grantor: "postgres",
    adminOption: true,
    inheritOption: false,
    setOption: false,
  };
  const gate = { gateStatus: "closed", authzEpoch: "1", revision: "1" };
  // Deliberately unauthenticated unit evidence; the library issues no receipts.
  const binding = {
    operationId: randomUUID(),
    targetSystemIdentifier: "1",
    predecessorReceiptSha256: renderManagedEvidenceDigest(pre),
    transitionSha256: renderManagedEvidenceDigest({ test: "transition" }),
    original92LedgerDigest:
      inspectRenderManagedWorkflowCutoverLedger(pre).ledgerDigest,
    targetRecoveryWitnessSha256: renderManagedEvidenceDigest({
      database: "unit",
    }),
    custodyDigest: renderManagedEvidenceDigest(gate),
    externalExclusionSha256: renderManagedEvidenceDigest({ offline: true }),
    reviewedCatalogDigest: renderManagedEvidenceDigest(baselineCatalog),
  };
  const input = {
    ledger: pre,
    originalMembership,
    baselineCatalog,
    defaultAcl: { version: 1, rows: [] },
    gate,
    binding,
  };
  const sql = renderManagedWorkflowCutoverTransaction(input);
  expect(sql.match(/^BEGIN ISOLATION/gmu)).toHaveLength(1);
  expect(sql).not.toMatch(/^COMMIT\s*;/mu);
  expect(sql.match(/^INSERT INTO public\._prisma_migrations/gmu)).toHaveLength(
    4,
  );
  expect(sql.indexOf("pg_try_advisory_xact_lock(72707369")).toBeLessThan(
    sql.indexOf("cutover_baseline_changed"),
  );
  expect(sql).toContain("FOR SHARE");
  expect(sql).toContain("pg_stat_activity");
  expect(sql).toContain("has_any_column_privilege");
  expect(sql).toContain("c.relacl IS NULL");
  expect(sql).toContain("s.seqmax=9223372036854775807");
  expect(sql).toContain("p.prosrc=");
  expect(sql).toContain("$[0 to 91]");
  expect(sql).toContain("GRANTED BY reviewrouter RESTRICT");
  expect(sql).not.toContain("DROP TRIGGER reviewrouter_managed_retained");
  expect(sql).not.toContain("ALTER SCHEMA public OWNER");
  expect(() =>
    renderManagedWorkflowCutoverTransaction({
      ...input,
      gate: { ...gate, gateStatus: "active" },
    }),
  ).toThrow("closed_gate");
  expect(() =>
    renderManagedWorkflowCutoverTransaction({
      ...input,
      baselineCatalog: { ...baselineCatalog, facts: [] },
    }),
  ).toThrow("authority");
  expect(() =>
    renderManagedWorkflowCutoverTransaction({
      ...input,
      defaultAcl: {
        version: 1,
        rows: [
          {
            oid: "1",
            owner: "postgres",
            schema: "*",
            objectType: "r",
            entries: [
              {
                grantee: "PUBLIC",
                grantor: "postgres",
                privilege: "SELECT",
                grantable: false,
              },
            ],
          },
        ],
      },
    }),
  ).toThrow("default_acl_policy");
  const unsigned = {
    schemaVersion: 1,
    commitSha: phase.sourceCommit,
    releaseImageDigest: renderManagedEvidenceDigest({ unit: true }),
    migrationArtifactDigest: phase.migrationArtifactDigest,
    orderedMigrationEntries: catalog.slice(92).map((row) => ({
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
    postCatalogDigest: binding.reviewedCatalogDigest,
  };
  const transition = {
    ...unsigned,
    transitionSha256: renderManagedEvidenceDigest(unsigned),
  };
  binding.transitionSha256 = transition.transitionSha256;
  const permit = {
    rolloutId: binding.operationId,
    expectedPreviousReceiptSha256: binding.predecessorReceiptSha256,
    targetSystemIdentifier: binding.targetSystemIdentifier,
    targetRecoveryWitnessSha256: binding.targetRecoveryWitnessSha256,
    transitionSha256: transition.transitionSha256,
    epoch: 1,
    nonce: randomUUID(),
    sourceLegacyAmbiguity: {
      inventorySha256: renderManagedEvidenceDigest(pre),
    },
    eligibilityCutoff: "2026-09-06T00:00:00.000Z",
  };
  const observation = {
    transitionSha256: transition.transitionSha256,
    migrationArtifactDigest: phase.migrationArtifactDigest,
    migrationBundleSha256: phase.migrationBundleSha256,
    preManifestIdentity: phase.baselineManifest,
    postManifestIdentity: phase.targetManifest,
    postCatalogDigest: binding.reviewedCatalogDigest,
    permitEpoch: permit.epoch,
    permitNonce: permit.nonce,
    targetSystemIdentifier: permit.targetSystemIdentifier,
    targetRecoveryWitnessSha256: permit.targetRecoveryWitnessSha256,
    sourceLegacyAmbiguitySha256: permit.sourceLegacyAmbiguity.inventorySha256,
    eligibilityCutoff: permit.eligibilityCutoff,
  };
  const terminal = {
    catalog: baselineCatalog,
    reviewedCatalogDigest: binding.reviewedCatalogDigest,
    custody: { ...gate, authorityProbeCount: 0 },
    originalGate: gate,
    scopeStatus: {
      activated: false,
      duplicateActiveVoteLanes: 0,
      legacyProviderVoteIndex: { exact: true },
    },
    memberships: [originalMembership],
    originalMembership,
  };
  const evidence = {
    original92: pre,
    ledger: rows,
    binding,
    durableBinding: binding,
    backendState: "terminated",
    transition,
    permit,
    observation,
    terminal,
    baselineCatalog,
    rollbackConfirmed: true,
  };
  expect(reconcileRenderManagedWorkflowCutover(evidence)).toMatchObject({
    status: "committed-candidate",
    replay: false,
  });
  expect(
    reconcileRenderManagedWorkflowCutover({ ...evidence, ledger: pre }),
  ).toMatchObject({ status: "uncommitted-candidate", replay: false });
  for (const change of [
    { original92: undefined },
    { durableBinding: undefined },
    { backendState: "unknown" },
    { binding: { ...binding, operationId: randomUUID() } },
    { observation: { ...observation, permitNonce: randomUUID() } },
    {
      permit: {
        ...permit,
        expectedPreviousReceiptSha256: renderManagedEvidenceDigest(null),
      },
    },
    {
      transition: {
        ...transition,
        releaseImageDigest: renderManagedEvidenceDigest(null),
      },
    },
    { terminal: { ...terminal, scopeStatus: { activated: true } } },
    {
      terminal: {
        ...terminal,
        custody: { ...terminal.custody, revision: "2" },
      },
    },
    {
      terminal: {
        ...terminal,
        catalog: { ...baselineCatalog, database: "foreign" },
      },
    },
    { ledger: pre, rollbackConfirmed: false },
    { ledger: rows.slice(0, 95) },
  ])
    expect(
      reconcileRenderManagedWorkflowCutover({ ...evidence, ...change }),
    ).toEqual({ status: "hold-closed", replay: false });
});
