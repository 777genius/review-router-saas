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
        /^ {2}"(\w+)" (text|bytea|bigint|integer|jsonb|varchar\(64\))( NOT NULL)?/gmu,
      )) {
        const tsType = {
          text: "String",
          bytea: "Bytes",
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

  it("keeps original generation admission input distinct from the domain-derived review commitment", () => {
    expect(sql).not.toContain(
      `c."state"->'review'->'admissionHash' = v."seed"->'admissionHash'`,
    );
    for (const invariant of [
      `v."generation" = 0`,
      `v."seed"->'admissionHash' = 'null'::jsonb`,
      `v."seed"->'predecessor' = 'null'::jsonb`,
      `c."state"->'review'->'admissionHash' = 'null'::jsonb`,
      `v."generation" > 0`,
      `jsonb_typeof(v."seed"->'admissionHash') = 'string'`,
      `(v."seed"->>'admissionHash') ~ '^[a-f0-9]{64}$'`,
      `jsonb_typeof(v."seed"->'predecessor') = 'string'`,
      `length(v."seed"->>'predecessor') BETWEEN 1 AND 4096`,
      `jsonb_typeof(c."state"->'review'->'admissionHash') = 'string'`,
      `(c."state"->'review'->>'admissionHash') ~ '^[a-f0-9]{64}$'`,
    ])
      expect(sql).toContain(invariant);
    expect(sql).toContain("SQL\n      -- does not recompute that capability");
  });

  it("bounds proof index keys without reducing the opaque token contract", () => {
    expect(sql).toContain('length("proof") BETWEEN 1 AND 4096');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "CertifiedForkCheckpoint_proof_sha256_key"',
    );
    expect(sql).toContain(
      'ON public."CertifiedForkCheckpoint" ("proofSha256")',
    );
    expect(sql).toContain('"proofSha256" bytea NOT NULL');
    expect(sql).toContain('pg_catalog.octet_length("proofSha256") = 32 AND');
    expect(sql).toContain(
      '"proofSha256" = pg_catalog.sha256(pg_catalog.convert_to("proof", \'UTF8\'))',
    );
    expect(sql).not.toMatch(
      /textsend|\bIMMUTABLE\b|GENERATED\s+ALWAYS|\bmd5\s*\(/iu,
    );
    expect(sql).not.toContain('UNIQUE ("proof")');
    expect(sql).not.toMatch(/CREATE EXTENSION/iu);
    const model = prisma
      .split("model CertifiedForkCheckpoint {")[1]!
      .split("\n}")[0]!;
    expect(model).toMatch(/proof\s+String\s+@db.Text/u);
    expect(model).not.toMatch(/proof\s+[^\n]*@unique/u);
    expect(model).toMatch(
      /proofSha256\s+Bytes\s+@unique\(map: "CertifiedForkCheckpoint_proof_sha256_key"\) @db.ByteA/u,
    );
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

  it("validates global roles before temporary grants and requires real reuse authority", () => {
    const createHelper = sql.indexOf(
      "CREATE ROLE reviewrouter_certified_fork_creator",
    );
    for (const precondition of [
      "certified_fork_existing_membership",
      "certified_fork_unsafe_role",
      "certified_fork_role_membership_precondition",
      "certified_fork_schema_owner_precondition",
      "certified_fork_existing_owner_admin_precondition",
    ]) {
      expect(sql.indexOf(precondition)).toBeGreaterThan(0);
      expect(sql.indexOf(precondition)).toBeLessThan(createHelper);
    }
    expect(sql).toContain(
      "AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user)",
    );
    expect(sql).toContain(
      "GRANT reviewrouter_certified_fork_owner TO reviewrouter_certified_fork_creator WITH ADMIN TRUE, INHERIT FALSE, SET TRUE GRANTED BY %I",
    );
    expect(sql).toContain("OR NOT m.admin_option OR m.inherit_option");
    expect(sql).not.toMatch(/SET (?:LOCAL )?ROLE postgres/u);
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
