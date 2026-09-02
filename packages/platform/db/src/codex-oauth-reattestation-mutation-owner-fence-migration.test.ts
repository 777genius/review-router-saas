import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migrationsRoot = join(import.meta.dirname, "../prisma/migrations");
const migration79 = readFileSync(
  join(
    migrationsRoot,
    "000087_codex_oauth_v4_v5_workflow_reattestation/migration.sql",
  ),
);
const migration80 = readFileSync(
  join(
    migrationsRoot,
    "000088_codex_oauth_reattestation_mutation_owner_fence/migration.sql",
  ),
  "utf8",
);

describe("Codex OAuth reattestation mutation-owner fence migration", () => {
  it("preserves immutable 000079 and pins the additive follow-up", () => {
    expect(createHash("sha256").update(migration79).digest("hex")).toBe(
      "af5fccfd987312b85d48cd38b7f528780f52e82daab47c34829581e50193b090",
    );
    expect(createHash("sha256").update(migration80).digest("hex")).toBe(
      "18a1e48953d1360d3661ea6753b7aa350fc7e28caeaeb65d42c9ac42569f1cf0",
    );
  });

  it("replaces only the security-definer routine and keeps its trust boundary", () => {
    expect(migration80).toContain(
      'CREATE OR REPLACE FUNCTION "codex_oauth_reattest_active_namespace_v4_to_v5"',
    );
    expect(migration80).toContain("SECURITY DEFINER");
    expect(migration80).toContain("SET search_path = pg_catalog, public");
    expect(migration80).toContain("DECLARE caller_role TEXT := session_user");
    expect(migration80).toContain("caller_role <> 'reviewrouter_web'");
    expect(migration80).toContain(
      "canonical_function_owner <> canonical_table_owner",
    );
    expect(migration80).not.toMatch(/\bCREATE\s+(?:TABLE|TYPE|TRIGGER)\b/u);
    expect(migration80).not.toContain("GRANT EXECUTE");
  });

  it("checks every established mutation owner under the provider row lock", () => {
    const providerLock = migration80.slice(
      migration80.indexOf('FROM public."CodexOAuthProviderInstance" provider'),
      migration80.indexOf(
        "IF NOT FOUND THEN",
        migration80.indexOf(
          'FROM public."CodexOAuthProviderInstance" provider',
        ),
      ),
    );
    expect(providerLock).toContain('provider."mutationOwner" IS NULL');
    expect(providerLock).toContain('provider."mutationOwnerId" IS NULL');
    expect(providerLock).toContain('provider."activeLeaseId" IS NULL');
    expect(providerLock).toContain("FOR UPDATE OF provider");
    expect(
      providerLock.indexOf('provider."mutationOwner" IS NULL'),
    ).toBeLessThan(providerLock.indexOf("FOR UPDATE OF provider"));
  });
});
