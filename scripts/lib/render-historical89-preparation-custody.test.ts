import { describe, expect, it } from "vitest";
import {
  assertHistorical89PreparationIdentity,
  renderHistorical89PreparationPrepare,
  renderHistorical89PreparationPrepareParts,
  renderHistorical89PreparationFinalizeParts,
  renderHistorical89PreparationReadSql,
  renderHistorical89PreparationService,
  renderHistorical89PreparationObserve,
  renderHistorical89PreparationFinalize,
} from "./render-historical89-preparation-custody.mjs";
import {
  renderManagedOperationCustodyFinalObjectsSql,
  renderManagedOperationCustodyBootstrap,
} from "./render-managed-operation-custody.mjs";

const d = `sha256:${"a".repeat(64)}`;
const identity = {
  operationId: "11111111-2222-3333-4444-555555555555",
  systemIdentifier: "7482837671845777452",
  databaseOid: "16385",
  databaseName: "review_router_dimy",
  sourceCommit: "fc6366bbc09fe03fa71b0e22744e33d6004ba9ef",
  artifactReference: d,
  approvalReference: d,
  baselineReference: d,
  fleetReference: d,
  serviceIds: ["srv-disposable"],
};
const binding = {
  operationId: identity.operationId,
  systemIdentifier: identity.systemIdentifier,
  databaseOid: identity.databaseOid,
  databaseName: identity.databaseName,
  recoveryIdentitySha256: d,
  externalFenceSha256: d,
};

describe("historical89 staged preparation renderers", () => {
  it("exposes transaction checkpoints before commit without changing accepted wrappers", () => {
    for (const [parts, wrapped] of [
      [
        renderHistorical89PreparationPrepareParts(identity),
        renderHistorical89PreparationPrepare(identity),
      ],
      [
        renderHistorical89PreparationFinalizeParts(identity, binding, 5),
        renderHistorical89PreparationFinalize(identity, binding, 5),
      ],
    ]) {
      expect(
        [parts.beginSql, parts.bodySql, parts.readSql, parts.commitSql].join(
          "\n",
        ),
      ).toBe(wrapped.sql);
      expect(parts.beginSql).toContain("pg_advisory_xact_lock(1783285769,89)");
      expect(parts.beginSql).toContain("preparation_database_identity");
      expect(parts.bodySql).toContain("preparation_catalog_attestation");
      expect(parts.bodySql).not.toContain("COMMIT;");
      expect(parts.readSql).toContain("original_connect");
      expect(parts.commitSql).toBe("COMMIT;");
    }
  });

  it("accepts no future recovery/fence digests or raw environment fields", () => {
    expect(assertHistorical89PreparationIdentity(identity)).toEqual(identity);
    for (const change of [
      { recoveryIdentitySha256: d },
      { environment: { token: "secret" } },
      { approvalReference: "approved" },
      { artifactReference: "https://secret:password@example.test" },
      { databaseOid: "0" },
      { sourceCommit: "main" },
      { serviceIds: [] },
      { serviceIds: ["srv-x", "srv-x"] },
      { serviceIds: ["srv-x'; SELECT 1;"] },
    ])
      expect(() =>
        assertHistorical89PreparationIdentity({ ...identity, ...change }),
      ).toThrow("historical89_preparation_rejected");
  });

  it("creates only staging, preserves grantors, and explicitly remains non-authorizing", () => {
    const prepared = renderHistorical89PreparationPrepare(identity);
    expect(prepared).toMatchObject({
      authorizesMutation: false,
      independentlyApproved: false,
      runnerVerdict: "NO_GO",
    });
    expect(prepared.sql).not.toContain(
      "CREATE TABLE release_operation_custody.operation_permit",
    );
    expect(prepared.sql).toContain("pg_get_userbyid(a.grantor)");
    expect(prepared.sql).toContain("a.grantor::text");
    expect(prepared.sql).toContain("preparation_identity_conflict");
    expect(prepared.sql).not.toMatch(
      /GRANT ALL|CREATE DATABASE|https?:|DATABASE_URL/u,
    );
  });

  it("attests before any elevation on transitions and limits observations to digests", () => {
    const sql = renderHistorical89PreparationService(identity, {
      expectedRevision: 1,
      serviceId: "srv-disposable",
      phase: "result",
      digest: d,
    }).sql;
    expect(sql.indexOf("preparation_catalog_attestation")).toBeLessThan(
      sql.indexOf("GRANT reviewrouter_operation_custody_owner"),
    );
    expect(sql).toContain("preparation_stale_revision");
    expect(sql).toContain("preparation_intent_before_result");
    for (const change of [
      { expectedRevision: 0 },
      { kind: "environment" },
      { digest: "secret" },
      { extra: true },
    ])
      expect(() =>
        renderHistorical89PreparationObserve(identity, {
          expectedRevision: 1,
          kind: "externalFenceSha256",
          digest: d,
          ...change,
        }),
      ).toThrow("historical89_preparation_rejected");
  });

  it("installs byte-identical accepted final objects without opening a permit", () => {
    const accepted = renderManagedOperationCustodyFinalObjectsSql(binding);
    const old = renderManagedOperationCustodyBootstrap(binding);
    expect(old.bootstrapSql).toContain(accepted);
    const final = renderHistorical89PreparationFinalize(identity, binding, 5);
    expect(final.sql).toContain(accepted.replaceAll("'", "''"));
    expect(final.sql).toContain("preparation_finalization_conflict");
    expect(final.sql).toContain("preparation_finalization_binding");
    expect(final.sql).not.toContain(
      "SELECT release_operation_custody.custody_open_operation(",
    );
    expect(final.authorizesMutation).toBe(false);
    expect(() =>
      renderHistorical89PreparationFinalize(
        identity,
        { ...binding, databaseOid: "999" },
        5,
      ),
    ).toThrow("final_identity");
  });

  it("reads with complete source-derived staged catalog checks and no role elevation", () => {
    const sql = renderHistorical89PreparationReadSql(identity);
    for (const catalog of [
      "pg_attribute",
      "pg_constraint",
      "pg_index",
      "pg_policy",
      "pg_rewrite",
      "pg_trigger",
      "pg_auth_members",
      "pg_default_acl",
      "pg_depend",
    ])
      expect(sql).toContain(catalog);
    expect(sql).toContain("preparation_catalog_attestation");
    expect(sql).not.toContain("GRANT ");
    expect(sql).not.toContain("SET LOCAL ROLE");
    expect(renderHistorical89PreparationReadSql(identity, binding)).toContain(
      "custody_attestation_failed",
    );
  });
});
