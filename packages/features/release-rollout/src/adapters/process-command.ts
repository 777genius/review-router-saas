import { spawnSync } from "node:child_process";

export interface CommandResult {
  readonly stdout: string;
}

export interface CommandExecutor {
  execute(
    command: "psql" | "pg_dump" | "pg_restore" | "node",
    args: readonly string[],
    options?: {
      env?: NodeJS.ProcessEnv;
      input?: string;
      maxBuffer?: number;
    },
  ): CommandResult;
}

export class RedactedProcessCommandAdapter implements CommandExecutor {
  execute(
    command: "psql" | "pg_dump" | "pg_restore" | "node",
    args: readonly string[],
    options: {
      env?: NodeJS.ProcessEnv;
      input?: string;
      maxBuffer?: number;
    } = {},
  ): CommandResult {
    const result = spawnSync(command, [...args], {
      encoding: "utf8",
      env: options.env,
      input: options.input,
      maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    });
    if (result.status !== 0)
      throw new Error(`release_rollout_process_failed:${command}`);
    return { stdout: result.stdout };
  }
}
