import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertRenderManagedRoleBranch,
  classifyRenderManagedMembership,
  inspectRenderManagedLedger,
  partitionRenderSchemaHandoffCheckout,
  readRenderSchemaHandoffCatalog,
  readReviewedRenderManagedContract,
  renderManagedEvidenceDigest,
  renderManagedLedgerSql,
  renderManagedMembershipCleanupSql,
  renderManagedMigrationPhase,
  renderManagedMigrationPhases,
  renderManagedTemporaryMembershipSql,
  renderSchemaHandoffCheckoutExtension,
} from "./render-schema-handoff-policy.mjs";
import {
  assertRenderManagedCatalogMatches,
  renderManagedCatalogSql,
} from "./render-managed-catalog.mjs";

const catalog = readRenderSchemaHandoffCatalog();
const retained = "managed-retained-upgrade";
const handoff = "managed-schema-handoff";
const rows = (count = 76) =>
  catalog.slice(0, count).map((migration, index) => ({
    ...migration,
    id: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
    startedAt: "2026-08-01T00:00:00.000001Z",
    finishedAt: "2026-08-01T00:00:00.000002Z",
    rolledBackAt: null,
    appliedStepsCount: 1,
    logsPresent: false,
    hasLogs: false,
    logsDigest: null,
  }));
const original = {
  role: "reviewrouter_release_schema_owner",
  member: "reviewrouter",
  grantor: "postgres",
  adminOption: true,
  inheritOption: false,
  setOption: false,
};
const temporary = {
  ...original,
  grantor: "reviewrouter",
  adminOption: false,
  inheritOption: true,
  setOption: true,
};
const roles = () => [
  {
    name: "reviewrouter_release_schema_owner",
    canLogin: false,
    superuser: false,
    bypassRls: false,
    replication: false,
    createDatabase: false,
    createRole: false,
  },
  {
    name: "reviewrouter_release_migration",
    canLogin: true,
    superuser: false,
    bypassRls: false,
    replication: false,
    createDatabase: false,
    createRole: false,
  },
];

