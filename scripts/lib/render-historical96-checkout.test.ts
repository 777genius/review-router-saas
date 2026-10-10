import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRenderHistorical96CheckoutInventory } from "./render-historical96-checkout.mjs";
import {
  partitionRenderSchemaHandoffCheckout,
  readRenderManagedCheckoutInventory,
} from "./render-schema-handoff-policy.mjs";

vi.mock("./render-schema-handoff-policy.mjs", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./render-schema-handoff-policy.mjs")>();
  return {
    ...actual,
    readRenderManagedCheckoutInventory: vi.fn(
      actual.readRenderManagedCheckoutInventory,
    ),
  };
});
const reader = vi.mocked(readRenderManagedCheckoutInventory);
// Preserve old immutable-prefix fixtures through 000124 explicitly.
// The complete current checkout is exercised separately.
const currentFull = readRenderManagedCheckoutInventory();
const full = currentFull.filter(
  (row) =>
    row.migrationName !== "000110_provider_api_key_workspace_management" &&
    row.migrationName !== "000125_hosted_codex_device_reconnect",
);
const historical = full.slice(0, 96);
const checkout97 = full.slice(0, 97);
const checkout98 = full.slice(0, 98);
const checkout99 = full.slice(0, 99);
const checkout105 = full.slice(0, 105);
const checkout106 = full.slice(0, 106);
const checkout107 = full.slice(0, 107);
const checkout108 = full.slice(0, 108);
const checkout109 = full.slice(0, 109);
const manifest = (rows: typeof full) =>
  `sha256:${createHash("sha256")
    .update(rows.map((row) => `${row.migrationName}:${row.checksum}`).join(","))
    .digest("hex")}`;
afterEach(() => reader.mockReset());

