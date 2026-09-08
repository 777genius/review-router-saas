import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { managedPg17Fixture } from "./render-managed-pg17-fixture";
import { assertSafeProcessBoundary } from "../../packages/features/release-rollout/src/adapters/process-command";
import { decomposePostgresConnection, PostgreSqlGenerationAdapter } from "../../packages/features/release-rollout/src/adapters/postgres-generation";

vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawnSync: vi.fn(),
}));
const spawnMock = vi.mocked(spawnSync);
const secret = "postgresql://user:password@private/db token=never-print";
const args = ["--host", "dpg-source", "--port", "5432", "--username", "postgres", "--dbname", "fixture", "--command", "SELECT 1"];
const inventory = { version: 1, database: "fixture", sessionPrincipal: "postgres", roles: [], memberships: [], grants: [] };
const success = (stdout: string) => ({ pid: 1, status: 0, signal: null, output: [], stdout, stderr: secret });

beforeEach(() => {
  vi.stubEnv("PATH", "/usr/local/bin:/usr/bin:/bin");
  spawnMock.mockReset();
  spawnMock.mockImplementation((_binary, argv) => {
    if (argv?.[2] === "inspect") {
      const name = argv.at(-1)!;
      return success(`${name.replace("rr-retained-", "")}|none`);
    }
    return success(JSON.stringify(inventory));
  });
});
afterEach(() => vi.unstubAllEnvs());

function execute() {
  return managedPg17Fixture().recoveryCommands("dpg-source").execute("psql", args);
}

