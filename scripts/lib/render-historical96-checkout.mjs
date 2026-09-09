import { createHash } from "node:crypto";
import { readRenderManagedCheckoutInventory } from "./render-schema-handoff-policy.mjs";

// Historical execution consumes exactly this manifest. Checkout-only additions
// remain subject to complete source admission before this boundary is applied.
const historical96Manifest =
  "sha256:5faad7059a2f57055086dd1571e87706c261a486e8952334401f1d91cc41c97b";
const checkoutOnlyMigrations = Object.freeze([
  "000098_certified_fork_effect_archive",
  "000099_certified_fork_proof_facts",
]);

/** @returns {ReadonlyArray<Readonly<{migrationName: string, checksum: string}>>} */
export function readRenderHistorical96CheckoutInventory() {
  const checkout = readRenderManagedCheckoutInventory();
  if (![96, 97, 98].includes(checkout.length))
    throw new Error("render_historical96_checkout_rejected:count");
  const historical = checkout.filter(
    (row) => !checkoutOnlyMigrations.includes(row.migrationName),
  );
  const manifest = `sha256:${createHash("sha256")
    .update(
      historical.map((row) => `${row.migrationName}:${row.checksum}`).join(","),
    )
    .digest("hex")}`;
  if (historical.length !== 96 || manifest !== historical96Manifest)
    throw new Error("render_historical96_checkout_rejected:manifest");
  return Object.freeze(historical);
}
