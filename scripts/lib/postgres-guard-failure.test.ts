import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  isExactPostgresCatalogDigestMismatchFailure,
  isExactPostgresGuardFailure,
} from "./postgres-guard-failure.mjs";

const guard = "legacy_reconciliation_inventory_changed";
const nestedGuard = "legacy_reconciliation_unresolved_intent";
const executorSignature =
  "reviewrouter_execute_release_migration(text,text,text,text,text,bigint,text,jsonb,timestamp with time zone,boolean,boolean)";
const staleExecutorSignature =
  "reviewrouter_execute_release_migration(text,text,text,text,text,bigint,text,jsonb,timestamp with time zone,boolean)";
const directContext = `CONTEXT:  PL/pgSQL function ${executorSignature} line 81 at RAISE`;
const nestedContext = `CONTEXT:  PL/pgSQL function reviewrouter_reconcile_legacy_ambiguity(text,text,jsonb,text,timestamp with time zone) line 59 at RAISE
SQL statement "CALL public.reviewrouter_reconcile_legacy_ambiguity(
    requested_rollout_id,requested_target_recovery_witness_sha256,
    requested_inventory,
    requested_source_legacy_ambiguity->>'inventorySha256',
    requested_eligibility_cutoff)"
PL/pgSQL function ${executorSignature} line 2543 at CALL`;

const failure = (stderr: unknown, overrides = {}) => ({
  status: 3,
  signal: null,
  stderr,
  ...overrides,
});
const errorLine = (line: number | string, value = guard) =>
  `psql:<stdin>:${line}: ERROR:  ${value}`;

const catalogGuard =
  "release migration target live completion mismatch:catalog_digest_observed";
const catalogDetail = `DETAIL:  expected=sha256:${"1".repeat(64)} observed=sha256:${"2".repeat(64)}`;
const catalogInnerContext =
  "CONTEXT:  PL/pgSQL function reviewrouter_activation.complete_migration_permit(text,bigint,text,jsonb) line 30 at RAISE";
const catalogStatement = `SQL statement "SELECT reviewrouter_activation.complete_migration_permit(
      requested_rollout_id,requested_permit_epoch,requested_permit_nonce,
      '{}'::jsonb)"`;
const catalogOuterContext = `PL/pgSQL function ${executorSignature} line 5513 at PERFORM`;
const catalogRecord = `${errorLine(417, catalogGuard)}\n${catalogDetail}\n${catalogInnerContext}\n${catalogStatement}\n${catalogOuterContext}\n`;

