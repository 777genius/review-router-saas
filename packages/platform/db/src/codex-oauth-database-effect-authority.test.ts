import { describe, expect, it } from "vitest";
import { resolveCodexOAuthDatabaseEffectAuthorityUrl } from "./codex-oauth-database-effect-authority.js";

describe("Codex OAuth database effect authority URL", () => {
  it("accepts only the isolated role on the runtime database generation", () => {
    const value = resolveCodexOAuthDatabaseEffectAuthorityUrl({
      env: {
        REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL:
          "postgresql://reviewrouter_codex_effect_authority:secret@db.internal/review_router",
      },
      runtimeDatabaseUrl:
        "postgresql://reviewrouter_api:runtime@DB.INTERNAL.:5432/review_router?schema=public",
    });
    expect(new URL(value!).username).toBe(
      "reviewrouter_codex_effect_authority",
    );
  });

  it.each([
    "postgresql://reviewrouter_api:secret@db.internal/review_router",
    "postgresql://reviewrouter_codex_effect_authority:secret@other.internal/review_router",
    "postgresql://reviewrouter_codex_effect_authority@db.internal/review_router",
  ])("fails closed for %s", (authorityUrl) => {
    expect(() =>
      resolveCodexOAuthDatabaseEffectAuthorityUrl({
        env: {
          REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL: authorityUrl,
        },
        runtimeDatabaseUrl:
          "postgresql://reviewrouter_api:runtime@db.internal/review_router",
      }),
    ).toThrow("codex_oauth_database_effect_authority_url_invalid");
  });

  it("fails closed when the runtime database generation is unavailable", () => {
    expect(() =>
      resolveCodexOAuthDatabaseEffectAuthorityUrl({
        env: {
          REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL:
            "postgresql://reviewrouter_codex_effect_authority:secret@db.internal/review_router",
        },
      }),
    ).toThrow("codex_oauth_database_effect_authority_url_invalid");
  });
});
