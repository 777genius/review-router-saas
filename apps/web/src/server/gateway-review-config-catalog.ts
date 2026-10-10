import type {
  ReviewConfiguration,
  ReviewProviderConfiguration,
} from "@reviewrouter/features-review-config";
import type { AccountProfileView } from "./account-gateway-accounts";

type GatewaySelection = Extract<
  ReviewProviderConfiguration,
  { authMode: "codex_account_gateway" }
>;

export function isGatewayReviewModelSupported(
  selection: GatewaySelection,
  profiles: readonly AccountProfileView[],
): boolean {
  return profiles.some(
    (profile) =>
      profile.id === selection.gatewayProfileRef &&
      profile.protocol === "openai-responses" &&
      profile.models.includes(selection.model),
  );
}

/** Validate every Gateway row against the current authorized public catalog.
 * Returns whether the caller must refresh authorization after the catalog await.
 * Legacy-only configurations perform no catalog I/O.
 */
export async function assertGatewayReviewConfigCatalogAllowed(
  config: Pick<ReviewConfiguration, "providers">,
  loadProfiles: () => Promise<readonly AccountProfileView[]>,
): Promise<boolean> {
  const selections = config.providers.filter(
    (row): row is GatewaySelection => row.authMode === "codex_account_gateway",
  );
  if (selections.length === 0) return false;
  const profiles = await loadProfiles();
  if (selections.some((row) => !isGatewayReviewModelSupported(row, profiles)))
    throw new Error("gateway_review_model_unsupported");
  return true;
}