describe("recovery fixture bounded diagnostics", () => {
  it("runs the real inventory adapter with ambient CI secrets excluded", () => {
    vi.stubEnv("CI", "true");
    vi.stubEnv("PGPASSWORD", secret);
    vi.stubEnv("DATABASE_URL", secret);
    const fixture = managedPg17Fixture();
    expect(new PostgreSqlGenerationAdapter(fixture.recoveryCommands("dpg-source"))
      .inventoryEffectivePrincipals("postgresql://postgres:disposable@dpg-source/fixture")).toMatchObject(inventory);
    const [binary, argv, options] = spawnMock.mock.calls[1]!;
    expect(binary).toBe("docker");
    expect(argv).toEqual(["--host", "unix:///var/run/docker.sock", "exec", "--env", "PGSSLMODE=disable", "--env", "PGGSSENCMODE=disable", "-i", expect.stringMatching(/^rr-retained-/), "psql", "-h", "127.0.0.1", "-p", "5432", "-U", "postgres", "-d", "fixture", "-XqAt", "-v", "ON_ERROR_STOP=1"]);
    expect(options).toMatchObject({ env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" }, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    expect(Object.keys(options!.env!).sort()).toEqual(["LANG", "PATH"]);
  });

  it("identifies only PATH in CI-like decomposition and isolates the test before adapter calls", () => {
    vi.stubEnv("PATH", "/work/node_modules/.pnpm/vitest@3.2.0/node_modules/.bin:/usr/bin");
    vi.stubEnv("LANG", "unsafe fixture locale");
    const fixture = managedPg17Fixture();
    const adapter = new PostgreSqlGenerationAdapter(fixture.recoveryCommands("dpg-source"));
    const url = "postgresql://postgres:disposable@dpg-source/fixture";
    const connection = decomposePostgresConnection(url);
    try {
      // Field-name-only diagnosis; no values, SQL or credentials in failures.
      const rejected = Object.entries(connection.env).flatMap(([name, value]) => {
        try { assertSafeProcessBoundary("psql", [], { [name]: value }); return []; }
        catch { return [name]; }
      });
      expect(rejected).toEqual(["PATH"]);
      expect(() => assertSafeProcessBoundary("psql", connection.args)).not.toThrow();
    } finally { connection.cleanup(); }
    expect(() => adapter.inventoryEffectivePrincipals(url))
      .toThrow("fixture_recovery_execute_failed:boundary:rejected");
    expect(spawnMock).not.toHaveBeenCalled();
    // Same already-imported adapter and already-created fixture: decomposition
    // reads current PATH, not an import-time snapshot. Docker is independently fixed.
    vi.stubEnv("PATH", "/usr/local/bin:/usr/bin:/bin");
    expect(adapter.inventoryEffectivePrincipals(url)).toMatchObject(inventory);
    for (const call of spawnMock.mock.calls)
      expect(call[2]?.env).toEqual({ PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" });
    expect(spawnMock.mock.calls[1]![2]).toMatchObject({
      input: expect.any(String), timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
    });
  });

  it("retains rejection of inherited PATH outside the safe grammar", () => {
    vi.stubEnv("PATH", "/tmp/unsafe path:/usr/bin");
    expect(() => new PostgreSqlGenerationAdapter(managedPg17Fixture().recoveryCommands("dpg-source"))
      .inventoryEffectivePrincipals("postgresql://postgres:disposable@dpg-source/fixture"))
      .toThrow("fixture_recovery_execute_failed:boundary:rejected");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects explicit credentials and SQL secrets before Docker", async () => {
    for (const run of [
      () => managedPg17Fixture().recoveryCommands("dpg-source").execute("psql", args, { env: { PGPASSWORD: secret } }),
      () => managedPg17Fixture().recoveryCommands("dpg-source").execute("psql", [...args.slice(0, -1), secret]),
    ]) expect(run).toThrow("fixture_recovery_execute_failed:boundary:rejected");
    const commands = managedPg17Fixture().recoveryCommands("dpg-source");
    for (const env of [{ PATH: "/tmp/fixture@unsafe/bin" }, { LANG: "C;fixture" }, { PGPASSWORD: "fixture-only" }]) {
      expect(() => commands.execute("psql", args, { env }))
        .toThrow("fixture_recovery_execute_failed:boundary:rejected");
      await expect(commands.hashStdout("psql", args, { env })).rejects.toThrow();
    }
    await expect(commands.hashStdout("psql", [...args.slice(0, -1), secret])).rejects.toThrow();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each([
    ["ETIMEDOUT", "timeout"], ["ENOBUFS", "output_limit"],
    ["ENOENT", "binary_missing"], ["EACCES", "permission_denied"],
    ["EPERM", "permission_denied"], [secret, "spawn_failed"],
  ])("classifies bounded query failures without exposing child data", (code, category) => {
    spawnMock.mockImplementationOnce((_binary, argv) => success(`${argv!.at(-1)!.replace("rr-retained-", "")}|none`));
    spawnMock.mockImplementationOnce(() => ({ ...success(secret), status: null, error: Object.assign(new Error(secret), { code }) }));
    try { execute(); expect.fail("expected failure"); } catch (error) {
      expect((error as Error).message).toBe(`fixture_recovery_execute_failed:query:${category}`);
      expect((error as Error).cause).toBeUndefined();
      expect((error as Error).stack).not.toContain(secret);
    }
  });

  it.each([[null, "SIGKILL", "signalled"], [1, null, "nonzero_exit"]] as const)("classifies process termination %s %s", (status, signal, category) => {
    spawnMock.mockImplementationOnce(() => ({ ...success(secret), status, signal }));
    expect(execute).toThrow(`fixture_recovery_execute_failed:identity:${category}`);
  });

  it.each(["wrong|none", "wrong|bridge"])("rejects unowned or networked identity %s", (facts) => {
    spawnMock.mockReturnValueOnce(success(facts));
    expect(execute).toThrow("fixture_recovery_execute_failed:identity:rejected");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("isolates seven fixture identities", () => {
    for (let i = 0; i < 7; i++) execute();
    const names = spawnMock.mock.calls.filter((call) => call[1]?.[2] === "inspect").map((call) => call[1]!.at(-1));
    expect(new Set(names).size).toBe(7);
  });

  it("distinguishes connection and command validation", () => {
    const commands = managedPg17Fixture().recoveryCommands("dpg-source");
    expect(() => commands.execute("psql", [...args.slice(0, 1), "dpg-target", ...args.slice(2)])).toThrow("fixture_recovery_execute_failed:connection:rejected");
    expect(() => commands.execute("psql", args.slice(0, -2))).toThrow("fixture_recovery_execute_failed:command_form:rejected");
  });
});
