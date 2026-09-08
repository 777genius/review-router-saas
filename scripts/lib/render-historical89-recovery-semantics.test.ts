import { describe, expect, it } from "vitest";
import measured from "./render-historical89-recovery-measured.fixture.json";
import {
  canonicalRecoveryCheck as canonical,
  recoverySemanticCommands,
} from "./render-historical89-recovery-semantics";
import type { CommandExecutor } from "../../packages/features/release-rollout/src/adapters/process-command";

function harness(stdout: string) {
  let received: readonly string[] = [];
  const commands: CommandExecutor = {
    execute(_command, args) {
      received = args;
      return { stdout };
    },
    hashStdout: async () => {
      throw new Error("unexpected hash");
    },
    executeExpectingFailure: () => {
      throw new Error("unexpected failure");
    },
  };
  return {
    run: (sql: string) =>
      recoverySemanticCommands(commands).execute("psql", ["--command", sql]),
    sql: () => received.at(-1)!,
  };
}

describe("bounded recovery CHECK semantics", () => {
  it("equates both exact measured dump/reparse pairs", () => {
    for (const pair of measured.constraints_indexes_triggers) {
      expect(pair.left).not.toBe(pair.right);
      expect(canonical(pair.left)).toBe(canonical(pair.right));
      expect(canonical(canonical(pair.left))).toBe(canonical(pair.left));
      expect(canonical(pair.left)).not.toBe(
        canonical(pair.right.replace(">= 1", ">= 2")),
      );
    }
  });
  it("flattens only AND, with atoms and their order intact", () => {
    expect(canonical("CHECK (((a) AND (b)) AND ((c) AND (d)))")).toBe(
      "CHECK ((a) AND (b) AND (c) AND (d))",
    );
    const distinct = [
      ["CHECK (((a) AND (b)) AND (c))", "CHECK (((a) OR (b)) AND (c))"],
      ["CHECK ((a) AND (b))", "CHECK ((b) AND (a))"],
      ["CHECK ((a) AND (b))", "CHECK ((NOT (a)) AND (b))"],
      ["CHECK (((a) OR (b)) AND (c))", "CHECK ((a) OR ((b) AND (c)))"],
      ["CHECK ((f((a) AND (b))) AND (c))", "CHECK ((f(a, b)) AND (c))"],
      [
        "CHECK ((x = 'a AND b'::text) AND (c))",
        "CHECK ((x = 'a OR b'::text) AND (c))",
      ],
      [
        "CHECK ((x = 'a'' AND b'::text) AND (c))",
        "CHECK ((x = 'a'' AND b'::varchar) AND (c))",
      ],
      ['CHECK (("AND" = 1) AND (c))', 'CHECK (("OR" = 1) AND (c))'],
      [
        "CHECK (((x + y) * z > 1) AND (c))",
        "CHECK ((x + (y * z) > 1) AND (c))",
      ],
    ];
    for (const [a, b] of distinct)
      expect(canonical(a!)).not.toBe(canonical(b!));
    for (const opaque of [
      "CHECK (a BETWEEN 1 AND 2)",
      "CHECK (NOT ((a) AND (b)))",
      "CHECK ((a) OR ((b) AND (c)))",
      "CHECK ((f($q$ AND $q$)) AND (b))",
      "CHECK ((a) AND (b)) NOT VALID",
    ])
      expect(canonical(opaque)).toBe(opaque);
  });
  it("changes only constraint definitions in the actual command response", () => {
    const pair = measured.constraints_indexes_triggers[0]!;
    const rows = ["constraint", "index", "trigger"].map((kind) => ({
      kind,
      name: "any_name",
      definition: pair.left,
      other: 1,
    }));
    const h = harness(JSON.stringify(rows));
    const result = JSON.parse(
      h.run("SELECT 'kind','constraint',pg_get_constraintdef(c.oid)").stdout,
    );
    expect(result[0]).toEqual({
      ...rows[0],
      definition: canonical(pair.right),
    });
    expect(result.slice(1)).toEqual(rows.slice(1));
  });
});

