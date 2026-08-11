import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PostgreSqlGenerationAdapter } from "./postgres-generation";
import type { CommandExecutor } from "./process-command";

const sourceUrl =
  "postgresql://source_user:source_secret@source.internal:5432/reviewrouter?sslmode=disable";
const targetUrl =
  "postgresql://target_user:target_secret@target.internal:5432/reviewrouter?sslmode=disable";

describe("PostgreSQL generation adapter", () => {
  it("rejects public database hosts before process execution", () => {
    const commands: CommandExecutor = {
      execute() {
        throw new Error("must not execute");
      },
    };
    expect(() =>
      new PostgreSqlGenerationAdapter(commands).quiesceSource(
        "postgresql://user:secret@public.example.com/reviewrouter",
      ),
    ).toThrow("postgres_generation_connection_invalid");
  });

  it("uses a custom no-owner/no-ACL dump without putting secrets in argv", () => {
    const dumpPath = "/tmp/reviewrouter-pg17-rehearsal/copy.dump";
    mkdirSync("/tmp/reviewrouter-pg17-rehearsal", { recursive: true });
    const calls: {
      command: string;
      args: readonly string[];
      env?: NodeJS.ProcessEnv;
    }[] = [];
    const commands: CommandExecutor = {
      execute(command, args, options) {
        calls.push({
          command,
          args,
          ...(options?.env ? { env: options.env } : {}),
        });
        writeFileSync(dumpPath, "custom-dump");
        return { stdout: "" };
      },
    };
    const result = new PostgreSqlGenerationAdapter(commands).captureBackup({
      sourceUrl,
      dumpPath,
      backup: {
        backupId: "backup-1",
        pitrIdentity: "pitr-lsn-1",
        capturedAt: "2026-08-11T00:00:00.000Z",
      },
    });
    expect(calls[0]?.args).toEqual(
      expect.arrayContaining([
        "--format=custom",
        "--no-owner",
        "--no-privileges",
      ]),
    );
    expect(calls[0]?.args.join(" ")).not.toContain("source_secret");
    expect(calls[0]?.env?.PGPASSWORD).toBe("source_secret");
    expect(result.dumpSha256).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("rejects digest changes and non-empty restore targets", () => {
    const dumpPath = "/tmp/reviewrouter-pg17-rehearsal/changed.dump";
    mkdirSync("/tmp/reviewrouter-pg17-rehearsal", { recursive: true });
    writeFileSync(dumpPath, "changed");
    const commands: CommandExecutor = {
      execute() {
        return { stdout: "0" };
      },
    };
    expect(() =>
      new PostgreSqlGenerationAdapter(commands).restoreCopy({
        targetUrl,
        dumpPath,
        dumpSha256: `sha256:${"0".repeat(64)}`,
      }),
    ).toThrow("postgres_generation_dump_digest_mismatch");
  });

  it("requires zero sessions and revoked runtime connect", () => {
    const good: CommandExecutor = {
      execute() {
        return {
          stdout:
            'BEGIN\n{"writersSuspended":true,"nonCutoverSessionCount":0,"sourceRuntimeConnectRevoked":true}\nCOMMIT\n',
        };
      },
    };
    expect(
      new PostgreSqlGenerationAdapter(good).quiesceSource(sourceUrl).evidence
        .nonCutoverSessionCount,
    ).toBe(0);
    const bypass: CommandExecutor = {
      execute() {
        return {
          stdout:
            '{"writersSuspended":true,"nonCutoverSessionCount":1,"sourceRuntimeConnectRevoked":true}',
        };
      },
    };
    expect(() =>
      new PostgreSqlGenerationAdapter(bypass).quiesceSource(sourceUrl),
    ).toThrow("postgres_generation_quiescence_failed");
  });

  it("compares rows hashes sequences constraints indexes and migration history", () => {
    const metadata = `sha256:${"f".repeat(64)}`;
    void metadata;
    const commands: CommandExecutor = {
      execute(_command, args) {
        const sql = args.at(-1) ?? "";
        if (sql.includes("pg_tables")) return { stdout: '["Workspace"]' };
        if (sql.includes("row_to_json(value)"))
          return { stdout: '{"id":"1"}\n{"id":"2"}' };
        return { stdout: "[]" };
      },
    };
    const result = new PostgreSqlGenerationAdapter(commands).verifyEquivalence(
      sourceUrl,
      targetUrl,
    );
    expect(result.evidence).toMatchObject({
      equivalent: true,
      tables: [{ table: "Workspace", sourceRows: 2, targetRows: 2 }],
    });
  });

  it("fails closed on a row splice", () => {
    const commands: CommandExecutor = {
      execute(_command, args) {
        const sql = args.at(-1) ?? "";
        const host = args[args.indexOf("--host") + 1];
        if (sql.includes("pg_tables")) return { stdout: '["Workspace"]' };
        if (sql.includes("row_to_json(value)"))
          return {
            stdout: host === "source.internal" ? '{"id":"1"}' : '{"id":"2"}',
          };
        return { stdout: "[]" };
      },
    };
    expect(() =>
      new PostgreSqlGenerationAdapter(commands).verifyEquivalence(
        sourceUrl,
        targetUrl,
      ),
    ).toThrow("postgres_generation_equivalence_failed");
  });
});
