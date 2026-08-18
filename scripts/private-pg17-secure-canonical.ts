import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decomposePostgresConnection,
  RedactedProcessCommandAdapter,
} from "../packages/features/release-rollout/src/index";
import { sanitizedDiagnosticError } from "../packages/features/release-rollout/src/domain/sanitized-diagnostic.js";
import { normalizeSecretSafePostgresArguments } from "./lib/secret-safe-command-boundary.mjs";

const commands = new RedactedProcessCommandAdapter();
export function createSecureCanonicalRun(
  hostAddress: (hostname: string) => string | undefined = () => undefined,
  onFailure: (step: string, detail: string) => void = () => undefined,
) {
  return function run(
    step: string,
    command: string,
    args: readonly string[],
    options: { env?: NodeJS.ProcessEnv; input?: string } = {},
  ): string {
    try {
      if (command === "psql") {
        const urlIndex = args.findIndex(
          (arg) =>
            arg.startsWith("postgres://") || arg.startsWith("postgresql://"),
        );
        if (urlIndex < 0) throw new Error("private_pg17_psql_url_missing");
        const databaseUrl = new URL(args[urlIndex]!);
        const resolvedHostAddress = hostAddress(databaseUrl.hostname);
        const nestedDatabaseUrl = new URL(databaseUrl);
        if (resolvedHostAddress)
          nestedDatabaseUrl.hostname = resolvedHostAddress;
        const connection = decomposePostgresConnection(databaseUrl.toString());
        const directory = mkdtempSync(join(tmpdir(), "rr-db-credential-"));
        chmodSync(directory, 0o700);
        const credentialPath = join(directory, "database-url");
        writeFileSync(credentialPath, nestedDatabaseUrl.toString(), {
          mode: 0o600,
          flag: "wx",
        });
        const normalized = normalizeSecretSafePostgresArguments(
          args.filter((_, index) => index !== urlIndex),
          options.input,
        );
        try {
          return commands.execute(
            "psql",
            [...connection.args, ...normalized.args],
            {
              env: {
                ...connection.env,
                ...(resolvedHostAddress
                  ? { PGHOSTADDR: resolvedHostAddress }
                  : {}),
                REVIEW_ROUTER_DATABASE_URL_FILE: credentialPath,
              },
              input: normalized.input,
            },
          ).stdout;
        } finally {
          connection.cleanup();
          rmSync(directory, { recursive: true, force: true });
        }
      }
      if (command !== "node" && command !== "pnpm")
        throw new Error("private_pg17_command_forbidden");
      const allowed =
        (command === "node" &&
          JSON.stringify(args) ===
            JSON.stringify([
              "--import",
              "tsx",
              "scripts/preflight-codex-rotating-migration-history.ts",
            ])) ||
        (command === "pnpm" &&
          JSON.stringify(args) ===
            JSON.stringify([
              "--filter",
              "@reviewrouter/platform-db",
              "db:migrate:deploy",
            ]));
      if (!allowed)
        throw sanitizedDiagnosticError({
          code: "private_pg17_rehearsal_command_failed",
          phase: "process_boundary",
        });
      const databaseUrl = options.env?.DATABASE_URL;
      if (!databaseUrl)
        throw new Error("private_pg17_exact_database_environment_missing");
      const directory = mkdtempSync(join(tmpdir(), "rr-db-credential-"));
      chmodSync(directory, 0o700);
      const credentialPath = join(directory, "database-url");
      writeFileSync(credentialPath, databaseUrl, { mode: 0o600, flag: "wx" });
      try {
        const result = spawnSync(command, [...args], {
          cwd: process.cwd(),
          encoding: "utf8",
          input: options.input,
          env: {
            PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
            LANG: "C.UTF-8",
            REVIEW_ROUTER_DATABASE_URL_FILE: credentialPath,
          },
          maxBuffer: 8 * 1024 * 1024,
          timeout: 600_000,
        });
        if (result.status !== 0 || result.error)
          throw sanitizedDiagnosticError({
            code: "private_pg17_rehearsal_command_failed",
            phase: "rehearsal",
            exitCode: result.status,
            signal: result.signal,
            timedOut: result.error?.code === "ETIMEDOUT",
          });
        return result.stdout;
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    } catch (error) {
      onFailure(step, "private_pg17_rehearsal_command_failed");
      if (error instanceof Error && error.name === "SanitizedDiagnosticError")
        throw error;
      throw sanitizedDiagnosticError({
        code: "private_pg17_rehearsal_command_failed",
        phase: "rehearsal",
      });
    }
  };
}

export const secureCanonicalRun = createSecureCanonicalRun();