describe("two managed histories and full Prisma ledger observations", () => {
  it("refuses ledger93/94/95 in both phases even with the admitted95 checkout", () => {
    const checkout = [...catalog, ...renderSchemaHandoffCheckoutExtension];
    const managed = partitionRenderSchemaHandoffCheckout(checkout);
    expect(managed).toEqual(catalog);
    const complete = checkout.map((row, index) => ({
      ...rows(1)[0]!,
      ...row,
      id: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
    }));
    for (const count of [93, 94, 95])
      for (const phase of [retained, handoff])
        expect(() =>
          inspectRenderManagedLedger(managed, complete.slice(0, count), phase),
        ).toThrow("managed_ledger_count");
    for (const [phase, count] of [
      [retained, 76],
      [retained, 89],
      [handoff, 89],
      [handoff, 92],
    ] as const) {
      expect(
        inspectRenderManagedLedger(managed, complete.slice(0, count), phase),
      ).toEqual(inspectRenderManagedLedger(catalog, rows(count), phase));
      // A successful-history digest or identity projection cannot replace the
      // complete ledger metadata, even when its migration manifest matches.
      expect(() =>
        inspectRenderManagedLedger(managed, managed.slice(0, count), phase),
      ).toThrow("managed_ledger_history");
      expect(() =>
        inspectRenderManagedLedger(
          managed,
          renderManagedEvidenceDigest(complete.slice(0, count)),
          phase,
        ),
      ).toThrow("managed_ledger_count");
    }
    for (const phase of [retained, handoff])
      expect(() => readReviewedRenderManagedContract(phase)).toThrow(
        "managed_independent_review_missing",
      );
  });

  it("keeps SQL96 pending outside both managed ledger boundaries", () => {
    const migration96 = {
      migrationName: "000096_hosted_pool_public_repository_eligibility",
      checksum: createHash("sha256")
        .update(
          readFileSync(
            new URL(
              "../../packages/platform/db/prisma/migrations/000096_hosted_pool_public_repository_eligibility/migration.sql",
              import.meta.url,
            ),
          ),
        )
        .digest("hex"),
    };
    const checkout = [
      ...catalog,
      ...renderSchemaHandoffCheckoutExtension,
      migration96,
    ];
    const managed = partitionRenderSchemaHandoffCheckout(checkout);
    expect(managed).toEqual(catalog);
    for (const phase of [retained, handoff]) {
      const baseline = renderManagedMigrationPhase(phase).baselineCount;
      expect(
        inspectRenderManagedLedger(managed, rows(baseline), phase),
      ).toEqual(inspectRenderManagedLedger(catalog, rows(baseline), phase));
      const complete = checkout.map((row, index) => ({
        ...rows(1)[0]!,
        ...row,
        id: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
      }));
      for (const count of [93, 94, 95, 96])
        expect(() =>
          inspectRenderManagedLedger(managed, complete.slice(0, count), phase),
        ).toThrow("managed_ledger_count");
    }
    expect(
      inspectRenderManagedLedger(managed, rows(92), handoff).pending,
    ).toEqual([]);
  });

  it("binds 76 to the exact source prefix, independently of row count", () => {
    const state = inspectRenderManagedLedger(catalog, rows(), retained);
    expect(state.manifest).toBe(
      "sha256:fb3e60a451ece179a3f0c44748f8500ac51ea5dcf186b0732463db4098de94b8",
    );
    expect(state.manifest).not.toBe(
      "sha256:c0ab0520ee922e695b2954f0a0af81ffd0ad6fb57f41ec3ddc124fe7c8a781eb",
    );
    expect(
      state.pending.map((r: { migrationName: string }) => r.migrationName),
    ).toEqual([
      "000075_hosted_codex_security_certification",
      "000076_hosted_codex_terminalization_restore_invariants",
      "000077_hosted_codex_r57_security_race_remediation",
      "000078_review_investigation_maintenance_checkpoint",
      "000079_hosted_codex_output_limits",
      "000079_remove_account_wide_provider_lane_serialization",
      "000080_hosted_codex_attempt_generation",
      "000081_hosted_codex_runtime_gate",
      "000082_validate_hosted_codex_output_limits",
      "000083_hosted_codex_comment_token_mint_protocol",
      "000084_harden_comment_token_custody",
      "000085_comment_token_gate_lock_result",
      "000086_comment_token_custody_r18_remediation",
    ]);
    const sameCountDifferentHistory = [
      ...rows().slice(13),
      ...rows(89).slice(76),
    ];
    expect(sameCountDifferentHistory).toHaveLength(76);
    expect(() =>
      inspectRenderManagedLedger(catalog, sameCountDifferentHistory, retained),
    ).toThrow("managed_ledger_history");
  });

  it.each(Array.from({ length: 14 }, (_, index) => index + 76))(
    "identifies the exact remaining work after %i successful commits, without authorizing resume",
    (count) => {
      const result = inspectRenderManagedLedger(catalog, rows(count), retained);
      expect(result.count).toBe(count);
      expect(result.pending).toEqual(catalog.slice(count, 89));
      expect(result.position).toBe(
        count === 76 ? "baseline" : count === 89 ? "target" : "partial",
      );
    },
  );

  it("shares an exact 89 boundary but does not merge the phase contracts", () => {
    const a = inspectRenderManagedLedger(catalog, rows(89), retained);
    const b = inspectRenderManagedLedger(catalog, rows(89), handoff);
    expect(a.ledgerDigest).toBe(b.ledgerDigest);
    expect(a.position).toBe("target");
    expect(b.position).toBe("baseline");
    expect(b.pending).toEqual(catalog.slice(89));
    expect(renderManagedMigrationPhase(retained).atomic).toBe(false);
    expect(renderManagedMigrationPhase(handoff).atomic).toBe(true);
    expect(
      inspectRenderManagedLedger(catalog, rows(92), handoff).manifest,
    ).toBe(renderManagedMigrationPhases[handoff].targetManifest);
  });

  it.each([0, 75, 90, 91, 92])(
    "rejects %i rows for retained upgrade",
    (count) => {
      expect(() =>
        inspectRenderManagedLedger(catalog, rows(count), retained),
      ).toThrow("managed_ledger_count");
    },
  );
  it.each([76, 88, 90, 91])("rejects %i rows for atomic handoff", (count) => {
    expect(() =>
      inspectRenderManagedLedger(catalog, rows(count), handoff),
    ).toThrow("managed_ledger_count");
  });
  it.each(["baseline", "target", "recover", "", "__proto__", "toString"])(
    "rejects an ambiguous phase %s",
    (phase) => {
      expect(() => inspectRenderManagedLedger(catalog, rows(), phase)).toThrow(
        "managed_phase",
      );
    },
  );

  it.each([
    { finishedAt: null },
    { rolledBackAt: "2026-08-01T00:00:01.000000Z" },
    { appliedStepsCount: 0 },
    { appliedStepsCount: 2 },
    { hasLogs: true },
    { logsPresent: true, logsDigest: `sha256:${"a".repeat(64)}` },
    { hasLogs: undefined },
    { logsPresent: undefined },
    { logsDigest: undefined },
    { startedAt: null },
    { startedAt: "2026-08-02T00:00:00.000000Z" },
    { finishedAt: "2026-02-30T00:00:00.000000Z" },
    { startedAt: "2026-08-01T00:00:00Z" },
    { checksum: "0".repeat(64) },
    { migrationName: "000001_unknown" },
    { id: "unknown" },
    { unexpected: true },
  ])(
    "keeps failed/rolled-back/logged/unknown row metadata on HOLD: %j",
    (mutation) => {
      for (const [phase, count] of [
        [retained, 76],
        [retained, 83],
        [handoff, 92],
      ] as const) {
        const ledger = rows(count);
        Object.assign(ledger[10]!, mutation);
        expect(() =>
          inspectRenderManagedLedger(catalog, ledger, phase),
        ).toThrow("managed_ledger_history");
      }
    },
  );

  it("does not drop failed duplicates even at an otherwise admissible row count", () => {
    const ledger = rows(80);
    ledger.push({ ...ledger[0]!, appliedStepsCount: 0 });
    expect(() => inspectRenderManagedLedger(catalog, ledger, retained)).toThrow(
      "managed_ledger_history",
    );
    ledger.pop();
    ledger[1]!.id = ledger[0]!.id;
    expect(() => inspectRenderManagedLedger(catalog, ledger, retained)).toThrow(
      "managed_ledger_history",
    );
  });

  it("binds metadata changes even when both ledgers are successful", () => {
    const ledger = rows();
    const baseline = inspectRenderManagedLedger(catalog, ledger, retained);
    ledger[0]!.finishedAt = "2026-08-01T00:00:00.000003Z";
    const changed = inspectRenderManagedLedger(catalog, ledger, retained);
    expect(changed.manifest).toBe(baseline.manifest);
    expect(changed.ledgerDigest).not.toBe(baseline.ledgerDigest);
    expect(
      inspectRenderManagedLedger(catalog, ledger.reverse(), retained),
    ).toEqual(changed);
  });

  it("projects every ledger row, authenticates hasLogs, and hashes log bytes without exposing them", () => {
    expect(renderManagedLedgerSql).not.toMatch(
      /\bWHERE\b|\bDISTINCT\b|\bFILTER\b/iu,
    );
    expect(renderManagedLedgerSql).toContain(
      "'hasLogs',logs IS NOT NULL AND logs <> ''",
    );
    expect(renderManagedLedgerSql).toContain("sha256(convert_to(logs,'UTF8'))");
    expect(renderManagedLedgerSql).toContain("'rolledBackAt'");
    expect(renderManagedLedgerSql).not.toContain("'logs',logs");
  });
});

