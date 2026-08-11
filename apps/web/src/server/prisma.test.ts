import { afterEach, describe, expect, it, vi } from "vitest";
import { getCodexEffectAuthorityPrisma } from "./prisma";

describe("Codex effect-authority Prisma composition", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("fails closed instead of returning the web runtime client", () => {
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://reviewrouter_web:web@db/reviewrouter",
    );
    vi.stubEnv("REVIEW_ROUTER_CODEX_EFFECT_AUTHORITY_DATABASE_URL", "");

    expect(() => getCodexEffectAuthorityPrisma()).toThrow(
      "codex_oauth_database_effect_authority_unavailable",
    );
  });
});
