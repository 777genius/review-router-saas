import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const prisma = readFileSync(
  new URL("../prisma/schema.prisma", import.meta.url),
  "utf8",
);
const migrations = new URL("../prisma/migrations/", import.meta.url);
const sql = readFileSync(
  new URL("000098_certified_fork_effect_archive/migration.sql", migrations),
  "utf8",
);
const tables = ["Family", "Version", "Receipt", "Checkpoint"].map(
  (n) => `CertifiedFork${n}`,
);

describe("CertifiedFork schema contract (catalog execution is a separate real PG gate)", () => {
  it("uses the allocated migration once and maps every stored column losslessly", () => {
    expect(
      readdirSync(migrations).filter((n) => n.startsWith("000098")),
    ).toEqual(["000098_certified_fork_effect_archive"]);
    expect(
      [...sql.matchAll(/CREATE TABLE public\."(\w+)"/gu)].map((m) => m[1]),
    ).toEqual(tables);
    for (const table of tables) {
      const ddl = sql
        .split(`CREATE TABLE public."${table}" (`)[1]!
        .split("\n);")[0]!;
      const model = prisma.split(`model ${table} {`)[1]!.split("\n}")[0]!;
      for (const [, name, type, required] of ddl.matchAll(
        /^ {2}"(\w+)" (text|bigint|integer|jsonb|varchar\(64\))( NOT NULL)?/gmu,
      )) {
        const tsType = {
          text: "String",
          bigint: "BigInt",
          integer: "Int",
          jsonb: "Json",
          "varchar(64)": "String",
        }[type!];
        expect(model).toMatch(
          new RegExp(
            `\\b${name}\\s+${tsType}${required ? "(?!\\?)\\s" : "\\?\\s"}`,
          ),
        );
      }
    }
  });

  it("declares explicit unique FK targets and exactly the two deferred cycles", () => {
    const targets = [
      ...sql.matchAll(/REFERENCES public\."(\w+)" \(([^)]+)\)/gu),
    ];
    expect(targets).toHaveLength(6);
    for (const [, table, columns] of targets) {
      const ddl = sql
        .split(`CREATE TABLE public."${table}" (`)[1]!
        .split("\n);")[0]!;
      expect(
        ddl.includes(`PRIMARY KEY (${columns})`) ||
          ddl.includes(`UNIQUE (${columns})`),
      ).toBe(true);
    }
    expect(
      sql.match(/ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED/gu),
    ).toHaveLength(2);
    expect(sql).not.toMatch(/ON (?:DELETE|UPDATE) CASCADE/u);
    expect(sql).toContain('"positionCommandId" varchar(64) NOT NULL');
    expect(sql).toContain('"positionCommandHash" text NOT NULL');
    expect(sql).toContain('"claimEpoch" = "fence"');
  });

  it("reserves mutation for the isolated writer and strips actual default grants", () => {
    expect(sql).toContain(
      'GRANT UPDATE ("tipVersion") ON public."CertifiedForkFamily"',
    );
    expect(sql).toContain("GRANT SELECT, INSERT ON TABLE");
    expect(sql).toContain("GRANT SELECT ON TABLE");
    expect(sql).toContain("aclexplode(c.relacl)");
    expect(sql).toContain("aclexplode(p.proacl)");
    expect(sql).toContain("pg_auth_members");
    expect(sql).toContain("certified_fork_role_membership_precondition");
    expect(sql).toContain("GRANTED BY %I RESTRICT");
    expect(sql).toContain("DROP ROLE reviewrouter_certified_fork_creator;");
    expect(sql).toContain("certified_fork_membership_cleanup_incomplete");
    expect(sql).toContain("certified_fork_existing_membership");
    expect(sql).not.toContain("SECURITY DEFINER");
    expect(sql).not.toMatch(/GRANT .* TO reviewrouter(?:;|\s)/u);
    expect(sql.match(/SET search_path = pg_catalog, pg_temp/gu)).toHaveLength(
      2,
    );
    expect(sql).toContain("BEFORE TRUNCATE");
    expect(sql).toContain(
      "REVOKE CREATE ON SCHEMA public FROM reviewrouter_certified_fork_owner",
    );
  });
});
