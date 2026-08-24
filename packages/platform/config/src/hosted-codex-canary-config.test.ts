import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { assertHostedCodexProductionReadiness } from "./index";

function createEphemeralCanaryAuthority(): Readonly<{
  id: string;
  publicKey: string;
}> {
  const { publicKey } = generateKeyPairSync("ed25519");
  return Object.freeze({
    id: `test:${publicKey.asymmetricKeyType}`,
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  });
}

function createHostedPoolReleaseConfig() {
  const commitSha = randomBytes(20).toString("hex");
  return {
    NODE_ENV: "production",
    REVIEW_ROUTER_RUNTIME_ROLE: "api",
    REVIEW_ROUTER_ENABLE_HOSTED_CODEX_POOL: "1",
    REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF:
      `777genius/review-router@${commitSha}`,
    REVIEW_ROUTER_HOSTED_POOL_ACTION_TAG: "v1.2.3",
    REVIEW_ROUTER_HOSTED_POOL_ACTION_SHA: commitSha,
    REVIEW_ROUTER_HOSTED_POOL_ACTION_DIST_SHA256:
      randomBytes(32).toString("hex"),
  };
}

describe("hosted Codex canary fault-plan config", () => {
  it("fails closed for incomplete or non-API authority config", () => {
    const base = createHostedPoolReleaseConfig();
    const authority = createEphemeralCanaryAuthority();

    expect(() =>
      assertHostedCodexProductionReadiness({
        ...base,
        REVIEW_ROUTER_HOSTED_CODEX_CANARY_FAULT_AUTHORITY_KEY_ID: authority.id,
      }),
    ).toThrow("hosted_codex_canary_fault_plan_config_incomplete");
    expect(() =>
      assertHostedCodexProductionReadiness(
        {
          ...base,
          REVIEW_ROUTER_HOSTED_CODEX_CANARY_FAULT_AUTHORITY_KEY_ID:
            authority.id,
          REVIEW_ROUTER_HOSTED_CODEX_CANARY_FAULT_AUTHORITY_PUBLIC_KEY:
            authority.publicKey,
        },
        "web",
      ),
    ).toThrow("hosted_codex_canary_fault_plan_api_only");
    expect(() =>
      assertHostedCodexProductionReadiness({
        ...base,
        REVIEW_ROUTER_HOSTED_CODEX_CANARY_FAULT_AUTHORITY_KEY_ID: authority.id,
        REVIEW_ROUTER_HOSTED_CODEX_CANARY_FAULT_AUTHORITY_PUBLIC_KEY:
          authority.publicKey,
      }),
    ).not.toThrow();
  });
});
