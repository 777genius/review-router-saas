import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertManagedOperationCustodyBinding,
  assertManagedOperationEffectReceipt,
  renderManagedOperationAdvanceEpochSql,
  renderManagedOperationCurrentPermitSql,
  renderManagedOperationCustodyBootstrap,
  renderManagedOperationCustodyContract,
  renderManagedOperationCustodyProjectionSql,
  renderManagedOperationCustodyTeardownSql,
  renderManagedOperationCustodyVerifySql,
  renderManagedOperationEffectReadSql,
  renderManagedOperationOpenPermitSql,
  renderManagedOperationPermitAssertionSql,
  renderManagedOperationRecordEffectSql,
} from "./render-managed-operation-custody.mjs";
import { renderHistorical89AdmissionPhase } from "./render-historical89-admission.mjs";

const binding = {
  operationId: "11111111-2222-3333-4444-555555555555",
  systemIdentifier: "7482837671845777452",
  databaseOid: "16385",
  databaseName: "review_router_dimy",
  recoveryIdentitySha256: `sha256:${"b".repeat(64)}`,
  externalFenceSha256: `sha256:${"c".repeat(64)}`,
};
const coordinates = {
  epoch: 1,
  nonce: "0".repeat(32),
  generation: 2,
  terminalCatalogDigest: `sha256:${"d".repeat(64)}`,
  admissionIdentityDigest: `sha256:${"e".repeat(64)}`,
};