describe("recovery relation ACL projection", () => {
  it("uses PostgreSQL default expansion for all eight measured owner/default pairs", () => {
    expect(measured.acl_ownership_defaults).toHaveLength(8);
    for (const pair of measured.acl_ownership_defaults) {
      expect(pair.left).toEqual(["reviewrouter=arwdDxtm/reviewrouter"]);
      expect(pair.right).toBeNull();
      expect(pair.owner).toBe("reviewrouter");
      expect(pair.type).toBe("r");
    }
    const h = harness("[]");
    h.run(
      "SELECT 'kind','object','type',c.relkind,'owner',pg_get_userbyid(c.relowner),'acl',c.relacl,'default',d.defaclacl",
    );
    expect(h.sql()).toContain(
      "aclexplode(coalesce(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 's'::\"char\" ELSE 'r'::\"char\" END,c.relowner)))",
    );
    expect(h.sql()).toContain("ELSE to_json(c.relacl) END");
    for (const fragment of [
      "'type',c.relkind",
      "'owner',pg_get_userbyid(c.relowner)",
      "'grantor',pg_get_userbyid(a.grantor)",
      "WHEN a.grantee=0 THEN 'PUBLIC'",
      "'granteePublic',a.grantee=0",
      "'privilege',a.privilege_type",
      "'grantable',a.is_grantable",
      "'default',d.defaclacl",
    ])
      expect(h.sql()).toContain(fragment);
  });
  it("does not collapse changed owner, grantor, grantee, PUBLIC, privilege or grant option", () => {
    const row = {
      kind: "object",
      type: "r",
      owner: "reviewrouter",
      acl: [
        {
          grantor: "reviewrouter",
          grantee: "reviewrouter",
          granteePublic: false,
          privilege: "SELECT",
          grantable: false,
        },
      ],
    };
    const variants = [
      { ...row, owner: "other" },
      { ...row, type: "S" },
      { ...row, acl: [] },
      ...[
        { grantor: "other" },
        { grantee: "other" },
        { grantee: "PUBLIC" },
        { grantee: "PUBLIC", granteePublic: true },
        { privilege: "UPDATE" },
        { grantable: true },
      ].map((change) => ({ ...row, acl: [{ ...row.acl[0], ...change }] })),
    ];
    for (const variant of variants) {
      const h = harness(JSON.stringify([variant]));
      expect(
        JSON.parse(h.run("SELECT 'kind','object','acl',c.relacl").stdout),
      ).toEqual([variant]);
      expect(variant).not.toEqual(row);
    }
  });
});

describe("recovery semantic command boundary", () => {
  it("forwards other metadata, row hashes and denied-principal checks exactly", async () => {
    const seen: unknown[][] = [];
    const result = { stdout: "original bytes\n" };
    const hash = { rows: 7, sha256: "exact-row-hash" };
    const denied = { reason: "database_connect_permission_denied" as const };
    const commands: CommandExecutor = {
      execute(...args) {
        seen.push(args);
        return result;
      },
      async hashStdout(...args) {
        seen.push(args);
        return hash;
      },
      executeExpectingFailure(...args) {
        seen.push(args);
        return denied;
      },
    };
    const wrapper = recoverySemanticCommands(commands);
    const options = { timeoutMs: 1234 };
    for (const sql of [
      "SELECT 'notNull',a.attnotnull",
      "SELECT 'force',c.relforcerowsecurity",
      "SELECT 'kind','function'",
      "SELECT row_to_json(m)",
      "SELECT 'lastValue'",
      "SELECT effective_principals",
    ]) {
      const args = ["--command", sql];
      expect(wrapper.execute("psql", args, options)).toBe(result);
      expect(seen.at(-1)).toEqual(["psql", args, options]);
    }
    const args = ["--command", "COPY public.fixture TO STDOUT"];
    expect(await wrapper.hashStdout("psql", args, options)).toBe(hash);
    expect(seen.at(-1)).toEqual(["psql", args, options]);
    expect(wrapper.executeExpectingFailure("psql", args, options)).toBe(denied);
    expect(seen.at(-1)).toEqual(["psql", args, options]);
    const dumpArgs = ["'kind','object' 'acl',c.relacl"];
    expect(wrapper.execute("pg_dump", dumpArgs, options)).toBe(result);
    expect(seen.at(-1)).toEqual(["pg_dump", dumpArgs, options]);
  });
});