describe("trusted historical96 checkout reader", () => {
  it("validates the full123 source and returns only the exact immutable historical96", () => {
    expect(full).toHaveLength(123);
    expect(full[122]).toEqual({
      migrationName: "000124_personal_account_operations",
      checksum:
        "2ffa20a0d21182bad0dfdce6653bc09b436cd72ab6335ac8065a17462bd3c6a1",
    });
    expect(manifest(full)).toBe(
      "sha256:f26da08b44ad6830f4486f93ed33979acda7b5669a8550601c34dbf9c0322443",
    );
    expect(full[121]).toEqual({
      migrationName: "000123_personal_workspace_identity",
      checksum:
        "b459bbb36015e16656fa20d5712b14fa19a87a415b801e0e8ea641e9020f19f6",
    });
    expect(full[120]).toEqual({
      migrationName: "000122_review_configuration_operation_receipt",
      checksum:
        "89f9f4eadeb88733adddb051bca5e50bdc86bbb06e45905d3bdf18eedbd1386e",
    });
    expect(full[119]?.migrationName).toBe(
      "000121_review_run_gateway_execution_binding",
    );
    expect(manifest(full.slice(0, 122))).toBe(
      "sha256:5629630be035cbf1677692e840bc07c7292729bfb5bfc0c242f38179f3230df4",
    );
    expect(manifest(full.slice(0, 121))).toBe(
      "sha256:858537d185e32ef6258ddf674b5a201e6cc0c4e44fa948a18af23d6dd55905ec",
    );
    expect(manifest(full.slice(0, 120))).toBe(
      "sha256:5f01c4416620cf984ffa5fee8dbb26bcf171ae3a89ec4e4b8615e4c7c8461c64",
    );
    expect(full[118]?.migrationName).toBe("000120_review_run_runtime_snapshot");
    expect(full[117]?.migrationName).toBe(
      "000119_review_configuration_gateway_binding",
    );
    expect(full[116]?.migrationName).toBe("000118_workspace_binding_fences");
    expect(full[115]?.migrationName).toBe("000117_provider_accounts");
    expect(full[114]?.migrationName).toBe(
      "000116_hosted_codex_relay_admission_utc",
    );
    expect(full[113]?.migrationName).toBe(
      "000115_sdk_growth_v3_approved_manifest",
    );
    expect(full[112]?.migrationName).toBe("000114_sdk_growth_v3_tool_artifact");
    expect(full[111]?.migrationName).toBe("000113_sdk_growth_approval_ledger");
    expect(full[110]?.migrationName).toBe(
      "000112_sdk_growth_operator_credential",
    );
    expect(full[109]?.migrationName).toBe("000111_sdk_growth_source_binding");
    expect(full[108]?.migrationName).toBe(
      "000110_historical_unknown_scope_barrier",
    );
    expect(full[107]?.migrationName).toBe(
      "000109_sdk_growth_verifier_assignment_lock",
    );
    expect(full[106]?.migrationName).toBe(
      "000108_sdk_growth_verifier_assignment",
    );
    expect(full[105]?.migrationName).toBe(
      "000107_hosted_v4_relay_turn_contract",
    );
    expect(full[104]?.migrationName).toBe(
      "000106_sdk_growth_finalized_report_logical_identity",
    );
    expect(full[103]?.migrationName).toBe(
      "000105_sdk_growth_publication_effect",
    );
    expect(full[102]?.migrationName).toBe(
      "000104_hosted_pool_request_scoped_failover",
    );
    expect(full[101]?.migrationName).toBe(
      "000103_sdk_growth_authority_custody",
    );
    expect(full[100]?.migrationName).toBe(
      "000102_sdk_growth_current_authority",
    );
    expect(full[99]?.migrationName).toBe("000101_sdk_growth_authority");
    expect(full[98]?.migrationName).toBe("000100_hosted_codex_device_login");
    expect(full[97]?.migrationName).toBe("000099_certified_fork_proof_facts");
    expect(full[96]?.migrationName).toBe(
      "000098_certified_fork_effect_archive",
    );
    const result = readRenderHistorical96CheckoutInventory();
    expect(result).toEqual(historical);
    expect(result).toHaveLength(96);
    expect(manifest(result)).toBe(
      "sha256:5faad7059a2f57055086dd1571e87706c261a486e8952334401f1d91cc41c97b",
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.every(Object.isFrozen)).toBe(true);
    expect(readRenderManagedCheckoutInventory()).toEqual(currentFull);
    expect(reader).toHaveBeenCalledWith();
  });

  it.each([
    { checkout: historical },
    { checkout: checkout97 },
    { checkout: checkout98 },
    { checkout: checkout99 },
    { checkout: checkout105 },
    { checkout: checkout106 },
    { checkout: checkout107 },
    { checkout: checkout108 },
    { checkout: checkout109 },
    { checkout: full.slice(0, 110) },
    { checkout: full.slice(0, 111) },
    { checkout: full.slice(0, 112) },
    { checkout: full.slice(0, 113) },
    { checkout: full.slice(0, 114) },
    { checkout: full.slice(0, 115) },
    { checkout: full.slice(0, 116) },
    { checkout: full.slice(0, 117) },
    { checkout: full.slice(0, 118) },
    { checkout: full.slice(0, 119) },
    { checkout: full.slice(0, 120) },
    { checkout: full.slice(0, 121) },
    { checkout: full.slice(0, 122) },
    { checkout: full },
  ])(
    "accepts a complete validated checkout through 000124 (%#)",
    ({ checkout }) => {
      reader.mockImplementationOnce(() => {
        partitionRenderSchemaHandoffCheckout(checkout);
        return checkout;
      });
      expect(readRenderHistorical96CheckoutInventory()).toEqual(historical);
    },
  );

  it.each([92, 95])("rejects a validated %i checkout", (count) => {
    reader.mockImplementationOnce(() => {
      const rows = historical.slice(0, count);
      partitionRenderSchemaHandoffCheckout(rows);
      return rows;
    });
    expect(() => readRenderHistorical96CheckoutInventory()).toThrow(
      "render_historical96_checkout_rejected:count",
    );
  });

  it.each([
    ["missing historical entry", historical.slice(1)],
    ["duplicate", [...historical.slice(0, 95), historical[0]!]],
    ["reordered", [...historical].reverse()],
    [
      "unexpected extension",
      [...historical, { ...full[96]!, migrationName: "000099_unknown" }],
    ],
    ["duplicate extension", [...full, full[96]!]],
    [
      "sorted duplicate extension",
      [...full.slice(0, 97), full[96]!, ...full.slice(97)],
    ],
    [
      "reordered checkout-only extensions",
      [...full.slice(0, -2), full.at(-1)!, full.at(-2)!],
    ],
    [
      "relabelled 123",
      [
        ...full.slice(0, 121),
        { ...full[121]!, migrationName: "000123_relabelled" },
      ],
    ],
    [
      "relabelled 122",
      [
        ...full.slice(0, 120),
        { ...full[120]!, migrationName: "000122_relabelled" },
      ],
    ],
    [
      "relabelled 110",
      [
        ...full.slice(0, 108),
        { ...full[108]!, migrationName: "000110_relabelled" },
      ],
    ],
    [
      "unknown future extension",
      [...full, { migrationName: "000114_unknown", checksum: "a".repeat(64) }],
    ],
    [
      "future replacement",
      [...full.slice(0, 99), { ...full[99]!, migrationName: "000102_unknown" }],
    ],
    [
      "omitted SQL106 with an unclassified current-tail replacement",
      [
        ...full.slice(0, 104),
        { ...full[104]!, migrationName: "000107_unknown" },
      ],
    ],
    [
      "digest drift",
      historical.map((row, index) =>
        index === 0 ? { ...row, checksum: "a".repeat(64) } : row,
      ),
    ],
  ])(
    "fails closed for %s even if upstream admission regresses",
    (_name, rows) => {
      reader.mockReturnValueOnce(rows);
      expect(() => readRenderHistorical96CheckoutInventory()).toThrow(
        "render_historical96_checkout_rejected:",
      );
    },
  );

  it.each([
    96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111,
    112, 113, 114, 115, 116, 117, 118, 119, 120,
  ])(
    "does not hide a rejected checkout-only SQL checksum at %i",
    (extensionIndex) => {
      reader.mockImplementationOnce(() => {
        const drifted = full.map((row, index) =>
          index === extensionIndex ? { ...row, checksum: "a".repeat(64) } : row,
        );
        partitionRenderSchemaHandoffCheckout(drifted);
        return drifted;
      });
      expect(() => readRenderHistorical96CheckoutInventory()).toThrow(
        "render_schema_handoff_rejected:checkout_extension",
      );
    },
  );
});
