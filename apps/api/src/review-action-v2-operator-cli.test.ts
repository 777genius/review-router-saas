import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  inspectEnvironment,
  parseArguments,
} from "./review-action-v2-operator-cli";

describe("review action v2 operator CLI", () => {
  it("parses commands and exact confirmation values without interpreting them", () => {
    expect(
      parseArguments([
        "mutation",
        "activate",
        "--repo",
        "777genius/agent-teams-ai",
        "--confirm",
        "777genius/agent-teams-ai",
      ]),
    ).toEqual({
      positionals: ["mutation", "activate"],
      options: {
        repo: "777genius/agent-teams-ai",
        confirm: "777genius/agent-teams-ai",
      },
    });
  });

  it("reports only missing or malformed environment variable names", () => {
    const credential = "operator-secret";
    const result = inspectEnvironment({
      DATABASE_URL: "postgresql://example.invalid/reviewrouter",
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "private-key",
      REVIEW_ROUTER_ACTION_OIDC_AUDIENCE: "reviewrouter",
      REVIEW_ROUTER_REVIEW_RUN_AUTHORIZATION_ACTIVE_KEY_ID: "authorization-1",
      REVIEW_ROUTER_REVIEW_RUN_AUTHORIZATION_KEYS_JSON: "[]",
      REVIEW_ROUTER_REVIEW_V2_CAPABILITY_ACTIVE_KEY_ID: "capability-1",
      REVIEW_ROUTER_REVIEW_V2_CAPABILITY_KEYS_JSON: "[]",
      REVIEW_ROUTER_REVIEW_V2_PRODUCER_RELEASE_ATTESTATIONS_JSON: "[]",
      REVIEW_ROUTER_REVIEW_V2_PROVIDER_VOTE_LANES_JSON: "not-json",
      REVIEW_ROUTER_REVIEW_V2_PROJECTION_POLICY_VERSION: "1",
      REVIEW_ROUTER_REVIEW_V2_OPERATOR_CREDENTIAL: credential,
      REVIEW_ROUTER_REVIEW_V2_OPERATOR_CREDENTIAL_SHA256: createHash("sha256")
        .update(credential, "utf8")
        .digest("hex"),
    });

    expect(result).toEqual({
      ready: false,
      missing: [],
      invalid: ["REVIEW_ROUTER_REVIEW_V2_PROVIDER_VOTE_LANES_JSON"],
    });
    expect(JSON.stringify(result)).not.toContain(credential);
  });
});
