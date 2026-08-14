import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { sanitizedDiagnosticError } from "../domain/sanitized-diagnostic.js";

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
  readonly timeoutMs?: number;
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
  executeExpectingFailure(
    command: PgCommand,
    args: readonly string[],
    options?: CommandOptions,
  ): { reason: "database_connect_permission_denied" };
}

const allowedEnvironment = new Set([
  "PATH",
  "LANG",
  "LC_ALL",
  "TZ",
  "PGPASSFILE",
  "PGSSLMODE",
  "PGCONNECT_TIMEOUT",
  "PGHOSTADDR",
]);
const secretPattern =
  /postgres(?:ql)?:\/\/|BEGIN [A-Z ]*PRIVATE KEY|(?:password|token|private[_-]?key)=/iu;
const environmentValuePatterns: Readonly<Record<string, RegExp>> = {
  PATH: /^(?:\/[A-Za-z0-9._+\-/]+)(?::\/[A-Za-z0-9._+\-/]+)*$/u,
  LANG: /^[A-Za-z]{1,16}(?:_[A-Za-z]{1,16})?(?:\.[A-Za-z0-9-]{1,16})?$/u,
  LC_ALL: /^[A-Za-z]{1,16}(?:_[A-Za-z]{1,16})?(?:\.[A-Za-z0-9-]{1,16})?$/u,
  TZ: /^(?:UTC|Etc\/[A-Za-z0-9_+\-/]{1,64})$/u,
  PGPASSFILE: /^\/[A-Za-z0-9._+\-/]{1,1023}$/u,
  PGSSLMODE: /^(?:disable|allow|prefer|require|verify-ca|verify-full)$/u,
  PGCONNECT_TIMEOUT: /^(?:[1-9]|[1-9][0-9]|1[0-1][0-9]|120)$/u,
  PGHOSTADDR: /^(?:[0-9.]{7,15}|[A-Fa-f0-9:]{2,45})$/u,
};

function boundedTimeout(value: number | undefined): number {
  return Number.isSafeInteger(value) && value !== undefined && value > 0
    ? Math.min(value, 600_000)
    : 600_000;
}

export function assertSafeProcessBoundary(
  command: PgCommand,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): void {
  if (args.some((arg) => secretPattern.test(arg) || arg.includes("PGPASSWORD")))
    throw sanitizedDiagnosticError({
      code: "release_rollout_process_boundary_rejected",
      phase: "process_boundary",
    });
  for (const [name, value] of Object.entries(env)) {
    if (!allowedEnvironment.has(name))
      throw sanitizedDiagnosticError({
        code: "release_rollout_process_boundary_rejected",
        phase: "process_boundary",
      });
    if (
      value &&
      (secretPattern.test(value) ||
        !environmentValuePatterns[name]!.test(value))
    )
      throw sanitizedDiagnosticError({
        code: "release_rollout_process_boundary_rejected",
        phase: "process_boundary",
      });
  }
  if (env.PGPASSWORD || !command)
    throw sanitizedDiagnosticError({
      code: "release_rollout_process_boundary_rejected",
      phase: "process_boundary",
    });
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
      timeout: boundedTimeout(options.timeoutMs),
    });
    if (result.status !== 0 || result.error)
      throw sanitizedDiagnosticError({
        code: "release_rollout_process_failed",
        phase: "process_execute",
        exitCode: result.status,
        signal: result.signal,
        timedOut:
          (result.error as NodeJS.ErrnoException | undefined)?.code ===
          "ETIMEDOUT",
      });
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
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, boundedTimeout(options.timeoutMs));
      child.stdout!.on("data", (chunk: Buffer) => {
        sawBytes = true;
        for (const byte of chunk) if (byte === 10) rows += 1;
        lastByte = chunk.at(-1) ?? lastByte;
        hash.update(chunk);
      });
      child.once("error", () => {
        clearTimeout(timeout);
        reject(
          sanitizedDiagnosticError({
            code: "release_rollout_process_failed",
            phase: "process_hash",
          }),
        );
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timeout);
        if (code !== 0)
          reject(
            sanitizedDiagnosticError({
              code: "release_rollout_process_failed",
              phase: "process_hash",
              exitCode: code,
              signal,
              timedOut,
            }),
          );
        else
          resolve({
            rows: sawBytes ? rows + (lastByte === 10 ? 0 : 1) : 0,
            sha256: `sha256:${hash.digest("hex")}`,
          });
      });
      if (options.input !== undefined) child.stdin!.end(options.input);
    });
  }

  executeExpectingFailure(
    command: PgCommand,
    args: readonly string[],
    options: CommandOptions = {},
  ): { reason: "database_connect_permission_denied" } {
    const env = options.env ?? {};
    assertSafeProcessBoundary(command, args, env);
    const result = spawnSync(command, [...args], {
      encoding: "utf8",
      env,
      input: options.input,
      maxBuffer: 256 * 1024,
      timeout: boundedTimeout(options.timeoutMs),
    });
    const diagnostic = String(result.stderr ?? "");
    if (
      result.status === 0 ||
      !/(?:permission denied for database|permission denied to connect to database)/iu.test(
        diagnostic,
      ) ||
      /(?:could not translate host name|name or service not known|password authentication failed|no pg_hba.conf entry|connection timed out|connection refused)/iu.test(
        diagnostic,
      )
    )
      throw sanitizedDiagnosticError({
        code: "release_rollout_process_failed",
        phase: "process_denial_probe",
        exitCode: result.status,
        signal: result.signal,
        timedOut:
          (result.error as NodeJS.ErrnoException | undefined)?.code ===
          "ETIMEDOUT",
      });
    return { reason: "database_connect_permission_denied" };
  }
}
