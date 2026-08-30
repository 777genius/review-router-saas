import { describe, expect, it } from "vitest";

import { isExactPostgresGuardFailure } from "./postgres-guard-failure.mjs";

const guard = "legacy_reconciliation_inventory_changed";
const directContext =
  "CONTEXT:  PL/pgSQL function reviewrouter_execute_release_migration(text,text,text,text,text,bigint,text,jsonb,timestamp with time zone,boolean) line 81 at RAISE";
const nestedContext = `CONTEXT:  PL/pgSQL function reviewrouter_reconcile_legacy_ambiguity(text,text,jsonb,text,timestamp with time zone) line 47 at RAISE
SQL statement "CALL public.reviewrouter_reconcile_legacy_ambiguity(
    requested_rollout_id,requested_target_recovery_witness_sha256,
    requested_inventory,
    requested_source_legacy_ambiguity->>'inventorySha256',
    requested_eligibility_cutoff
  )"
PL/pgSQL function reviewrouter_execute_release_migration(text,text,text,text,text,bigint,text,jsonb,timestamp with time zone,boolean) line 87 at CALL`;

const failure = (stderr: unknown, overrides = {}) => ({
  status: 3,
  signal: null,
  stderr,
  ...overrides,
});

describe("exact PostgreSQL guard failure classification", () => {
  it.each([
    [`ERROR:  ${guard}\n${directContext}\n`],
    [`ERROR:  ${guard}\n${nestedContext}\n`],
  ])("accepts a complete canonical psql error record", (stderr) => {
    expect(isExactPostgresGuardFailure(failure(stderr), guard)).toBe(true);
  });

  it.each([
    [
      "unrelated line before",
      `NOTICE:  unrelated\nERROR:  ${guard}\n${directContext}\n`,
    ],
    ["same-line prefix", `psql: ERROR:  ${guard}\n${directContext}\n`],
    [
      "same-line arbitrary prefix",
      `unrelated ERROR:  ${guard}\n${directContext}\n`,
    ],
    ["same-line suffix", `ERROR:  ${guard} unrelated\n${directContext}\n`],
    [
      "wrong guard",
      `ERROR:  legacy_reconciliation_unresolved_intent\n${directContext}\n`,
    ],
    ["unrelated line after", `ERROR:  ${guard}\n${directContext}\nunrelated\n`],
    [
      "multiple errors",
      `ERROR:  ${guard}\n${directContext}\nERROR:  ${guard}\n`,
    ],
    [
      "extra NOTICE line",
      `ERROR:  ${guard}\n${directContext}\nNOTICE:  unrelated\n`,
    ],
    [
      "extra WARNING line",
      `ERROR:  ${guard}\n${directContext}\nWARNING:  unrelated\n`,
    ],
    ["missing context", `ERROR:  ${guard}\n`],
    ["malformed context", `ERROR:  ${guard}\nCONTEXT:  unrelated\n`],
    ["missing final newline", `ERROR:  ${guard}\n${directContext}`],
    ["CRLF data", `ERROR:  ${guard}\r\n${directContext}\r\n`],
    ["NUL data", `ERROR:  ${guard}\n${directContext}\0\n`],
    [
      "indented second ERROR",
      `ERROR:  ${guard}\n${nestedContext.replace(
        "    requested_inventory,",
        `    ERROR:  ${guard}\n    requested_inventory,`,
      )}\n`,
    ],
    [
      "unrelated NOTICE carrying error text",
      `ERROR:  ${guard}\n${nestedContext.replace(
        "    requested_inventory,",
        `NOTICE:  unrelated ERROR:  ${guard}\n    requested_inventory,`,
      )}\n`,
    ],
    [
      "Unicode line separator in signature",
      `ERROR:  ${guard}\n${directContext.replace("migration(text", "migration\u2028(text")}\n`,
    ],
    [
      "non-ASCII diagnostic control character",
      `ERROR:  ${guard}\n${directContext.replace("migration(text", "migration\u0085(text")}\n`,
    ],
    [
      "arbitrary procedure signature",
      `ERROR:  ${guard}\n${directContext.replace(
        "reviewrouter_execute_release_migration",
        "attacker_controlled_procedure",
      )}\n`,
    ],
  ])("rejects %s", (_name, stderr) => {
    expect(isExactPostgresGuardFailure(failure(stderr), guard)).toBe(false);
  });

  it("rejects a successful process carrying forged guard stderr", () => {
    expect(
      isExactPostgresGuardFailure(
        failure(`ERROR:  ${guard}\n${directContext}\n`, { status: 0 }),
        guard,
      ),
    ).toBe(false);
  });

  it.each([[null], [undefined], [42], [{}], [""]])(
    "rejects malformed stderr %#",
    (stderr) => {
      expect(isExactPostgresGuardFailure(failure(stderr), guard)).toBe(false);
    },
  );

  it.each([
    [{ status: null }],
    [{ status: 1 }],
    [{ error: undefined }],
    [{ error: new Error("spawn failed") }],
    [{ signal: "SIGTERM" }],
  ])("rejects a non-psql failure classification %#", (overrides) => {
    expect(
      isExactPostgresGuardFailure(
        failure(`ERROR:  ${guard}\n${directContext}\n`, overrides),
        guard,
      ),
    ).toBe(false);
  });

  it("rejects inherited spawn fields", () => {
    const inherited = Object.create(
      failure(`ERROR:  ${guard}\n${directContext}\n`),
    );
    expect(isExactPostgresGuardFailure(inherited, guard)).toBe(false);
  });

  it("compares the expected guard as literal data", () => {
    const regexLikeGuard = "legacy_reconciliation_guard[.*]";
    expect(
      isExactPostgresGuardFailure(
        failure(`ERROR:  ${regexLikeGuard}\n${directContext}\n`),
        regexLikeGuard,
      ),
    ).toBe(true);
    expect(
      isExactPostgresGuardFailure(
        failure(`ERROR:  legacy_reconciliation_guardx\n${directContext}\n`),
        regexLikeGuard,
      ),
    ).toBe(false);
  });
});