describe("explicit-grantor reconciliation policy", () => {
  it("classifies original-only as cleaned and exact original-plus-self as cleanup pending", () => {
    expect(classifyRenderManagedMembership([original], original)).toBe(
      "original",
    );
    for (const rows of [
      [original, temporary],
      [temporary, original],
    ])
      expect(classifyRenderManagedMembership(rows, original)).toBe("temporary");
    expect(renderManagedTemporaryMembershipSql).toContain(
      "ADMIN FALSE, INHERIT TRUE, SET TRUE GRANTED BY reviewrouter",
    );
    expect(renderManagedMembershipCleanupSql).toBe(
      "REVOKE reviewrouter_release_schema_owner FROM reviewrouter\nGRANTED BY reviewrouter RESTRICT;",
    );
  });

  it.each([
    [],
    [temporary],
    [original, original],
    [original, temporary, temporary],
    [original, { ...temporary, grantor: "unexplained" }],
    [{ ...original, grantor: "unexplained" }, temporary],
    [{ ...original, adminOption: false }, temporary],
    [original, { ...temporary, inheritOption: false }],
    [original, { ...temporary, setOption: false }],
    [original, { ...temporary, adminOption: true }],
    [original, { ...temporary, role: "another_owner" }],
    [original, { ...temporary, member: "another_member" }],
    [original, { ...temporary, extra: true }],
    null,
    {},
  ])(
    "rejects missing, partial, duplicate or altered custody topology %#",
    (rows) => {
      expect(() => classifyRenderManagedMembership(rows, original)).toThrow(
        /managed_membership_/u,
      );
    },
  );

  it.each([
    "role",
    "member",
    "grantor",
    "adminOption",
    "inheritOption",
    "setOption",
  ])("requires an exact reviewed original %s", (field) => {
    const invalid = { ...original, [field]: null };
    expect(() => classifyRenderManagedMembership([invalid], invalid)).toThrow(
      "managed_original_membership",
    );
  });
});

