import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDatabaseCredentialBoundary,
  createSecretSafePostgresInvocation,
  runSecretSafePostgresCommand,
} from "./secret-safe-command-boundary.mjs";

describe("secret-safe script command boundary", () => {
  it("returns only structured evidence for an expected PostgreSQL failure", () => {
    const directory = mkdtempSync(join(tmpdir(), "rr-command-test-"));
    try {
      const binary = join(directory, "fake-psql");
      writeFileSync(
        binary,
        "#!/bin/sh\nprintf '%s' 'raw-stderr-canary: expected topology rejection' >&2\nexit 29\n",
        { mode: 0o700 },
      );
      chmodSync(binary, 0o700);

      const result = runSecretSafePostgresCommand({
        databaseUrl: "postgresql://owner:password-canary@db.invalid/app",
        binary,
        args: ["--no-psqlrc"],
        expectFailureContaining: "expected topology rejection",
      });

      expect(result).toEqual({ expectedFailure: true });
      expect(JSON.stringify(result)).not.toMatch(
        /raw-stderr-canary|password-canary/u,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps DSN, argv SQL, environment, stdout, and stderr canaries out of failures", () => {
    const directory = mkdtempSync(join(tmpdir(), "rr-command-test-"));
    try {
      const binary = join(directory, "fake-psql");
      writeFileSync(
        binary,
        "#!/bin/sh\nprintf '%s' 'stdout-command-canary'\nprintf '%s' 'stderr-command-canary' >&2\nexit 29\n",
        { mode: 0o700 },
      );
      chmodSync(binary, 0o700);
      let caught: unknown;
      try {
        runSecretSafePostgresCommand({
          databaseUrl:
            "postgresql://owner:dsn-command-canary@db.invalid/app?sslmode=require",
          binary,
          args: ["-Atc", "SELECT 'argv-sql-command-canary'"],
          environment: {
            PATH: "/usr/local/bin:/usr/bin:/bin",
            SECRET_ENV: "env-command-canary",
          },
        });
      } catch (error) {
        caught = error;
      }
      const serialized = `${String(caught)}${JSON.stringify(caught)}`;
      expect(serialized.length).toBeLessThan(1_536);
      expect(serialized).toContain('"code":"release_migration_step_failed"');
      expect(serialized).not.toMatch(
        /dsn-command-canary|stdout-command-canary|stderr-command-canary|argv-sql-command-canary|env-command-canary/u,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("exposes only a credential-file path to database-aware children", () => {
    const boundary = createDatabaseCredentialBoundary(
      "postgresql://owner:credential-file-canary@db.invalid/app",
      {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        DATABASE_URL: "ambient-database-canary",
        GITHUB_TOKEN: "ambient-token-canary",
      },
    );
    try {
      const serialized = JSON.stringify(boundary.environment);
      expect(serialized).toContain("REVIEW_ROUTER_DATABASE_URL_FILE");
      expect(serialized).not.toMatch(
        /credential-file-canary|ambient-database-canary|ambient-token-canary/u,
      );
      expect(boundary.environment).not.toHaveProperty("DATABASE_URL");
      expect(boundary.environment).not.toHaveProperty("GITHUB_TOKEN");
    } finally {
      boundary.cleanup();
    }
  });

  it("moves SQL out of argv and keeps the password out of argv and env", () => {
    const invocation = createSecretSafePostgresInvocation({
      databaseUrl:
        "postgresql://owner:invocation-password-canary@db.invalid/app?sslmode=require",
      args: ["-X", "-Atc", "SELECT 'sql-input-canary'"],
    });
    try {
      const boundary = JSON.stringify({
        args: invocation.args,
        environment: invocation.environment,
      });
      expect(boundary).not.toMatch(
        /invocation-password-canary|sql-input-canary|postgresql:\/\//u,
      );
      expect(invocation.input).toBe("SELECT 'sql-input-canary'");
      expect(invocation.args).toContain("-At");
    } finally {
      invocation.cleanup();
    }
  });
});
