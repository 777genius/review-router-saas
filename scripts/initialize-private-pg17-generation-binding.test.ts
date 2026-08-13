import { describe, expect, it } from "vitest";
import {
  canonicalGenerationBindingSql,
  executePrivatePg17GenerationBinding,
} from "./initialize-private-pg17-generation-binding.mjs";

const env = {
  REVIEW_ROUTER_ROLE_BOOTSTRAP_DATABASE_URL:
    "postgresql://reviewrouter_role_bootstrap:secret@target.internal/review_router",
  REVIEW_ROUTER_SOURCE_DATABASE_SYSTEM_IDENTIFIER: "100",
  REVIEW_ROUTER_TARGET_DATABASE_SYSTEM_IDENTIFIER: "200",
  REVIEW_ROUTER_SOURCE_RECOVERY_WITNESS_SHA256: "a".repeat(64),
  REVIEW_ROUTER_TARGET_RECOVERY_WITNESS_SHA256: "b".repeat(64),
};

const observed = {
  systemIdentifier: "200",
  recoveryWitnessSha256: "b".repeat(64),
  version: 1,
  caller: "reviewrouter_role_bootstrap",
  postgresMajor: 17,
};

describe("private PostgreSQL 17 generation binding", () => {
  it("binds only the expected restored source to the exact target generation", () => {
    let sql = "";
    const commands = {
      execute: (
        _command: string,
        _args: string[],
        options: { input: string },
      ) => {
        sql = options.input;
        return { stdout: `${JSON.stringify(observed)}\n` };
      },
    };
    const result = executePrivatePg17GenerationBinding(env, commands as never);
    expect(result.facts.systemIdentifier).toBe("200");
    expect(sql).toContain("current_binding = next_binding");
    expect(sql).toContain(
      "count(*) FROM jsonb_object_keys(current_binding)) = 1",
    );
    expect(sql).toContain(
      "existing database generation binding is not the expected restored source",
    );
    expect(sql).toContain("current_user <> 'reviewrouter_role_bootstrap'");
    expect(sql).toContain("COMMENT ON DATABASE");
    expect(sql).not.toContain("secret");
  });

  it.each([
    [
      "same system identifier",
      { REVIEW_ROUTER_TARGET_DATABASE_SYSTEM_IDENTIFIER: "100" },
    ],
    [
      "same witness",
      { REVIEW_ROUTER_TARGET_RECOVERY_WITNESS_SHA256: "a".repeat(64) },
    ],
    [
      "malformed system identifier",
      { REVIEW_ROUTER_TARGET_DATABASE_SYSTEM_IDENTIFIER: "2;DROP" },
    ],
    [
      "malformed witness",
      { REVIEW_ROUTER_TARGET_RECOVERY_WITNESS_SHA256: "not-a-sha" },
    ],
  ])("rejects %s before connecting", (_name, override) => {
    expect(() =>
      executePrivatePg17GenerationBinding({ ...env, ...override }, {
        execute: () => {
          throw new Error("must not connect");
        },
      } as never),
    ).toThrow("private_pg17_generation_binding_identity_invalid");
  });

  it("fails closed when the exact post-write observation is not proven", () => {
    expect(() =>
      executePrivatePg17GenerationBinding(env, {
        execute: () => ({
          stdout: `${JSON.stringify({ ...observed, version: 2 })}\n`,
        }),
      } as never),
    ).toThrow("private_pg17_generation_binding_unproven");
  });

  it("keeps validation, replacement, and observation in one psql session", () => {
    const sql = canonicalGenerationBindingSql({
      sourceSystemIdentifier: "100",
      targetSystemIdentifier: "200",
      sourceRecoveryWitnessSha256: "a".repeat(64),
      targetRecoveryWitnessSha256: "b".repeat(64),
    });
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("server_version_num");
    expect(sql).toContain("datdba = current_user::regrole");
    expect(sql).toContain("system_identifier::text");
    expect(sql).toContain("shobj_description");
  });
});
