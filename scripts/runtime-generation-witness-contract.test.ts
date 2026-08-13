import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runtimeGrantStatements } from "./run-codex-rotating-release-migration.mjs";

describe("runtime generation witness database contract", () => {
  it("keeps fresh migrations role-optional and canonical bootstrap grants exact functions", () => {
    const migration = readFileSync(
      "packages/platform/db/prisma/migrations/000070_runtime_generation_witness_proof/migration.sql",
      "utf8",
    );
    expect(migration).toContain("to_regrole(runtime_role) IS NOT NULL");
    expect(migration).toContain("session_user <> expected_database_role");
    expect(migration).toContain("binding->>'recoveryWitnessSha256'");
    expect(migration).not.toContain("current_user <> expected_database_role");

    const sql = runtimeGrantStatements({
      roles: [
        { username: "reviewrouter_web", role: "runtime" },
        { username: "reviewrouter_api", role: "runtime" },
        { username: "reviewrouter_worker", role: "runtime" },
        {
          username: "reviewrouter_codex_effect_authority",
          role: "effect-authority",
        },
      ],
    });
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION public.reviewrouter_record_runtime_generation_witness_proof",
    );
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION public.reviewrouter_read_runtime_generation_witness_proofs",
    );
  });
});
