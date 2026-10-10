import { expect, test } from "vitest";
import type { ReviewProviderConfiguration } from "@reviewrouter/features-review-config";
import type { AccountProfileView } from "./account-gateway-accounts";
import { assertGatewayReviewConfigCatalogAllowed } from "./gateway-review-config-catalog";

const gateway = {
  kind: "codex",
  authMode: "codex_account_gateway",
  gatewayBindingId: "fixture-binding",
  gatewayProfileRef: "fixture-responses",
  model: "fixture-model",
  reasoningEffort: "high",
  agenticContext: true,
  fastMode: false,
  requiredHealthy: true,
} satisfies ReviewProviderConfiguration;
const profile = {
  id: "fixture-responses",
  label: "Fixture",
  protocol: "openai-responses",
  models: ["fixture-model"],
} satisfies AccountProfileView;

// RED if a later Gateway row can bypass catalog admission, or membership is
// checked globally instead of on the selected profile and supported protocol.
test.each([
  { ...gateway, model: "fixture-other-model" },
  { ...gateway, gatewayProfileRef: "fixture-missing" },
])("refuses an unsupported secondary Gateway selection: %o", async (row) => {
  await expect(
    assertGatewayReviewConfigCatalogAllowed(
      { providers: [gateway, row] },
      async () => [
        profile,
        { ...profile, id: "fixture-other", models: ["fixture-other-model"] },
      ],
    ),
  ).rejects.toThrow("gateway_review_model_unsupported");
});

test("refuses an advertised model on an unsupported protocol", async () => {
  await expect(
    assertGatewayReviewConfigCatalogAllowed(
      { providers: [gateway] },
      async () => [{ ...profile, protocol: "openai-chat" }],
    ),
  ).rejects.toThrow("gateway_review_model_unsupported");
});

test("accepts a current advertised Responses model", async () => {
  await expect(
    assertGatewayReviewConfigCatalogAllowed(
      { providers: [gateway] },
      async () => [profile],
    ),
  ).resolves.toBe(true);
});

// RED if availability errors become an admission bypass, or a legacy save
// depends on Accounts/Gateway availability.
test("refuses Gateway admission when the catalog is unavailable", async () => {
  await expect(
    assertGatewayReviewConfigCatalogAllowed(
      { providers: [gateway] },
      async () => {
        throw new Error("fixture_catalog_unavailable");
      },
    ),
  ).rejects.toThrow("fixture_catalog_unavailable");
});

test("legacy-only configuration performs no catalog I/O", async () => {
  const legacy = {
    kind: "codex",
    authMode: "codex_subscription_oauth_rotating",
    model: "fixture-legacy",
    reasoningEffort: "high",
    agenticContext: true,
    fastMode: false,
    requiredHealthy: true,
  } satisfies ReviewProviderConfiguration;
  await expect(
    assertGatewayReviewConfigCatalogAllowed(
      { providers: [legacy] },
      async () => {
        throw new Error("catalog_must_not_be_called");
      },
    ),
  ).resolves.toBe(false);
});
