import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

export type PgCommand =
  | "psql"
  | "pg_dump"
  | "pg_restore"
  | "pg_isready"
  | "node";
export interface CommandResult {
  readonly stdout: string;
}
export interface CommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
  readonly maxBuffer?: number;
}
export interface CommandExecutor {
  execute(
    command: PgCommand,
    args: readonly string[],
    options?: CommandOptions,
  ): CommandResult;
  hashStdout(
    command: PgCommand,
    args: readonly string[],
    options?: Omit<CommandOptions, "maxBuffer">,
  ): Promise<{ rows: number; sha256: string }>;
}

const allowedEnvironment = new Set([
  "PATH",
  "LANG",
  "LC_ALL",
  "TZ",
  "PGPASSFILE",
  "PGSSLMODE",
  "PGCONNECT_TIMEOUT",
]);
const secretPattern =
  /postgres(?:ql)?:\/\/|BEGIN [A-Z ]*PRIVATE KEY|(?:password|token|private[_-]?key)=/iu;

export function assertSafeProcessBoundary(
  command: PgCommand,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): void {
  if (args.some((arg) => secretPattern.test(arg) || arg.includes("PGPASSWORD")))
    throw new Error("release_rollout_secret_in_argv");
  for (const [name, value] of Object.entries(env)) {
    if (!allowedEnvironment.has(name))
      throw new Error(`release_rollout_broad_child_environment:${name}`);
    if (name !== "PGPASSFILE" && value && secretPattern.test(value))
      throw new Error("release_rollout_secret_in_child_environment");
  }
  if (env.PGPASSWORD) throw new Error("release_rollout_pgpassword_forbidden");
  if (!command) throw new Error("release_rollout_command_invalid");
}

export class RedactedProcessCommandAdapter implements CommandExecutor {
  execute(
    command: PgCommand,
    args: readonly string[],
    options: CommandOptions = {},
  ): CommandResult {
    const env = options.env ?? {};
    assertSafeProcessBoundary(command, args, env);
    const result = spawnSync(command, [...args], {
      encoding: "utf8",
      env,
      input: options.input,
      maxBuffer: Math.min(
        options.maxBuffer ?? 8 * 1024 * 1024,
        8 * 1024 * 1024,
      ),
    });
    if (result.status !== 0)
      throw new Error(`release_rollout_process_failed:${command}`);
    return { stdout: result.stdout };
  }

  async hashStdout(
    command: PgCommand,
    args: readonly string[],
    options: Omit<CommandOptions, "maxBuffer"> = {},
  ): Promise<{ rows: number; sha256: string }> {
    const env = options.env ?? {};
    assertSafeProcessBoundary(command, args, env);
    return await new Promise((resolve, reject) => {
      const hash = createHash("sha256");
      let rows = 0;
      let sawBytes = false;
      let lastByte = 10;
      const child = spawn(command, [...args], {
        env,
        stdio: [
          options.input === undefined ? "ignore" : "pipe",
          "pipe",
          "ignore",
        ],
      });
      child.stdout!.on("data", (chunk: Buffer) => {
        sawBytes = true;
        for (const byte of chunk) if (byte === 10) rows += 1;
        lastByte = chunk.at(-1) ?? lastByte;
        hash.update(chunk);
      });
      child.once("error", () =>
        reject(new Error(`release_rollout_process_failed:${command}`)),
      );
      child.once("exit", (code) => {
        if (code !== 0)
          reject(new Error(`release_rollout_process_failed:${command}`));
        else
          resolve({
            rows: sawBytes ? rows + (lastByte === 10 ? 0 : 1) : 0,
            sha256: `sha256:${hash.digest("hex")}`,
          });
      });
      if (options.input !== undefined) child.stdin!.end(options.input);
    });
  }
}
