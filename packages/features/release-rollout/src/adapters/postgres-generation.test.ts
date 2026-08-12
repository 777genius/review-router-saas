import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  decomposePostgresConnection,
  PostgreSqlGenerationAdapter,
} from "./postgres-generation";
import type { CommandExecutor } from "./process-command";

describe("PostgreSQL secret and connection boundary", () => {
  it("decomposes private URLs into nonsecret argv and a non-workspace 0600 passfile", () => {
    const connection = decomposePostgresConnection(
      "postgresql://runtime:s3cret@source.internal:5432/reviewrouter?sslmode=require",
    );
    const passfile = connection.env.PGPASSFILE!;
    expect(connection.args.join(" ")).not.toContain("s3cret");
    expect(JSON.stringify(connection.env)).not.toContain("s3cret");
    expect(passfile.startsWith("/tmp/rr-pgpass-")).toBe(true);
    expect(readFileSync(passfile, "utf8")).toContain("s3cret");
    connection.cleanup();
    expect(existsSync(passfile)).toBe(false);
  });
  it.each(["localhost", "db.example.com", "public.render.com"])(
    "rejects public hostname %s",
    (host) => {
      expect(() =>
        decomposePostgresConnection(`postgresql://u:p@${host}/db`),
      ).toThrow("postgres_generation_connection_invalid");
    },
  );
});

describe("source quiescence", () => {
  it("requires observed writer suspension, committed effective ACL denial, bounded zeros, and failed reconnect probes", () => {
    const execute = vi.fn((_command, args: readonly string[]) => {
      const sql = args.at(-1) ?? "";
      if (sql.includes("SELECT system_identifier::text"))
        return { stdout: "100\n" };
      if (sql.includes("json_build_object('role',current_user")) {
        const role = args[args.indexOf("--username") + 1];
        return {
          stdout: `${JSON.stringify({ role, systemIdentifier: "100" })}\n`,
        };
      }
      if (sql.includes("json_build_object('effectiveConnectDenied'"))
        return {
          stdout:
            '{"effectiveConnectDenied":true,"publicConnectDenied":true,"membershipSha256":"abc"}\n',
        };
      if (sql.startsWith("SELECT count(*) FROM pg_stat_activity"))
        return { stdout: "0\n" };
      return { stdout: "" };
    });
    const commands: CommandExecutor = {
      execute,
      hashStdout: vi.fn(),
      executeExpectingFailure: vi
        .fn()
        .mockReturnValue({ reason: "database_connect_permission_denied" }),
    };
    const adapter = new PostgreSqlGenerationAdapter(commands);
    const urls = Object.fromEntries(
      [
        "reviewrouter_api",
        "reviewrouter_web",
        "reviewrouter_worker",
        "reviewrouter_codex_effect_authority",
      ].map((role) => [
        role,
        `postgresql://${role}:secret@source.internal/reviewrouter`,
      ]),
    );
    const result = adapter.quiesceSource({
      adminUrl: "postgresql://admin:secret@source.internal/reviewrouter",
      writerSuspension: {
        services: [
          {
            serviceId: "srv-api",
            suspended: true,
            observedAt: "2026-08-12T00:00:00.000Z",
          },
        ],
        complete: true,
      },
      reconnectUrls: urls,
    });
    expect(result.evidence.stabilizationSeries).toEqual([0, 0, 0]);
    expect(result.evidence.reconnectDeniedRoles).toHaveLength(4);
    expect(
      execute.mock.calls
        .find((call) => String(call[1].at(-1)).includes("REVOKE CONNECT"))?.[1]
        .at(-1),
    ).toContain("COMMIT");
  });

  it("never synthesizes writer suspension and fails if any reconnect succeeds", () => {
    const adapter = new PostgreSqlGenerationAdapter({
      execute: vi.fn(),
      hashStdout: vi.fn(),
      executeExpectingFailure: vi.fn(),
    });
    expect(() =>
      adapter.quiesceSource({
        adminUrl: "postgresql://admin:s@source.internal/db",
        writerSuspension: { services: [], complete: true },
        reconnectUrls: {},
      }),
    ).toThrow("postgres_generation_writers_not_observably_suspended");
  });
});

describe("generation equivalence", () => {
  it("streams table rows and binds the complete catalog matrix", async () => {
    const execute = vi.fn((_command, args: readonly string[]) => {
      const sql = args.at(-1) ?? "";
      if (sql.includes("json_agg(n.nspname||'.'||c.relname"))
        return { stdout: '["public.items"]\n' };
      return { stdout: "[]\n" };
    });
    const hashStdout = vi
      .fn()
      .mockResolvedValue({ rows: 3, sha256: `sha256:${"a".repeat(64)}` });
    const adapter = new PostgreSqlGenerationAdapter({
      execute,
      hashStdout,
      executeExpectingFailure: vi.fn(),
    });
    const result = await adapter.verifyEquivalence(
      "postgresql://a:s@source.internal/db",
      "postgresql://a:s@target.internal/db",
      ["public"],
    );
    expect(result.evidence.streamingHash).toBe(true);
    expect(Object.keys(result.evidence.catalogSha256)).toHaveLength(7);
    expect(hashStdout).toHaveBeenCalledTimes(2);
    expect(String(hashStdout.mock.calls[0]?.[1].at(-1))).toContain(
      "COPY (SELECT",
    );
  });
});
