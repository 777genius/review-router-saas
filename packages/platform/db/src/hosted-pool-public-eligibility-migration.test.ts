import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../prisma/migrations");
const migration = "000096_hosted_pool_public_repository_eligibility";
const sql = readFileSync(resolve(root, migration, "migration.sql"), "utf8");
const functions = [
  ["hosted_codex_comment_token_mint_guard", "guard"],
  [
    "hosted_codex_comment_token_prepare_authority_complete",
    "prepare_authority",
  ],
] as const;

function definition(source: string, name: string, delimiter: string) {
  const pattern = new RegExp(
    `CREATE(?: OR REPLACE)? FUNCTION (?:public\\.)?${name}\\(\\)[\\s\\S]+?\\$${delimiter}\\$;`,
    "gu",
  );
  return [...source.matchAll(pattern)].at(-1)?.[0];
}

describe("000096 public Hosted repository eligibility migration", () => {
  it.each(functions)(
    "replaces only the visibility predicate in latest %s",
    (name, delimiter) => {
      // Resolve the latest definition from *all* preceding migrations, so a later
      // parent replacement cannot silently be overwritten by copying an old body.
      const preceding = readdirSync(root)
        .filter((entry) => entry < migration)
        .sort();
      let latest: string | undefined;
      for (const entry of preceding) {
        if (!/^\d{6}_/u.test(entry)) continue;
        latest =
          definition(
            readFileSync(resolve(root, entry, "migration.sql"), "utf8"),
            name,
            delimiter,
          ) ?? latest;
      }
      expect(latest).toBeDefined();
      const replacement = definition(sql, name, delimiter);
      expect(replacement).toBeDefined();
      expect(replacement).toBe(
        latest!
          .replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION")
          .replace(/IN \('private',\s*'internal'\)/u, (match) =>
            match.replace(
              "'private'",
              "'public'," + (match.includes(", ") ? " " : "") + "'private'",
            ),
          ),
      );
    },
  );

  it("contains exactly two explicit replacements and no other DDL or data mutation", () => {
    let remaining = sql.replace(/^--.*$/gmu, "");
    for (const [name, delimiter] of functions) {
      remaining = remaining.replace(definition(sql, name, delimiter)!, "");
    }
    expect(remaining.trim()).toBe("");
    // Full-body equality above preserves invoker/definer mode, search_path,
    // locking, tenant/workflow authority, immutable fields and state transitions.
    // CREATE OR REPLACE keeps existing OIDs, owners, ACLs and trigger bindings;
    // a disposable PostgreSQL rehearsal still must verify actual catalog state.
  });
});
