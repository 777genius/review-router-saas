import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertEmptyApplicableRenderDefaultAcl,
  assertRenderSchemaHandoffCatalog,
  assertRenderSchemaHandoffLedger,
  partitionRenderSchemaHandoffCheckout,
  readRenderSchemaHandoffCatalog,
  renderSchemaHandoffCheckoutExtension,
  renderSchemaHandoffMigrationContract as contract,
} from "./render-schema-handoff-policy.mjs";

type CatalogRow = { migrationName: string; checksum: string };
const catalog: readonly CatalogRow[] = readRenderSchemaHandoffCatalog();
const extension: readonly CatalogRow[] = renderSchemaHandoffCheckoutExtension;
const expanded = [...catalog, ...extension];

describe("explicit checkout partition with an unchanged managed92 validator", () => {
  it("projects exactly92 and exactly95 to the same ordered rows", () => {
    for (const source of [catalog, expanded]) {
      const before = structuredClone(source);
      const managed = partitionRenderSchemaHandoffCheckout(source);
      expect(managed).toEqual(catalog);
      expect(Object.isFrozen(managed)).toBe(true);
      expect(source).toEqual(before);
    }
    expect(() => assertRenderSchemaHandoffCatalog(expanded)).toThrow(
      "migration_catalog",
    );
    expect(
      createHash("sha256")
        .update(
          expanded.map((r) => `${r.migrationName}:${r.checksum}`).join(","),
        )
        .digest("hex"),
    ).toBe("6c62ac869a47211043f8fffdd7af105cb6bd677b65462033195d41e7d7aafa2e");
  });

  it("rejects drift or removal of every original and extension identity", () => {
    for (const source of [catalog, expanded]) {
      for (const [index] of source.entries()) {
        const changed = source.map((row) => ({ ...row }));
        changed[index]!.checksum = "0".repeat(64);
        expect(() => partitionRenderSchemaHandoffCheckout(changed)).toThrow();
        expect(() =>
          partitionRenderSchemaHandoffCheckout(
            source.filter((_, i) => i !== index),
          ),
        ).toThrow();
      }
    }
  });

  it("rejects all six partial extension sets and preserves zero extensions", () => {
    for (const bits of [1, 2, 3, 4, 5, 6]) {
      const partial = extension.filter((_, i) => bits & (1 << i));
      expect(() =>
        partitionRenderSchemaHandoffCheckout([...catalog, ...partial]),
      ).toThrow("checkout_extension");
    }
    expect(partitionRenderSchemaHandoffCheckout(catalog)).toEqual(catalog);
  });

  it.each(["000000_unknown", "000050_unknown", "999999_unknown"])(
    "rejects %s as an addition or replacement in either checkout",
    (migrationName) => {
      for (const source of [catalog, expanded]) {
        const unknown = { migrationName, checksum: "a".repeat(64) };
        for (const changed of [
          [...source, unknown],
          [...source.slice(1), unknown],
        ]) {
          changed.sort((a, b) =>
            a.migrationName.localeCompare(b.migrationName, "en"),
          );
          expect(() => partitionRenderSchemaHandoffCheckout(changed)).toThrow();
        }
      }
    },
  );

  it("never normalizes duplicate/reordered/malformed rows or infers numeric identities", () => {
    for (const source of [catalog, expanded]) {
      for (const changed of [
        [...source].reverse(),
        [source[0], ...source.slice(0, -1)],
        [...source, source.at(-1)],
        [null, ...source.slice(1)],
        source.map((row) => ({
          ...row,
          migrationName: row.migrationName.slice(0, 6),
        })),
        null,
        [],
      ])
        expect(() => partitionRenderSchemaHandoffCheckout(changed)).toThrow();
    }
  });
});

