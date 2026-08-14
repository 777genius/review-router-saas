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

  it("requires API, web, and worker to answer the current bounded challenge", () => {
    const migration = readFileSync(
      "packages/platform/db/prisma/migrations/000072_runtime_canary_challenge/migration.sql",
      "utf8",
    );
    const entrypoint = readFileSync(
      "deploy/render-runtime/entrypoint.sh",
      "utf8",
    );
    expect(migration).toContain('PRIMARY KEY ("nonce", "runtimeRole")');
    expect(migration).toContain('challenge."expiresAt" >= clock_timestamp()');
    expect(migration).toContain("item->>'servicePostconditionSha256'");
    expect(migration).toContain("current_deployment_provenance");
    expect(entrypoint).toContain("respond-runtime-canary-challenges.mjs");

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
    expect(sql).toContain("reviewrouter_answer_runtime_canary_challenge");
    expect(sql).toContain(
      'REVOKE ALL ON TABLE public."RuntimeCanaryChallengeProof"',
    );
  });
});