describe("managed authority and independent approval boundary", () => {
  it("rejects both absent roles before the self-hosted branch can remove operator routines", () => {
    expect(() => assertRenderManagedRoleBranch([])).toThrow(
      "managed_roles_self_hosted_branch",
    );
  });
  it.each([0, 1])(
    "rejects partial authority topology with role %i missing",
    (index) => {
      expect(() =>
        assertRenderManagedRoleBranch(roles().filter((_, i) => i !== index)),
      ).toThrow("managed_roles_partial");
    },
  );
  it.each([
    "superuser",
    "bypassRls",
    "replication",
    "createDatabase",
    "createRole",
  ])(
    "rejects an elevated %s attribute on either authority role",
    (attribute) => {
      for (const index of [0, 1]) {
        const observed = roles();
        Object.assign(observed[index]!, { [attribute]: true });
        expect(() => assertRenderManagedRoleBranch(observed)).toThrow(
          /managed_(schema_owner|release)_role/u,
        );
      }
    },
  );

  const fixture = () => ({
    version: 1,
    serverVersionNum: 170010,
    database: "disposable_only",
    sessionUser: "reviewrouter",
    currentUser: "reviewrouter",
    facts: [
      { family: "authority", fact: { roles: roles() } },
      { family: "membership", fact: { ...original } },
      { family: "acl", fact: { owner: "reviewrouter", entries: null } },
      { family: "defaultAcl", fact: { owner: "unrelated", entries: [] } },
      {
        family: "routine",
        fact: {
          definitionDigest: "fixture-only",
          configurationDigest: "fixture-only",
        },
      },
      {
        family: "dependency",
        fact: { object: "fixture", reference: "fixture" },
      },
      { family: "roleSetting", fact: { digest: "fixture-only" } },
      { family: "index", fact: { valid: true, definition: "fixture-only" } },
      {
        family: "trigger",
        fact: { enabled: "O", internal: true, generatedName: true },
      },
    ],
  });

  it.each([
    "authority",
    "membership",
    "acl",
    "defaultAcl",
    "routine",
    "dependency",
    "roleSetting",
    "index",
    "trigger",
  ])("detects %s drift against a preselected comparison contract", (family) => {
    const observed = fixture();
    const comparisonDigest = renderManagedEvidenceDigest(observed);
    expect(() =>
      assertRenderManagedCatalogMatches(observed, comparisonDigest),
    ).not.toThrow();
    Object.assign(observed.facts.find((row) => row.family === family)!.fact, {
      drift: true,
    });
    expect(() =>
      assertRenderManagedCatalogMatches(observed, comparisonDigest),
    ).toThrow("drift");
  });

  it("cannot turn a matching fixture hash into production authorization for either phase", () => {
    for (const phase of [retained, handoff]) {
      const observed = fixture();
      expect(() =>
        assertRenderManagedCatalogMatches(
          observed,
          renderManagedEvidenceDigest(observed),
        ),
      ).not.toThrow();
      expect(() => readReviewedRenderManagedContract(phase)).toThrow(
        "managed_independent_review_missing",
      );
    }
  });

  it("supplements effective grants with definitions, settings, default overrides and grantor identities", () => {
    for (const source of [
      "pg_default_acl",
      "pg_get_functiondef",
      "pg_db_role_setting",
      "pg_depend",
      "pg_auth_members",
      "pg_attribute",
      "pg_get_indexdef",
    ])
      expect(renderManagedCatalogSql).toContain(source);
    expect(renderManagedCatalogSql).not.toMatch(
      /\b(?:GRANT|REVOKE|ALTER|INSERT|UPDATE|DELETE)\s+(?:ON|INTO|TABLE|ROLE|SCHEMA)/u,
    );
  });

  it("projects all application enum labels in semantic order, including unused types", () => {
    expect(renderManagedCatalogSql).toContain("'enum'");
    expect(renderManagedCatalogSql).toContain("pg_catalog.pg_enum");
    expect(renderManagedCatalogSql).toContain("ORDER BY e.enumsortorder");
    expect(renderManagedCatalogSql).toContain("WHERE t.typtype='e'");
  });

  it("binds generated physical names to their own OIDs without dropping triggers or dependency edges", () => {
    expect(renderManagedCatalogSql).toContain(
      "t.tgisinternal AND c.contype='f'",
    );
    expect(renderManagedCatalogSql).toContain(
      "'RI_ConstraintTrigger_a_'||t.oid",
    );
    expect(renderManagedCatalogSql).toContain(
      "'RI_ConstraintTrigger_c_'||t.oid",
    );
    expect(renderManagedCatalogSql).toContain(
      "ELSE t.tgname::text END AS catalog_name",
    );
    expect(renderManagedCatalogSql).toContain("t.relname='pg_toast_'||r.oid");
    expect(renderManagedCatalogSql).toContain("t.oid=r.reltoastrelid");
    expect(renderManagedCatalogSql).toContain("'enabled',t.tgenabled");
    expect(renderManagedCatalogSql).toContain(
      'PARTITION BY t.tgrelid ORDER BY t.tgname COLLATE "C"',
    );
    expect(renderManagedCatalogSql).toContain("'nameOrder',t.name_order");
    expect(renderManagedCatalogSql).toContain("LEFT JOIN generated_names obj");
    expect(renderManagedCatalogSql).toContain("LEFT JOIN generated_names ref");
    expect(renderManagedCatalogSql).not.toContain("regexp_replace");
    expect(renderManagedCatalogSql).toContain(
      "(d.classid,d.objid) IN (SELECT classid,oid FROM application_objects)",
    );
    expect(renderManagedCatalogSql).toContain(
      "(d.refclassid,d.refobjid) IN (SELECT classid,oid FROM application_objects)",
    );
  });

  it("rejects non-JSON evidence instead of silently discarding unknown metadata", () => {
    for (const value of [
      undefined,
      Number.NaN,
      Infinity,
      new Date(),
      { x: undefined },
      new Array(2),
    ])
      expect(() => renderManagedEvidenceDigest(value)).toThrow(
        "managed_evidence_json",
      );
    expect(renderManagedEvidenceDigest({ a: 1, b: 2 })).toBe(
      renderManagedEvidenceDigest({ b: 2, a: 1 }),
    );
  });
});