// The checkpoint batch runs these real modules in a disposable95 checkout built
// from committed PR244 SQL. On original92 this also exercises the unextended
// reader; after integration the same tests cover95 without fixture SQL copies.
describe("complete filesystem checkout inventory", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const path of directories.splice(0))
      rmSync(path, { recursive: true, force: true });
  });
  async function checkout() {
    const artifacts = "/tmp/rr-managed-catalog-partition-r1-artifacts";
    mkdirSync(artifacts, { recursive: true });
    const root = mkdtempSync(join(artifacts, "reader-"));
    directories.push(root);
    const lib = join(root, "scripts/lib");
    const migrations = join(root, "packages/platform/db/prisma/migrations");
    mkdirSync(lib, { recursive: true });
    for (const name of [
      "render-schema-handoff-policy.mjs",
      "canonical-prisma-migration-catalog.mjs",
    ])
      cpSync(new URL(name, import.meta.url), join(lib, name));
    cpSync(
      new URL("../../packages/platform/db/prisma/migrations", import.meta.url),
      migrations,
      { recursive: true },
    );
    const policy = await import(
      pathToFileURL(join(lib, "render-schema-handoff-policy.mjs")).href
    );
    const canonical = await import(
      pathToFileURL(join(lib, "canonical-prisma-migration-catalog.mjs")).href
    );
    return {
      migrations,
      read: policy.readRenderSchemaHandoffCatalog,
      canonical,
    };
  }

  it("reads the complete checkout and original92 as identical frozen92 rows", async () => {
    const fixture = await checkout();
    const inventory = readdirSync(fixture.migrations).sort();
    expect(inventory).toEqual(fixture.canonical.canonicalPrismaMigrationNames);
    expect([92, 95]).toContain(inventory.length);
    const actual = fixture.read();
    expect(actual).toEqual(catalog);
    expect(Object.isFrozen(actual)).toBe(true);
    expect(actual.every(Object.isFrozen)).toBe(true);
    if (inventory.length === 95) {
      const bytes = extension.map((row) =>
        readFileSync(
          join(fixture.migrations, row.migrationName, "migration.sql"),
        ),
      );
      for (const bits of [1, 2, 3, 4, 5, 6]) {
        for (const [index, row] of extension.entries()) {
          const path = join(fixture.migrations, row.migrationName);
          rmSync(path, { recursive: true, force: true });
          if (bits & (1 << index)) {
            mkdirSync(path);
            writeFileSync(join(path, "migration.sql"), bytes[index]!);
          }
        }
        expect(() => fixture.read()).toThrow("checkout_extension");
      }
    }
    for (const row of extension)
      rmSync(join(fixture.migrations, row.migrationName), {
        recursive: true,
        force: true,
      });
    expect(readdirSync(fixture.migrations)).toHaveLength(92);
    expect(fixture.read()).toEqual(actual);
  });

  it.each([
    "000000_unknown",
    "000050_unknown",
    "999999_unknown",
    ".hidden",
    "README",
    "000090-UPPER",
    "000090_bad-name",
  ])(
    "rejects directory %s even after the shared scanner has cached names",
    async (name) => {
      const fixture = await checkout();
      const path = join(fixture.migrations, name);
      mkdirSync(path);
      writeFileSync(join(path, "migration.sql"), "SELECT 1;\n");
      expect(fixture.canonical.canonicalPrismaMigrationNames).not.toContain(
        name,
      );
      expect(() => fixture.read()).toThrow("render_schema_handoff_rejected:");
    },
  );

  it("rejects non-directory inventory entries, replacements and symlinks", async () => {
    const fixture = await checkout();
    const extra = join(fixture.migrations, "README");
    writeFileSync(extra, "unexpected");
    expect(() => fixture.read()).toThrow("checkout_inventory");
    rmSync(extra);
    const original = join(fixture.migrations, catalog[0]!.migrationName);
    const replacement = join(fixture.migrations, "000000_unknown");
    renameSync(original, replacement);
    expect(() => fixture.read()).toThrow();
    renameSync(replacement, original);
    const sql = join(original, "migration.sql");
    const outside = join(fixture.migrations, "..", "saved.sql");
    renameSync(sql, outside);
    symlinkSync(outside, sql);
    expect(() => fixture.read()).toThrow("checkout_inventory");
  });

  it("rejects changed or missing SQL and missing directories across the real inventory", async () => {
    const fixture = await checkout();
    for (const name of readdirSync(fixture.migrations).sort()) {
      const directory = join(fixture.migrations, name);
      const sql = join(directory, "migration.sql");
      const bytes = readFileSync(sql);
      writeFileSync(sql, Buffer.concat([bytes, Buffer.from("\n-- drift\n")]));
      expect(() => fixture.read()).toThrow();
      rmSync(sql);
      expect(() => fixture.read()).toThrow("checkout_inventory");
      rmSync(directory, { recursive: true });
      expect(() => fixture.read()).toThrow();
      mkdirSync(directory);
      writeFileSync(sql, bytes);
    }
    expect(fixture.read()).toEqual(catalog);
  });
});

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
