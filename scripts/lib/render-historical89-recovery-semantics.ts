import type { CommandExecutor } from "../../packages/features/release-rollout/src/adapters/process-command";

// Deliberately recognizes only PostgreSQL's parenthesized AND operands. All
// other SQL is opaque, including OR/NOT subtrees and function arguments.
export function canonicalRecoveryCheck(definition: string): string {
  if (!definition.startsWith("CHECK (")) return definition;
  function conjunction(original: string): string[] | null {
    let s = original;
    for (;;) {
      let depth = 0,
        bracket = 0,
        quote = "",
        end = -1;
      const splits: number[] = [];
      for (let i = 0; i < s.length; i++) {
        const c = s[i]!;
        if (quote) {
          if (c === quote) {
            if (s[i + 1] === quote) i++;
            else quote = "";
          }
          // Escape strings and uncommon syntax remain byte-exact.
          if (c === "\\") return null;
          continue;
        }
        if (c === "'" || c === '"') {
          quote = c;
          continue;
        }
        if (
          c === "$" ||
          s.slice(i, i + 2) === "--" ||
          s.slice(i, i + 2) === "/*"
        )
          return null;
        if (c === "[") bracket++;
        if (c === "]") bracket--;
        if (c === "(") depth++;
        if (c === ")") {
          depth--;
          if (depth === 0 && end < 0) end = i;
        }
        if (depth < 0 || bracket < 0) return null;
        if (depth === 0 && bracket === 0 && s.slice(i, i + 5) === " AND ")
          splits.push(i);
      }
      if (quote || depth || bracket) return null;
      if (s[0] === "(" && end === s.length - 1) {
        s = s.slice(1, -1);
        continue;
      }
      if (!splits.length) return null;
      const parts: string[] = [];
      let start = 0;
      for (const at of splits) {
        parts.push(s.slice(start, at));
        start = at + 5;
      }
      parts.push(s.slice(start));
      // Each operand must be one balanced parenthesized expression, not e.g.
      // BETWEEN, NOT (...), (...) OR (...), or a function call.
      for (const part of parts) {
        if (!part.startsWith("(") || !part.endsWith(")")) return null;
        let d = 0,
          q = "";
        for (let i = 0; i < part.length; i++) {
          const c = part[i]!;
          if (q) {
            if (c === q) {
              if (part[i + 1] === q) i++;
              else q = "";
            }
            continue;
          }
          if (c === "'" || c === '"') q = c;
          else if (c === "(") d++;
          else if (c === ")" && --d === 0 && i !== part.length - 1) return null;
        }
      }
      return parts.flatMap((part) => conjunction(part) ?? [part]);
    }
  }
  const parts = conjunction(definition.slice(6));
  return parts ? `CHECK (${parts.join(" AND ")})` : definition;
}

// Null relation ACLs mean the relkind-specific built-in default, not no grants.
// Preserve non-grant-bearing relation kinds verbatim (indexes, composite types).
const relationAcl = `CASE WHEN c.relkind IN ('r','p','v','m','f','S') THEN (SELECT coalesce(json_agg(json_build_object('grantor',pg_get_userbyid(a.grantor),'granteePublic',a.grantee=0,'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY pg_get_userbyid(a.grantor),a.grantee=0,pg_get_userbyid(a.grantee),a.privilege_type,a.is_grantable),'[]'::json) FROM aclexplode(coalesce(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner))) a) ELSE to_json(c.relacl) END`;

export function recoverySemanticCommands(
  commands: CommandExecutor,
): CommandExecutor {
  return {
    execute(command, args, options) {
      const sql = args.at(-1) ?? "";
      const acl =
        command === "psql" &&
        sql.includes("'kind','object'") &&
        sql.includes("'acl',c.relacl");
      const check =
        command === "psql" &&
        sql.includes("'kind','constraint'") &&
        sql.includes("pg_get_constraintdef(c.oid)");
      const actual = acl
        ? [
            ...args.slice(0, -1),
            sql.replace("'acl',c.relacl", `'acl',${relationAcl}`),
          ]
        : args;
      const result = commands.execute(command, actual, options);
      if (!check) return result;
      const rows = JSON.parse(result.stdout);
      if (!Array.isArray(rows)) return result;
      return {
        ...result,
        stdout: JSON.stringify(
          rows.map((row) =>
            row.kind === "constraint" && typeof row.definition === "string"
              ? { ...row, definition: canonicalRecoveryCheck(row.definition) }
              : row,
          ),
        ),
      };
    },
    hashStdout: (command, args, options) =>
      commands.hashStdout(command, args, options),
    executeExpectingFailure: (command, args, options) =>
      commands.executeExpectingFailure(command, args, options),
  };
}
