import { spawn } from "node:child_process";

export type ConflictRuntimeCommandInput = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly stdin?: string | undefined;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes?: number | undefined;
};

export type ConflictRuntimeCommandOutput = {
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
};

export type ConflictRuntimeCommandRunner = (
  input: ConflictRuntimeCommandInput,
) => Promise<ConflictRuntimeCommandOutput>;

export const nodeCommandRunner: ConflictRuntimeCommandRunner = async (
  input,
) => {
  const maxStderrBytes = input.maxStderrBytes ?? 64 * 1024;
  return await new Promise((resolve, reject) => {
    const child = spawn(input.command, [...input.args], {
      cwd: input.cwd,
      env: normalizeCommandEnvironment(input.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = createBoundedBuffer(input.maxStdoutBytes);
    const stderr = createBoundedBuffer(maxStderrBytes);
    let timedOut = false;
    let forceKillTimeout: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimeout = setTimeout(() => {
        child.kill("SIGKILL");
      }, 5_000);
      forceKillTimeout.unref?.();
    }, input.timeoutMs);
    timeout.unref?.();

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    if (input.stdin !== undefined) {
      child.stdin.end(input.stdin);
    } else {
      child.stdin.end();
    }
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
      if (timedOut) {
        reject(new Error(`conflict_runtime_command_timeout:${input.command}`));
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `conflict_runtime_command_failed:${input.command}:${code ?? signal ?? "unknown"}`,
          ),
        );
        return;
      }
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      });
    });
  });
};

function normalizeCommandEnvironment(
  env: Readonly<Record<string, string | undefined>> | undefined,
): NodeJS.ProcessEnv {
  const normalized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env ?? process.env)) {
    if (typeof value === "string") {
      normalized[key] = value;
    }
  }
  return normalized;
}

function createBoundedBuffer(maxBytes: number): {
  readonly truncated: boolean;
  push(chunk: Buffer): void;
  toString(): string;
} {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  return {
    get truncated() {
      return truncated;
    },
    push(chunk: Buffer): void {
      const remaining = maxBytes - bytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      if (chunk.byteLength > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        bytes += remaining;
        truncated = true;
        return;
      }
      chunks.push(chunk);
      bytes += chunk.byteLength;
    },
    toString(): string {
      return Buffer.concat(chunks).toString("utf8");
    },
  };
}