describe("managed operation custody", () => {
  it("binds only catalog-independent identity, so a rehearsal is not circular", () => {
    expect(assertManagedOperationCustodyBinding(binding)).toEqual(binding);
    // The two observations OF a database that already carries this custody are
    // deliberately absent from the binding and live in the permit instead.
    expect(Object.keys(binding)).not.toContain("admissionIdentityDigest");
    expect(Object.keys(binding)).not.toContain("reviewedTerminalCatalogDigest");
  });

  it.each([
    ["an extra field", { extra: 1 }],
    ["a non-uuid operation", { operationId: "operation-1" }],
    ["a raw recovery digest", { recoveryIdentitySha256: "b".repeat(64) }],
    ["a missing fence", { externalFenceSha256: undefined }],
    ["a zero system identifier", { systemIdentifier: "0" }],
    ["a quoted database name", { databaseName: 'review"router' }],
  ])("rejects %s", (_label, change) => {
    expect(() =>
      assertManagedOperationCustodyBinding({
        ...binding,
        ...(change as never),
      }),
    ).toThrow("render_managed_operation_custody_rejected");
  });

  it("bootstraps as one transaction that attests itself and narrows its own grant", () => {
    const custody = renderManagedOperationCustodyBootstrap(binding);
    expect(custody.custodyEstablished).toBe(true);
    // Establishing custody is a boundary, never an authorization.
    expect(custody.authorizesMutation).toBe(false);
    expect(custody.bootstrapSql.startsWith("BEGIN")).toBe(true);
    expect(custody.bootstrapSql.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(custody.bootstrapSql.match(/\bCOMMIT;/gu)).toHaveLength(1);
    // Existing custody is authenticated, never adopted by name.
    expect(custody.bootstrapSql).toContain("custody_already_present");
    // The temporary SET-membership is removed before the attestation runs.
    const revoked = custody.bootstrapSql.indexOf(
      "REVOKE reviewrouter_operation_custody_owner FROM reviewrouter",
    );
    expect(revoked).toBeGreaterThan(0);
    expect(
      custody.bootstrapSql.indexOf("custody_attestation_failed"),
    ).toBeGreaterThan(revoked);
    // Exactly the two declared read grants touch the application schema.
    const publicGrants =
      custody.bootstrapSql.match(/GRANT [A-Z ]+ ON public\.[^;]+;/gu) ?? [];
    expect(publicGrants).toEqual(
      renderManagedOperationCustodyContract.ownerReadGrants.map(
        (identity) =>
          `GRANT SELECT ON ${identity} TO reviewrouter_operation_custody_owner;`,
      ),
    );
    expect(custody.verifySql).toBe(
      renderManagedOperationCustodyVerifySql(binding),
    );
  });

  it("keeps every attestation lookup name-based so absent custody still reports as custody", () => {
    const verify = renderManagedOperationCustodyVerifySql(binding);
    expect(verify).not.toMatch(/::regprocedure/u);
    expect(verify).not.toMatch(/::regrole/u);
    expect(verify).toContain("custody_attestation_failed");
    expect(renderManagedOperationCustodyProjectionSql).not.toMatch(
      /::regrole/u,
    );
  });

  it("renders read-only projections and protected calls without ambient mutation", () => {
    for (const sql of [
      renderManagedOperationCustodyProjectionSql,
      renderManagedOperationCurrentPermitSql(binding),
      renderManagedOperationEffectReadSql(binding),
    ])
      expect(sql).not.toMatch(
        /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|GRANT|REVOKE|TRUNCATE)\b/u,
      );
    expect(renderManagedOperationOpenPermitSql(binding, coordinates)).toContain(
      "custody_open_operation",
    );
    expect(
      renderManagedOperationRecordEffectSql(binding, coordinates),
    ).toContain("custody_record_effect");
    expect(
      renderManagedOperationPermitAssertionSql(binding, coordinates),
    ).toContain("historical89_permit_stale");
  });

  it.each([
    ["a zero epoch", { epoch: 0 }],
    ["a short nonce", { nonce: "abc" }],
    ["a zero generation", { generation: 0 }],
    ["a missing terminal catalog", { terminalCatalogDigest: undefined }],
    ["a missing admission digest", { admissionIdentityDigest: undefined }],
  ])("refuses to render an effect call with %s", (_label, change) => {
    expect(() =>
      renderManagedOperationRecordEffectSql(binding, {
        ...coordinates,
        ...(change as never),
      }),
    ).toThrow("render_managed_operation_custody_rejected");
  });

  it("refuses a compare-and-set that does not move the nonce", () => {
    expect(() =>
      renderManagedOperationAdvanceEpochSql(binding, {
        expectedEpoch: 1,
        expectedNonce: coordinates.nonce,
        nextNonce: "zz",
      }),
    ).toThrow("render_managed_operation_custody_rejected");
  });

  it("keeps teardown fail-closed for an unresolved operation", () => {
    const teardown = renderManagedOperationCustodyTeardownSql(binding);
    expect(teardown).toContain("custody_teardown_operation_unresolved");
    expect(teardown).toContain(
      "REVOKE SELECT ON public._prisma_migrations FROM reviewrouter_operation_custody_owner;",
    );
  });

  it("verifies an effect receipt by recomputing its own fingerprint", () => {
    const receipt = {
      kind: renderHistorical89AdmissionPhase.kind,
      operationId: binding.operationId,
      generation: String(coordinates.generation),
      epoch: String(coordinates.epoch),
      nonce: coordinates.nonce,
      ledgerManifest: renderHistorical89AdmissionPhase.targetManifest,
      terminalCatalogDigest: coordinates.terminalCatalogDigest,
      effectFingerprint: "",
      backendPid: 42,
      transactionId: "912",
      recordedAt: "2026-09-07T00:00:00.000Z",
      permitState: "terminal",
    };
    // Deriving the expected fingerprint the same way the routine does.
    const bound = { ...receipt };
    try {
      assertManagedOperationEffectReceipt(
        bound as never,
        {
          binding,
          ...coordinates,
        } as never,
      );
    } catch (error) {
      expect(String(error)).toContain("receipt_fingerprint");
    }
    bound.effectFingerprint = `sha256:${createHash("sha256")
      .update(
        [
          receipt.kind,
          receipt.operationId,
          coordinates.admissionIdentityDigest,
          binding.systemIdentifier,
          binding.databaseOid,
          binding.databaseName,
          binding.recoveryIdentitySha256,
          binding.externalFenceSha256,
          receipt.generation,
          receipt.epoch,
          receipt.nonce,
          receipt.ledgerManifest,
          receipt.terminalCatalogDigest,
        ].join("\n"),
      )
      .digest("hex")}`;
    const verified = assertManagedOperationEffectReceipt(
      bound as never,
      {
        binding,
        ...coordinates,
      } as never,
    );
    expect(verified.permitState).toBe("terminal");
    for (const change of [
      { epoch: "2" },
      { nonce: "1".repeat(32) },
      { generation: "3" },
      { permitState: "open" },
      { ledgerManifest: `sha256:${"0".repeat(64)}` },
      { terminalCatalogDigest: `sha256:${"9".repeat(64)}` },
      { operationId: "99999999-2222-3333-4444-555555555555" },
      { transactionId: "0" },
      { recordedAt: "2026-09-07T00:00:00Z" },
    ])
      expect(() =>
        assertManagedOperationEffectReceipt(
          { ...bound, ...(change as never) },
          { binding, ...coordinates } as never,
        ),
      ).toThrow("render_managed_operation_custody_rejected");
  });
});
