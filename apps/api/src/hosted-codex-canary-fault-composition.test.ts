import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { composeHostedCodexCanaryFaultPlans } from "./hosted-codex-canary-fault-composition";

const canaryFaultAuthorityPublicKey = generateKeyPairSync("ed25519")
  .publicKey.export({ type: "spki", format: "pem" })
  .toString()
  .replaceAll("\n", "\\n");

describe("hosted Codex canary fault composition", () => {
  it("composes authority only from complete production server config", () => {
    expect(
      composeHostedCodexCanaryFaultPlans({ prisma: {} as never, env: {} }),
    ).toHaveProperty("consume");
    expect(() =>
      composeHostedCodexCanaryFaultPlans({
        prisma: {} as never,
        env: {
          NODE_ENV: "production",
          REVIEW_ROUTER_HOSTED_CODEX_CANARY_FAULT_AUTHORITY_KEY_ID: "key-1",
        },
      }),
    ).toThrow("hosted_codex_canary_fault_plan_config_incomplete");
    expect(() =>
      composeHostedCodexCanaryFaultPlans({
        prisma: {} as never,
        env: {
          NODE_ENV: "test",
          REVIEW_ROUTER_HOSTED_CODEX_CANARY_FAULT_AUTHORITY_KEY_ID: "key-1",
          REVIEW_ROUTER_HOSTED_CODEX_CANARY_FAULT_AUTHORITY_PUBLIC_KEY:
            canaryFaultAuthorityPublicKey,
        },
      }),
    ).toThrow("hosted_codex_canary_fault_plan_production_only");
  });
});