describe("exact PostgreSQL catalog digest mismatch classification", () => {
  it("accepts the complete bounded psql record", () => {
    expect(
      isExactPostgresCatalogDigestMismatchFailure(
        failure(catalogRecord),
        catalogGuard,
      ),
    ).toBe(true);
  });

  it.each([
    ["wrong guard", guard, catalogRecord],
    ["wrong status", catalogGuard, catalogRecord, { status: 1 }],
    ["signal", catalogGuard, catalogRecord, { signal: "SIGTERM" }],
    ["spawn error", catalogGuard, catalogRecord, { error: undefined }],
    [
      "missing detail",
      catalogGuard,
      `${errorLine(417, catalogGuard)}\n${catalogInnerContext}\n${catalogStatement}\n${catalogOuterContext}\n`,
    ],
    [
      "malformed expected hash",
      catalogGuard,
      catalogRecord.replace("1".repeat(64), "g".repeat(64)),
    ],
    [
      "malformed observed hash",
      catalogGuard,
      catalogRecord.replace("2".repeat(64), "2".repeat(63)),
    ],
    [
      "reordered detail",
      catalogGuard,
      `${catalogDetail}\n${errorLine(417, catalogGuard)}\n${catalogInnerContext}\n${catalogStatement}\n${catalogOuterContext}\n`,
    ],
    [
      "duplicate detail",
      catalogGuard,
      `${errorLine(417, catalogGuard)}\n${catalogDetail}\n${catalogDetail}\n${catalogInnerContext}\n${catalogStatement}\n${catalogOuterContext}\n`,
    ],
    ["extra line", catalogGuard, `${catalogRecord}NOTICE:  unrelated\n`],
    [
      "wrong context",
      catalogGuard,
      catalogRecord.replace(" line 30 at RAISE", " line 30 at CALL"),
    ],
    [
      "wrong outer context",
      catalogGuard,
      catalogRecord.replace(" line 5513 at PERFORM", " line 5513 at CALL"),
    ],
    [
      "repeated context prefix",
      catalogGuard,
      catalogRecord.replace(
        catalogOuterContext,
        `CONTEXT:  ${catalogOuterContext}`,
      ),
    ],
    [
      "changed statement whitespace",
      catalogGuard,
      catalogRecord.replace(
        "      requested_rollout_id",
        "     requested_rollout_id",
      ),
    ],
    [
      "missing statement line",
      catalogGuard,
      catalogRecord.replace(
        "      requested_rollout_id,requested_permit_epoch,requested_permit_nonce,\n",
        "",
      ),
    ],
    ["non-ASCII", catalogGuard, catalogRecord.replace("DETAIL", "DÉTAIL")],
  ])("rejects %s", (_name, expectedGuard, stderr, overrides = {}) => {
    expect(
      isExactPostgresCatalogDigestMismatchFailure(
        failure(stderr, overrides),
        expectedGuard,
      ),
    ).toBe(false);
  });
});

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

  it("accepts contexts derived from the canonical executor declaration", () => {
    const source = readFileSync(
      new URL("../run-codex-rotating-release-migration.mjs", import.meta.url),
      "utf8",
    );
    const declarations = [
      ...source.matchAll(
        /^CREATE OR REPLACE PROCEDURE public\.reviewrouter_execute_release_migration\(\n(?<parameters>[\s\S]*?)\n\)\nLANGUAGE plpgsql$/gmu,
      ),
    ];
    expect(declarations).toHaveLength(1);

    const parameterLines = declarations[0].groups!.parameters.split("\n");
    const parameterTypes = parameterLines.map((line, index) => {
      const parameter =
        /^ {2}requested_[a-z0-9_]+ ([a-z]+(?: [a-z]+)*)(,?)$/u.exec(line);
      expect(parameter).not.toBeNull();
      expect(parameter![2]).toBe(
        index === parameterLines.length - 1 ? "" : ",",
      );
      return parameter![1] === "timestamptz"
        ? "timestamp with time zone"
        : parameter![1];
    });
    const sourceSignature = `reviewrouter_execute_release_migration(${parameterTypes.join(",")})`;
    const sourceDirectContext = directContext.replace(
      executorSignature,
      sourceSignature,
    );
    const sourceNestedContext = nestedContext.replace(
      executorSignature,
      sourceSignature,
    );

    expect(
      isExactPostgresGuardFailure(
        failure(`${errorLine(21)}\n${sourceDirectContext}\n`),
        guard,
      ),
    ).toBe(true);
    expect(
      isExactPostgresGuardFailure(
        failure(`${errorLine(21, nestedGuard)}\n${sourceNestedContext}\n`),
        nestedGuard,
      ),
    ).toBe(true);
  });

  it("rejects the stale direct executor signature", () => {
    const context = directContext.replace(
      executorSignature,
      staleExecutorSignature,
    );
    expect(
      isExactPostgresGuardFailure(
        failure(`${errorLine(21)}\n${context}\n`),
        guard,
      ),
    ).toBe(false);
  });

  it("rejects the stale nested executor signature", () => {
    const context = nestedContext.replace(
      executorSignature,
      staleExecutorSignature,
    );
    expect(
      isExactPostgresGuardFailure(
        failure(`${errorLine(21, nestedGuard)}\n${context}\n`),
        nestedGuard,
      ),
    ).toBe(false);
  });

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

  it.each([
    [
      "separated closing parenthesis",
      nestedContext.replace(
        '    requested_eligibility_cutoff)"',
        '    requested_eligibility_cutoff\n  )"',
      ),
    ],
    [
      "changed argument indentation",
      nestedContext.replace(
        "    requested_inventory,",
        "   requested_inventory,",
      ),
    ],
    [
      "extra argument whitespace",
      nestedContext.replace(
        "    requested_inventory,",
        "    requested_inventory, ",
      ),
    ],
    [
      "extra statement line",
      nestedContext.replace(
        "    requested_inventory,",
        "    requested_inventory,\n    requested_extra,",
      ),
    ],
    [
      "missing closing parenthesis",
      nestedContext.replace(
        '    requested_eligibility_cutoff)"',
        '    requested_eligibility_cutoff"',
      ),
    ],
  ])("rejects nested context with %s", (_name, context) => {
    expect(
      isExactPostgresGuardFailure(
        failure(`${errorLine(21, nestedGuard)}\n${context}\n`),
        nestedGuard,
      ),
    ).toBe(false);
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
