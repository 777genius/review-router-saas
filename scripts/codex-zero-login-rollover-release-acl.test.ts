import { describe, expect, it } from "vitest";
import { runtimeGrantStatements } from "./run-codex-rotating-release-migration.mjs";

describe("zero-login rollover canonical release ACL", () => {
  const sql = runtimeGrantStatements({
    roles: [
      { role: "api", username: "reviewrouter_api" },
      { role: "web", username: "reviewrouter_web" },
      { role: "worker", username: "reviewrouter_worker" },
      { role: "effect-authority", username: "reviewrouter_codex_effect_authority" },
      { role: "comment-token-custody", username: "reviewrouter_comment_token_custody" },
    ],
  });

  it("restores only the service-specific rollover table capabilities", () => {
    expect(sql).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE public."CodexOAuthNamespaceRolloverIntent" TO reviewrouter_api;',
    );
    expect(sql).toContain(
      'GRANT SELECT, UPDATE ON TABLE public."CodexOAuthNamespaceRolloverIntent" TO reviewrouter_web;',
    );
    expect(sql).toContain(
      'REVOKE ALL ON TABLE public."CodexOAuthNamespaceRolloverIntent" FROM reviewrouter_worker;',
    );
    expect(sql).not.toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE public."CodexOAuthNamespaceRolloverIntent" TO reviewrouter_worker;',
    );
  });

  it("grants web only the dedicated rollover completion authorizer", () => {
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public."codex_oauth_authorize_rollover_completion"(text, text, text) TO reviewrouter_web;',
    );
    expect(sql).not.toContain(
      'GRANT EXECUTE ON FUNCTION public."codex_oauth_authorize_runtime_completion"(text, text) TO reviewrouter_web;',
    );
  });
});
