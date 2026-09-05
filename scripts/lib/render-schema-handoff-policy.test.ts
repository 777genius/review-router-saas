import { describe, expect, it } from "vitest";
import {
  assertEmptyApplicableRenderDefaultAcl,
  assertRenderSchemaHandoffCatalog,
  assertRenderSchemaHandoffLedger,
  readRenderSchemaHandoffCatalog,
  renderSchemaHandoffMigrationContract as contract,
} from "./render-schema-handoff-policy.mjs";

const catalog = readRenderSchemaHandoffCatalog();
const ledger = (count: number = contract.baselineCount) =>
  catalog.slice(0, count).map((row) => ({
    ...row,
    finished: true,
    rolledBack: false,
    appliedStepsCount: 1,
    hasLogs: false,
  }));
const principals = ["reviewrouter", "reviewrouter_release_schema_owner"];
const defaultRow = () => ({
  oid: "12345",
  owner: "reviewrouter",
  schema: "*",
  objectType: "r",
  entries: [
    {
      grantee: "reviewrouter",
      grantor: "reviewrouter",
      privilege: "SELECT",
      grantable: false,
    },
  ],
});
const assertDefaults = (rows: unknown) =>
  assertEmptyApplicableRenderDefaultAcl({ version: 1, rows }, principals);

describe("managed schema handoff immutable source and history boundary", () => {
  it("binds all 92 source checksums and the exact 89-row prefix", () => {
    expect(catalog).toHaveLength(92);
    expect(catalog.slice(89)).toEqual(contract.pending);
    expect(contract.sourceCommit).toBe(
      "42134d9b8c263915340f910786b6826824bf30b5",
    );
    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.pending[0])).toBe(true);
    expect(Object.isFrozen(catalog[0])).toBe(true);
    expect(() => assertRenderSchemaHandoffCatalog(catalog)).not.toThrow();
  });

  it("accepts complete unordered history without mutating the observation", () => {
    for (const phase of ["baseline", "target"]) {
      const rows = ledger(phase === "baseline" ? 89 : 92).reverse();
      const before = structuredClone(rows);
      expect(() =>
        assertRenderSchemaHandoffLedger(catalog, rows, phase),
      ).not.toThrow();
      expect(rows).toEqual(before);
    }
  });

  it.each([0, 88, 89, 90, 91])(
    "rejects source checksum drift at entry %s even with matching observed history",
    (index) => {
      const changed = catalog.map((row) => ({ ...row }));
      changed[index]!.checksum = "a".repeat(64);
      expect(() => assertRenderSchemaHandoffCatalog(changed)).toThrow(
        "migration_catalog",
      );
      expect(() =>
        assertRenderSchemaHandoffLedger(changed, ledger(), "baseline"),
      ).toThrow("migration_catalog");
    },
  );

  it("rejects duplicate, reordered, truncated, or extended source catalogs", () => {
    for (const changed of [
      [catalog[0], ...catalog.slice(0, -1)],
      [...catalog].reverse(),
      catalog.slice(1),
      [...catalog, catalog[91]],
      null,
      [],
    ])
      expect(() => assertRenderSchemaHandoffCatalog(changed)).toThrow(
        "migration_catalog",
      );
  });

  it.each(["finished", "rolledBack", "appliedStepsCount", "hasLogs"])(
    "rejects ambiguous history field %s",
    (field) => {
      const rows = ledger();
      const values = {
        finished: false,
        rolledBack: true,
        appliedStepsCount: 0,
        hasLogs: true,
      };
      Object.assign(rows[10]!, {
        [field]: values[field as keyof typeof values],
      });
      expect(() =>
        assertRenderSchemaHandoffLedger(catalog, rows, "baseline"),
      ).toThrow("ledger_prefix");
    },
  );

  it("rejects failed duplicates instead of filtering them away", () => {
    const rows = ledger();
    rows.push({ ...rows[0]!, finished: false, rolledBack: true });
    expect(() =>
      assertRenderSchemaHandoffLedger(catalog, rows, "baseline"),
    ).toThrow("ledger_count");
    rows.pop();
    rows[1] = { ...rows[0]! };
    expect(() =>
      assertRenderSchemaHandoffLedger(catalog, rows, "baseline"),
    ).toThrow("ledger_prefix");
  });

  it("never admits partial 87-89 application as either terminal phase", () => {
    for (const count of [88, 90, 91])
      for (const phase of ["baseline", "target"])
        expect(() =>
          assertRenderSchemaHandoffLedger(catalog, ledger(count), phase),
        ).toThrow();
    expect(() =>
      assertRenderSchemaHandoffLedger(catalog, ledger(), "anything"),
    ).toThrow("ledger_phase");
  });
});

describe("empty applicable pg_default_acl is distinct from unknown state", () => {
  it("accepts an observed empty catalog", () => {
    expect(() => assertDefaults([])).not.toThrow();
  });

  it.each([undefined, null, {}, { version: 1 }, { version: 2, rows: [] }])(
    "rejects missing or unsupported observation %#",
    (observation) => {
      expect(() =>
        assertEmptyApplicableRenderDefaultAcl(observation, principals),
      ).toThrow("default_acl_unknown");
    },
  );

  it("requires a nonempty and unambiguous separately reviewed principal set", () => {
    for (const names of [[], [""], ["reviewrouter", "reviewrouter"], null])
      expect(() =>
        assertEmptyApplicableRenderDefaultAcl({ version: 1, rows: [] }, names),
      ).toThrow("default_acl_unknown");
  });

  it("rejects a present empty ACL override", () => {
    expect(() => assertDefaults([{ ...defaultRow(), entries: [] }])).toThrow(
      "default_acl_policy",
    );
  });

  it("retains unrelated resolved defaults without treating them as applicable", () => {
    const row = defaultRow();
    row.schema = "unrelated";
    expect(() => assertDefaults([row])).not.toThrow();
    row.schema = "public";
    row.owner = "unrelated";
    row.entries = [];
    expect(() => assertDefaults([row])).not.toThrow();
  });

  it.each(["grantee", "grantor"])(
    "includes applicable privileges through %s even for another owner",
    (field) => {
      const row = defaultRow();
      row.owner = "unrelated";
      row.entries[0]!.grantee = "unrelated";
      row.entries[0]!.grantor = "unrelated";
      Object.assign(row.entries[0]!, { [field]: "reviewrouter" });
      expect(() => assertDefaults([row])).toThrow("default_acl_policy");
    },
  );

  it("includes PUBLIC grants and grant options", () => {
    const row = defaultRow();
    row.owner = "unrelated";
    row.entries[0] = {
      grantee: "PUBLIC",
      grantor: "unrelated",
      privilege: "EXECUTE",
      grantable: true,
    };
    expect(() => assertDefaults([row])).toThrow("default_acl_policy");
  });

  it.each(["owner", "schema", "objectType", "entries"])(
    "rejects unresolved %s even on an otherwise irrelevant row",
    (field) => {
      const row = { ...defaultRow(), schema: "unrelated", [field]: null };
      expect(() => assertDefaults([row])).toThrow("default_acl_unresolved");
    },
  );

  it.each(["grantee", "grantor", "privilege", "grantable"])(
    "rejects unresolved ACL entry %s",
    (field) => {
      const row = defaultRow();
      Object.assign(row.entries[0]!, { [field]: null });
      expect(() => assertDefaults([row])).toThrow("default_acl_unresolved");
    },
  );

  it("rejects duplicate catalog row identity", () => {
    const row = { ...defaultRow(), schema: "unrelated" };
    expect(() => assertDefaults([row, row])).toThrow("default_acl_unresolved");
  });
});
