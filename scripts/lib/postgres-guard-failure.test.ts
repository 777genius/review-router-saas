import { describe, expect, it } from "vitest";

import { isExactPostgresGuardFailure } from "./postgres-guard-failure.mjs";

const guard = "legacy_reconciliation_inventory_changed";
const nestedGuard = "legacy_reconciliation_unresolved_intent";
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
const errorLine = (line: number | string, value = guard) =>
  `psql:<stdin>:${line}: ERROR:  ${value}`;

describe("exact PostgreSQL guard failure classification", () => {
  it.each([
    [guard, `${errorLine(21)}\n${directContext}\n`],
    [nestedGuard, `${errorLine(21, nestedGuard)}\n${nestedContext}\n`],
  ])(
    "accepts a complete canonical psql error record",
    (expectedGuard, stderr) => {
      expect(isExactPostgresGuardFailure(failure(stderr), expectedGuard)).toBe(
        true,
      );
    },
  );

  it.each([
    [
      "unrelated line before",
      `NOTICE:  unrelated\n${errorLine(417)}\n${directContext}\n`,
    ],
    ["missing source location", `ERROR:  ${guard}\n${directContext}\n`],
    ["missing stdin source", `psql: ERROR:  ${guard}\n${directContext}\n`],
    [
      "fake path source",
      `psql:/tmp/input.sql:417: ERROR:  ${guard}\n${directContext}\n`,
    ],
    [
      "fake named source",
      `psql:stdin:417: ERROR:  ${guard}\n${directContext}\n`,
    ],
    ["zero source line", `${errorLine(0)}\n${directContext}\n`],
    ["signed source line", `${errorLine("+417")}\n${directContext}\n`],
    ["leading-zero source line", `${errorLine("0417")}\n${directContext}\n`],
    ["oversized source line", `${errorLine(1_000_000)}\n${directContext}\n`],
    [
      "same-line arbitrary prefix",
      `unrelated ${errorLine(417)}\n${directContext}\n`,
    ],
    ["same-line suffix", `${errorLine(417)} unrelated\n${directContext}\n`],
    [
      "wrong guard",
      `${errorLine(417, "legacy_reconciliation_unresolved_intent")}\n${directContext}\n`,
    ],
    [
      "unrelated line after",
      `${errorLine(417)}\n${directContext}\nunrelated\n`,
    ],
    [
      "multiple errors",
      `${errorLine(417)}\n${directContext}\n${errorLine(418)}\n`,
    ],
    [
      "extra NOTICE line",
      `${errorLine(417)}\n${directContext}\nNOTICE:  unrelated\n`,
    ],
    [
      "extra WARNING line",
      `${errorLine(417)}\n${directContext}\nWARNING:  unrelated\n`,
    ],
    ["missing context", `${errorLine(417)}\n`],
    ["malformed context", `${errorLine(417)}\nCONTEXT:  unrelated\n`],
    ["missing final newline", `${errorLine(417)}\n${directContext}`],
    ["CRLF data", `${errorLine(417)}\r\n${directContext}\r\n`],
    ["NUL data", `${errorLine(417)}\n${directContext}\0\n`],
    [
      "indented second ERROR",
      `${errorLine(417)}\n${nestedContext.replace(
        "    requested_inventory,",
        `    ERROR:  ${guard}\n    requested_inventory,`,
      )}\n`,
    ],
    [
      "unrelated NOTICE carrying error text",
      `${errorLine(417)}\n${nestedContext.replace(
        "    requested_inventory,",
        `NOTICE:  unrelated ERROR:  ${guard}\n    requested_inventory,`,
      )}\n`,
    ],
    [
      "Unicode line separator in signature",
      `${errorLine(417)}\n${directContext.replace(
        "migration(text",
        "migration\u2028(text",
      )}\n`,
    ],
    [
      "non-ASCII diagnostic control character",
      `${errorLine(417)}\n${directContext.replace(
        "migration(text",
        "migration\u0085(text",
      )}\n`,
    ],
    [
      "arbitrary procedure signature",
      `${errorLine(417)}\n${directContext.replace(
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
        failure(`${errorLine(417)}\n${directContext}\n`, { status: 0 }),
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
        failure(`${errorLine(417)}\n${directContext}\n`, overrides),
        guard,
      ),
    ).toBe(false);
  });

  it("rejects inherited spawn fields", () => {
    const inherited = Object.create(
      failure(`${errorLine(417)}\n${directContext}\n`),
    );
    expect(isExactPostgresGuardFailure(inherited, guard)).toBe(false);
  });

  it("compares the expected guard as literal data", () => {
    const regexLikeGuard = "legacy_reconciliation_guard[.*]";
    expect(
      isExactPostgresGuardFailure(
        failure(`${errorLine(417, regexLikeGuard)}\n${directContext}\n`),
        regexLikeGuard,
      ),
    ).toBe(true);
    expect(
      isExactPostgresGuardFailure(
        failure(
          `${errorLine(417, "legacy_reconciliation_guardx")}\n${directContext}\n`,
        ),
        regexLikeGuard,
      ),
    ).toBe(false);
  });
});
