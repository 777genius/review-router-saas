import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decomposePostgresConnection,
  RedactedProcessCommandAdapter,
} from "../packages/features/release-rollout/src/index";

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
        const connection = decomposePostgresConnection(args[urlIndex]!);
        try {
          return commands.execute(
            "psql",
            [
              ...connection.args,
              ...args.filter((_, index) => index !== urlIndex),
            ],
            {
              env: {
                ...connection.env,
                ...(hostAddress(new URL(args[urlIndex]!).hostname)
                  ? {
                      PGHOSTADDR: hostAddress(
                        new URL(args[urlIndex]!).hostname,
                      ),
                    }
                  : {}),
              },
              input: options.input,
            },
          ).stdout;
        } finally {
          connection.cleanup();
        }
      }
      if (command !== "node" && command !== "pnpm")
        throw new Error("private_pg17_command_forbidden");
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
        });
        if (result.status !== 0) throw new Error("private_pg17_child_failed");
        return result.stdout;
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    } catch (error) {
      onFailure(step, error instanceof Error ? error.message : "unknown");
      throw new Error(`private_pg17_secure_step_failed:${step}`, {
        cause: error,
      });
    }
  };
}

export const secureCanonicalRun = createSecureCanonicalRun();
