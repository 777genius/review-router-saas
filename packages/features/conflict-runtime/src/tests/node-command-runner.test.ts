import { describe, expect, it } from "vitest";
import { nodeCommandRunner } from "../infrastructure/node-command-runner.js";

describe("nodeCommandRunner", () => {
  it("fails closed on command timeout and bounds captured output", async () => {
    await expect(
      nodeCommandRunner({
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 10_000);"],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH },
        timeoutMs: 20,
        maxStdoutBytes: 1024,
        maxStderrBytes: 1024,
      }),
    ).rejects.toThrow("conflict_runtime_command_timeout");
  });

  it("does not inherit ambient env when explicit env is passed", async () => {
    const output = await nodeCommandRunner({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write(String(process.env.GITHUB_TOKEN || 'absent'))",
      ],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      timeoutMs: 1_000,
      maxStdoutBytes: 8,
      maxStderrBytes: 8,
    });

    expect(output).toEqual({
      stdout: "absent",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    });
  });
});
