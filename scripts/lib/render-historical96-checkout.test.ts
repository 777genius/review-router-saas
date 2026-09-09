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
const full = readRenderManagedCheckoutInventory();
const historical = full.slice(0, 96);
const checkout97 = full.slice(0, 97);
const manifest = (rows: typeof full) =>
  `sha256:${createHash("sha256")
    .update(rows.map((row) => `${row.migrationName}:${row.checksum}`).join(","))
    .digest("hex")}`;
afterEach(() => reader.mockReset());

describe("trusted historical96 checkout reader", () => {
  it("validates the full98 source and returns only the exact immutable historical96", () => {
    expect(full).toHaveLength(98);
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
    expect(readRenderManagedCheckoutInventory()).toEqual(full);
    expect(reader).toHaveBeenCalledWith();
  });

  it.each([{ checkout: historical }, { checkout: checkout97 }])(
    "also accepts a complete validated older checkout (%#)",
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
      "future replacement",
      [...full.slice(0, 97), { ...full[97]!, migrationName: "000100_unknown" }],
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

  it.each([96, 97])(
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
