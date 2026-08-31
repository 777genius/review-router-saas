import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import {
  assertPsqlFailedWithExactMessage,
  assertPsqlFailedWithOneOfExactMessages,
} from "./codex-rotating-rehearsal-process-result.mjs";
import {
  findMigration89AdvisoryLock,
  findMigration89RelationLock,
  migration89LockBlockedBy,
  spawnMigration89Process,
  waitForMigration89LockState,
} from "./codex-rotating-migration89-process.mjs";
import { normalizeSecretSafePostgresArguments } from "./lib/secret-safe-command-boundary.mjs";

const readStdinProgram = String.raw`
  process.stdin.setEncoding("utf8");
  let input = "";
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => process.stdout.write(input));
`;
const childEnvironment = { PATH: "/usr/local/bin:/usr/bin:/bin" };
const descendantProcessCanary = "migration89-stubborn-descendant-canary";
const stubbornDescendantProgram = String.raw`
  const descendantProcessCanary = ${JSON.stringify(descendantProcessCanary)};
  const { readFileSync } = require("node:fs");
  const status = readFileSync("/proc/self/status", "utf8");
  const namespacePids = /^NSpid:\s+([0-9\t ]+)/mu
    .exec(status)?.[1]
    .trim()
    .split(/\s+/u)
    .map(Number);
  const parentVisiblePid =
    namespacePids?.length === 1 ? process.pid : namespacePids?.at(-2);
  if (!Number.isSafeInteger(parentVisiblePid) || parentVisiblePid <= 1)
    process.exit(90);
  if (descendantProcessCanary.length === 0) process.exit(91);
  const visibleCommandLine = readFileSync(
    "/proc/" + parentVisiblePid + "/cmdline",
    "utf8",
  );
  if (!visibleCommandLine.includes(descendantProcessCanary)) process.exit(92);
  process.on("SIGTERM", () => {});
  process.send?.(parentVisiblePid + ":" + descendantProcessCanary);
  setInterval(() => {}, 1_000);
`;
const descendantHolderProgram = String.raw`
  const { spawn } = require("node:child_process");
  process.on("SIGTERM", () => {});
  const descendant = spawn(
    process.execPath,
    ["-e", ${JSON.stringify(stubbornDescendantProgram)}],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  descendant.once("message", (outerPid) =>
    process.stdout.write(String(outerPid) + "\n"),
  );
  setInterval(() => {}, 1_000);
`;
const descendantTimeoutProgram = String.raw`
  const { spawn } = require("node:child_process");
  process.on("SIGTERM", () => {});
  const descendant = spawn(
    process.execPath,
    ["-e", ${JSON.stringify(stubbornDescendantProgram)}],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  descendant.once("message", (outerPid) =>
    process.stdout.write(String(outerPid) + "\n"),
  );
  setInterval(() => {}, 1_000);
`;
const descendantThenExitProgram = String.raw`
  const { spawn } = require("node:child_process");
  const descendant = spawn(
    process.execPath,
    ["-e", ${JSON.stringify(stubbornDescendantProgram)}],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  descendant.once("message", (outerPid) => {
    process.stdout.write(
      String(outerPid) + "\n",
      () => process.exit(0),
    );
  });
`;
const detachedDescendantThenExitProgram = String.raw`
  const { spawn } = require("node:child_process");
  const descendant = spawn(
    process.execPath,
    ["-e", ${JSON.stringify(stubbornDescendantProgram)}],
    { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  descendant.once("message", (outerPid) => {
    process.stdout.write(String(outerPid) + "\n", () => {
      descendant.disconnect();
      descendant.unref();
      process.exit(0);
    });
  });
`;

type Migration89ProcessHandle = ReturnType<typeof spawnMigration89Process>;
type Migration89ProcessResult = Awaited<Migration89ProcessHandle["result"]>;

function liveProcess(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function descendantPid(
  handle: Migration89ProcessHandle,
): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const match = new RegExp(
      `^(\\d+):${descendantProcessCanary}\\n$`,
      "u",
    ).exec(String(handle.stdout()));
    if (match) return Number(match[1]);
    if (handle.unavailableResult() !== undefined)
      throw new Error("migration89_descendant_exited_before_ready");
    await delay(10);
  }
  throw new Error("migration89_descendant_ready_timeout");
}

async function resultWithin(
  handle: Migration89ProcessHandle,
  timeoutMs = 5_000,
): Promise<Migration89ProcessResult> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      handle.result,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("migration89_process_result_timeout")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function expectProcessGone(pid: number): void {
  expect(liveProcess(pid)).toBe(false);
}

function emergencyProcessCleanup(
  handle: Migration89ProcessHandle | undefined,
  pid: number | undefined,
): void {
  const descendantWasLive = pid !== undefined && liveProcess(pid);
  if (pid !== undefined && descendantWasLive) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The regression assertion below determines whether cleanup succeeded.
    }
  }
  const leaderPid = handle?.child.pid;
  if (
    handle &&
    (handle.closedResult() === undefined || descendantWasLive) &&
    typeof leaderPid === "number" &&
    Number.isSafeInteger(leaderPid) &&
    leaderPid > 1
  ) {
    try {
      if (process.platform === "win32") {
        if (handle.child.exitCode === null && handle.child.signalCode === null)
          handle.child.kill("SIGKILL");
      } else process.kill(-leaderPid, "SIGKILL");
    } catch {
      // The regression assertion below determines whether cleanup succeeded.
    }
  }
}

it("pipes normalized -c SQL exactly once and closes noninteractive stdin", async () => {
  const sql = "SELECT 'migration89-async-input-canary'";
  const normalized = normalizeSecretSafePostgresArguments(
    ["-X", "-Atc", sql],
    undefined,
  );
  const cleanup = vi.fn();

  expect(normalized.args).toEqual(["-X", "-At"]);
  const handle = spawnMigration89Process({
    binary: process.execPath,
    args: ["-e", readStdinProgram],
    environment: childEnvironment,
    input: normalized.input,
    cleanup,
    timeoutMs: 2_000,
  });
  const result = await handle.result;

  expect(result).toMatchObject({ status: 0, signal: null, timedOut: false });
  expect(result.stdout).toBe(sql);
  expect(result.stderr).toBe("");
  expect(cleanup).toHaveBeenCalledOnce();
});

it("keeps interactive blocker stdin writable until explicitly closed", async () => {
  const cleanup = vi.fn();
  const handle = spawnMigration89Process({
    binary: process.execPath,
    args: ["-e", readStdinProgram],
    environment: childEnvironment,
    input: undefined,
    keepStdinOpen: true,
    cleanup,
    timeoutMs: 2_000,
  });

  expect(handle.write("SELECT first;\n")).toBe(true);
  expect(handle.write("SELECT second;\n")).toBe(true);
  handle.end();
  const result = await handle.result;

  expect(result).toMatchObject({ status: 0, signal: null, timedOut: false });
  expect(result.stdout).toBe("SELECT first;\nSELECT second;\n");
  expect(cleanup).toHaveBeenCalledOnce();
});

it("writes the final SQL passed to end exactly once before closing stdin", async () => {
  const cleanup = vi.fn();
  const handle = spawnMigration89Process({
    binary: process.execPath,
    args: ["-e", readStdinProgram],
    environment: childEnvironment,
    input: undefined,
    keepStdinOpen: true,
    cleanup,
    timeoutMs: 2_000,
  });

  expect(handle.write("SELECT first;\n")).toBe(true);
  expect(handle.end("SELECT final;\n")).toBe(true);
  const result = await handle.result;

  expect(result).toMatchObject({ status: 0, signal: null, timedOut: false });
  expect(result.stdout).toBe("SELECT first;\nSELECT final;\n");
  expect(result.stderr).toBe("");
  expect(cleanup).toHaveBeenCalledOnce();
});

it("surfaces a sanitized clean child exit while polling for a lock", async () => {
  const lockSnapshot = vi.fn(() => []);
  const handle = spawnMigration89Process({
    binary: process.execPath,
    args: [
      "-e",
      "process.stdout.write('stdout-secret-canary'); process.stderr.write('stderr-secret-canary')",
    ],
    environment: childEnvironment,
    input: undefined,
    cleanup: vi.fn(),
    timeoutMs: 2_000,
  });

  let failure;
  try {
    await waitForMigration89LockState({
      description: "old invocation crossed update",
      lockSnapshot,
      predicate: () => false,
      watchedProcesses: [{ name: "old_invocation", handle }],
      timeoutMs: 1_000,
      pollIntervalMs: 5,
    });
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(
    "migration89_child_exited_before_lock_state:old invocation crossed update:old_invocation:",
  );
  expect((failure as Error).message).toContain(
    '"code":"private_pg17_rehearsal_command_failed"',
  );
  expect((failure as Error).message).toContain(
    '"exit":{"code":0,"signal":null}',
  );
  expect((failure as Error).message).not.toMatch(
    /stdout-secret-canary|stderr-secret-canary/u,
  );
  expect(lockSnapshot).toHaveBeenCalled();
  await handle.result;
});

it("rejects exit before close instead of accepting an inherited-stdio stale snapshot", async () => {
  const cleanup = vi.fn();
  const inheritedStdioProgram = String.raw`
    const { spawn } = require("node:child_process");
    const descendant = spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => {}); setTimeout(() => {}, 500)",
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    descendant.unref();
  `;
  const handle = spawnMigration89Process({
    binary: process.execPath,
    args: ["-e", inheritedStdioProgram],
    environment: childEnvironment,
    input: undefined,
    cleanup,
    timeoutMs: 2_000,
    terminationGraceMs: 100,
    closeDrainGraceMs: 1_000,
  });
  await handle.unavailable;
  const lockSnapshot = vi.fn(() => [{ stale: true }]);

  await expect(
    waitForMigration89LockState({
      description: "stale boundary",
      lockSnapshot,
      predicate: () => true,
      watchedProcesses: [{ name: "old_invocation", handle }],
      timeoutMs: 1_000,
    }),
  ).rejects.toThrow(
    /migration89_child_exited_before_lock_state:stale boundary:old_invocation/u,
  );
  expect(lockSnapshot).not.toHaveBeenCalled();
  const result = await handle.result;
  expect(result).toMatchObject({ status: 0, signal: null, timedOut: false });
  expect(cleanup).toHaveBeenCalledOnce();
});

it.skipIf(process.platform !== "linux")(
  "terminates a stubborn descendant before settling after a normal leader exit",
  async () => {
    let handle: Migration89ProcessHandle | undefined;
    let pid: number | undefined;
    const cleanup = vi.fn(() => {
      if (pid === undefined || liveProcess(pid))
        throw new Error("migration89_cleanup_ran_while_descendant_live");
    });
    try {
      handle = spawnMigration89Process({
        binary: process.execPath,
        args: ["-e", descendantThenExitProgram],
        environment: childEnvironment,
        input: undefined,
        cleanup,
        timeoutMs: 2_000,
        terminationGraceMs: 50,
        closeDrainGraceMs: 25,
      });
      pid = await descendantPid(handle);

      const result = await resultWithin(handle);
      expect(result).toMatchObject({
        status: 0,
        signal: null,
        timedOut: false,
      });
      expect(result.error).toBeUndefined();
      expectProcessGone(pid);
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      emergencyProcessCleanup(handle, pid);
    }
  },
  10_000,
);

it.skipIf(process.platform !== "linux")(
  "contains a detached new-session descendant until it is dead before settlement",
  async () => {
    let handle: Migration89ProcessHandle | undefined;
    let pid: number | undefined;
    const cleanup = vi.fn(() => {
      if (pid === undefined || liveProcess(pid))
        throw new Error(
          "migration89_cleanup_ran_while_detached_descendant_live",
        );
    });
    try {
      handle = spawnMigration89Process({
        binary: process.execPath,
        args: ["-e", detachedDescendantThenExitProgram],
        environment: childEnvironment,
        input: undefined,
        cleanup,
        timeoutMs: 2_000,
        terminationGraceMs: 50,
        closeDrainGraceMs: 25,
      });
      pid = await descendantPid(handle);

      const result = await resultWithin(handle);
      expect(result).toMatchObject({
        status: 0,
        signal: null,
        timedOut: false,
      });
      expect(result.error).toBeUndefined();
      expectProcessGone(pid);
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      emergencyProcessCleanup(handle, pid);
    }
  },
  10_000,
);

it.skipIf(process.platform !== "linux")(
  "terminates and reaps the whole process group on timeout",
  async () => {
    let handle: Migration89ProcessHandle | undefined;
    let pid: number | undefined;
    const cleanup = vi.fn(() => {
      if (pid === undefined || liveProcess(pid))
        throw new Error("migration89_cleanup_ran_while_descendant_live");
    });
    try {
      handle = spawnMigration89Process({
        binary: process.execPath,
        args: ["-e", descendantTimeoutProgram],
        environment: childEnvironment,
        input: undefined,
        cleanup,
        timeoutMs: 2_000,
        terminationGraceMs: 50,
        closeDrainGraceMs: 25,
      });
      pid = await descendantPid(handle);

      const result = await resultWithin(handle);
      expect(result).toMatchObject({
        status: null,
        signal: "SIGKILL",
        timedOut: true,
        error: { code: "ETIMEDOUT" },
      });
      expect(result.error?.additionalCodes).toBeUndefined();
      expectProcessGone(pid);
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      emergencyProcessCleanup(handle, pid);
    }
  },
  10_000,
);

it.skipIf(process.platform !== "linux")(
  "terminateAndWait reaps the whole containment boundary through one finalizer",
  async () => {
    let handle: Migration89ProcessHandle | undefined;
    let pid: number | undefined;
    let cleanupObservedDescendantGone = false;
    const cleanup = vi.fn(() => {
      if (pid === undefined)
        throw new Error("migration89_cleanup_ran_before_descendant_ready");
      cleanupObservedDescendantGone = !liveProcess(pid);
      if (!cleanupObservedDescendantGone)
        throw new Error("migration89_cleanup_ran_while_descendant_live");
    });
    try {
      handle = spawnMigration89Process({
        binary: process.execPath,
        args: ["-e", descendantHolderProgram],
        environment: childEnvironment,
        input: undefined,
        cleanup,
        timeoutMs: 5_000,
        terminationGraceMs: 50,
        closeDrainGraceMs: 25,
      });
      pid = await descendantPid(handle);

      expect(handle.terminateAndWait()).toBe(handle.result);
      const result = await resultWithin(handle);
      expect(result).toMatchObject({
        status: null,
        signal: "SIGKILL",
        timedOut: false,
        error: { code: "ABORTED" },
      });
      expect(result.error?.additionalCodes).toBeUndefined();
      expectProcessGone(pid);
      expect(await handle.abort()).toBe(result);
      expect(cleanupObservedDescendantGone).toBe(true);
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      emergencyProcessCleanup(handle, pid);
    }
  },
  10_000,
);

it.skipIf(process.platform !== "linux").each([
  ["stdout", "STDOUT_FAILED"],
  ["stderr", "STDERR_FAILED"],
] as const)(
  "handles a %s stream error through whole-group termination and one finalizer",
  async (streamName, expectedCode) => {
    let handle: Migration89ProcessHandle | undefined;
    let pid: number | undefined;
    const cleanup = vi.fn(() => {
      if (pid === undefined || liveProcess(pid))
        throw new Error("migration89_cleanup_ran_while_descendant_live");
    });
    try {
      handle = spawnMigration89Process({
        binary: process.execPath,
        args: ["-e", descendantHolderProgram],
        environment: childEnvironment,
        input: undefined,
        cleanup,
        timeoutMs: 5_000,
        terminationGraceMs: 50,
        closeDrainGraceMs: 25,
      });
      pid = await descendantPid(handle);
      const stream =
        streamName === "stdout" ? handle.child.stdout : handle.child.stderr;
      if (stream === null)
        throw new Error(`migration89_${streamName}_stream_unavailable`);
      stream.destroy(
        Object.assign(new Error(`${streamName}-stream-secret-canary`), {
          code: "EIO",
        }),
      );

      const result = await resultWithin(handle);
      expect(result).toMatchObject({
        status: null,
        signal: "SIGKILL",
        timedOut: false,
        error: { code: expectedCode },
      });
      expect(result.error?.additionalCodes).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("stream-secret-canary");
      expectProcessGone(pid);
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      emergencyProcessCleanup(handle, pid);
    }
  },
  10_000,
);

it.skipIf(process.platform !== "linux").each(["stdout", "stderr"] as const)(
  "bounds combined subprocess output when %s exceeds the capture limit",
  async (streamName) => {
    const cleanup = vi.fn();
    const write =
      streamName === "stdout" ? "process.stdout.write" : "process.stderr.write";
    const handle = spawnMigration89Process({
      binary: process.execPath,
      args: ["-e", `${write}('x'.repeat(256)); setInterval(() => {}, 1_000)`],
      environment: childEnvironment,
      input: undefined,
      cleanup,
      timeoutMs: 5_000,
      terminationGraceMs: 50,
      closeDrainGraceMs: 25,
      maxBuffer: 64,
    });

    const result = await resultWithin(handle);
    expect(result).toMatchObject({
      status: null,
      signal: "SIGKILL",
      timedOut: false,
      error: { code: "MAX_BUFFER_EXCEEDED" },
    });
    expect(
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
    ).toBeLessThanOrEqual(64);
    expect(cleanup).toHaveBeenCalledOnce();
  },
  10_000,
);

it("rechecks liveness after a matching lock snapshot", async () => {
  let resolveUnavailable: (result: unknown) => void = () => {};
  let unavailableResult: Record<string, unknown> | undefined;
  const unavailable = new Promise((resolve) => (resolveUnavailable = resolve));
  const handle = {
    unavailable,
    unavailableResult: () => unavailableResult,
  };
  const lockSnapshot = vi.fn(() => {
    unavailableResult = {
      status: 0,
      signal: null,
      stdout: "stale-stdout-canary",
      stderr: "stale-stderr-canary",
      timedOut: false,
    };
    resolveUnavailable(unavailableResult);
    return [{ stale: true }];
  });

  await expect(
    waitForMigration89LockState({
      description: "post-snapshot race",
      lockSnapshot,
      predicate: () => true,
      watchedProcesses: [{ name: "migration", handle }],
      timeoutMs: 1_000,
    }),
  ).rejects.toThrow(
    /migration89_child_exited_before_lock_state:post-snapshot race:migration/u,
  );
  expect(lockSnapshot).toHaveBeenCalledOnce();
});

it("does not accept a matching snapshot that returns after the wait deadline", async () => {
  let now = 0;
  const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
  const lockSnapshot = vi.fn(() => {
    now = 101;
    return [{ tooLate: true }];
  });
  try {
    await expect(
      waitForMigration89LockState({
        description: "late matching snapshot",
        lockSnapshot,
        predicate: () => true,
        timeoutMs: 100,
      }),
    ).rejects.toThrow(
      /migration89_lock_state_not_observed:late matching snapshot/u,
    );
  } finally {
    dateNow.mockRestore();
  }
  expect(lockSnapshot).toHaveBeenCalledOnce();
});

it("rejects a foreign-database lock collision as local causal evidence", () => {
  const targetDatabaseOid = 810_081;
  const foreignDatabaseOid = 810_082;
  const foreignHolder = {
    application: "rr-m89-old-barrier",
    pid: 10,
    databaseOid: foreignDatabaseOid,
    lockDatabaseOid: foreignDatabaseOid,
    mode: "ExclusiveLock",
    granted: true,
    classId: 810081,
    objectId: 1,
    objectSubId: 2,
    blockers: [],
  };
  const foreignWaiter = {
    application: "rr-m89-old-first",
    pid: 11,
    databaseOid: foreignDatabaseOid,
    lockDatabaseOid: foreignDatabaseOid,
    mode: "ExclusiveLock",
    granted: false,
    classId: 810081,
    objectId: 1,
    objectSubId: 2,
    blockers: [foreignHolder.pid],
  };
  const localRelation = {
    application: "rr-m89-old-first",
    pid: 12,
    databaseOid: targetDatabaseOid,
    lockDatabaseOid: targetDatabaseOid,
    relation: '"CodexOAuthSecretNamespace"',
    mode: "RowExclusiveLock",
    granted: true,
    blockers: [],
  };
  const snapshot = {
    databaseOid: targetDatabaseOid,
    locks: [foreignHolder, foreignWaiter, localRelation],
  };

  expect(
    findMigration89AdvisoryLock(snapshot, "rr-m89-old-barrier", true),
  ).toBeUndefined();
  expect(
    findMigration89AdvisoryLock(snapshot, "rr-m89-old-first", false),
  ).toBeUndefined();
  expect(
    findMigration89RelationLock(
      snapshot,
      "rr-m89-old-first",
      '"CodexOAuthSecretNamespace"',
      "RowExclusiveLock",
      true,
    ),
  ).toBe(localRelation);
  expect(migration89LockBlockedBy(snapshot, localRelation, foreignHolder)).toBe(
    false,
  );
});

it("settles asynchronous spawn errors with sanitized evidence and one cleanup", async () => {
  const cleanup = vi.fn();
  const handle = spawnMigration89Process({
    binary: "/definitely-missing/migration89-spawn-secret-canary",
    args: [],
    environment: childEnvironment,
    input: undefined,
    cleanup,
    timeoutMs: 2_000,
  });

  const unavailable = await handle.unavailable;
  const result = await handle.result;
  expect(unavailable).toMatchObject({
    status: 127,
    signal: null,
  });
  expect(result).toMatchObject({
    status: 127,
    signal: null,
  });
  expect(JSON.stringify(result)).not.toMatch(
    /migration89-spawn-secret-canary/u,
  );
  expect(cleanup).toHaveBeenCalledOnce();
});

it.skipIf(process.platform !== "linux")(
  "records stdin EPIPE and reaps a descendant through the shared finalizer",
  async () => {
    let handle: Migration89ProcessHandle | undefined;
    let pid: number | undefined;
    const cleanup = vi.fn(() => {
      if (pid === undefined || liveProcess(pid))
        throw new Error("migration89_cleanup_ran_while_descendant_live");
    });
    try {
      handle = spawnMigration89Process({
        binary: process.execPath,
        args: ["-e", descendantHolderProgram],
        environment: childEnvironment,
        input: undefined,
        cleanup,
        timeoutMs: 2_000,
        terminationGraceMs: 50,
      });
      pid = await descendantPid(handle);
      handle.child.stdin?.emit(
        "error",
        Object.assign(new Error("stdin-stream-secret-canary"), {
          code: "EPIPE",
        }),
      );

      const result = await resultWithin(handle);
      expect(result.timedOut).toBe(false);
      expect(result.error).toMatchObject({ code: "EPIPE" });
      expect(["SIGTERM", "SIGKILL"]).toContain(result.signal);
      expect(JSON.stringify(result)).not.toContain("stream-secret-canary");
      expectProcessGone(pid);
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      emergencyProcessCleanup(handle, pid);
    }
  },
  10_000,
);

it.skipIf(process.platform !== "linux")(
  "bounds final stdin and reaps a descendant through the shared finalizer",
  async () => {
    let handle: Migration89ProcessHandle | undefined;
    let pid: number | undefined;
    const cleanup = vi.fn(() => {
      if (pid === undefined || liveProcess(pid))
        throw new Error("migration89_cleanup_ran_while_descendant_live");
    });
    try {
      handle = spawnMigration89Process({
        binary: process.execPath,
        args: ["-e", descendantHolderProgram],
        environment: childEnvironment,
        input: undefined,
        keepStdinOpen: true,
        cleanup,
        timeoutMs: 2_000,
        terminationGraceMs: 50,
        maxInputBytes: 32,
      });
      pid = await descendantPid(handle);

      expect(handle.write("x".repeat(31))).toBe(true);
      expect(handle.end("é")).toBe(false);
      const result = await resultWithin(handle);
      expect(result.timedOut).toBe(false);
      expect(result.error).toMatchObject({ code: "MAX_INPUT_EXCEEDED" });
      expect(["SIGTERM", "SIGKILL"]).toContain(result.signal);
      expectProcessGone(pid);
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      emergencyProcessCleanup(handle, pid);
    }
  },
  10_000,
);

it("settles with sanitized cleanup failure when cleanup throws", async () => {
  const cleanup = vi.fn(() => {
    throw new Error("cleanup-secret-canary");
  });
  const handle = spawnMigration89Process({
    binary: process.execPath,
    args: ["-e", ""],
    environment: childEnvironment,
    input: undefined,
    cleanup,
    timeoutMs: 2_000,
  });

  const result = await handle.result;
  expect(result).toMatchObject({
    status: 0,
    signal: null,
    timedOut: false,
    error: { code: "CLEANUP_FAILED" },
  });
  expect(JSON.stringify(result)).not.toContain("cleanup-secret-canary");
  expect(cleanup).toHaveBeenCalledOnce();
});

it("bounds timeout escalation through SIGTERM and SIGKILL", async () => {
  const cleanup = vi.fn();
  const startedAt = Date.now();
  const handle = spawnMigration89Process({
    binary: process.execPath,
    args: [
      "-e",
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)",
    ],
    environment: childEnvironment,
    input: undefined,
    cleanup,
    timeoutMs: 1_000,
    terminationGraceMs: 50,
  });

  const result = await handle.result;
  expect(result).toMatchObject({
    status: null,
    signal: "SIGKILL",
    timedOut: true,
    error: { code: "ETIMEDOUT" },
  });
  expect(Date.now() - startedAt).toBeLessThan(3_000);
  expect(cleanup).toHaveBeenCalledOnce();
});

const expectedDirectPostgresEvidence = Object.freeze({
  sqlState: "P0001",
  message: "expected_failure",
  routine: "exec_stmt_raise",
});
const expectedForeignKeyEvidence = Object.freeze({
  sqlState: "23503",
  constraint: "Child_parent_fkey",
  schema: "public",
  table: "Child",
  referencedTable: "Parent",
  routine: "ri_ReportViolation",
});

it.each([
  "ERROR: P0001: expected_failure\nLOCATION: exec_stmt_raise, pl_exec.c:42",
  "ERROR: P0001: expected_failure\r\nLOCATION: exec_stmt_raise, pl_exec.c:42\r\n",
  "psql:<stdin>:42: ERROR: P0001: expected_failure\nLOCATION: exec_stmt_raise, pl_exec.c:42\n",
  "\u001B[31mERROR:\u001B[0m P0001: expected_failure\nLOCATION: exec_stmt_raise, pl_exec.c:42\n",
])("accepts a canonical exact PostgreSQL ERROR envelope %#", (stderr) => {
  expect(() =>
    assertPsqlFailedWithExactMessage(
      { status: 1, signal: null, stdout: "", stderr },
      expectedDirectPostgresEvidence,
      "strict failure",
    ),
  ).not.toThrow();
});

it.each([
  'ERROR: 23503: insert or update on table "Child" violates foreign key constraint "Child_parent_fkey"\nDETAIL: Key (parent_id)=(1) is not present in table "Parent".\nSCHEMA NAME: public\nTABLE NAME: Child\nCONSTRAINT NAME: Child_parent_fkey\nLOCATION: ri_ReportViolation, ri_triggers.c:2598\n',
  'ERROR: 23503: update or delete on table "Parent" violates foreign key constraint "Child_parent_fkey" on table "Child"\r\nDETAIL: Key (parent_id)=(1) is still referenced from table "Child".\r\nSCHEMA NAME: public\r\nTABLE NAME: Child\r\nCONSTRAINT NAME: Child_parent_fkey\r\nLOCATION: ri_ReportViolation, ri_triggers.c:2598\r\n',
])(
  "accepts canonical PostgreSQL foreign-key violation evidence %#",
  (stderr) => {
    expect(() =>
      assertPsqlFailedWithOneOfExactMessages(
        {
          status: 1,
          signal: null,
          stdout: "",
          stderr,
        },
        [
          {
            sqlState: "23503",
            constraint: "unrelated_fkey",
            routine: "ri_ReportViolation",
          },
          expectedForeignKeyEvidence,
        ],
        "strict foreign key failure",
      ),
    ).not.toThrow();
    expect(() =>
      assertPsqlFailedWithExactMessage(
        { status: 1, signal: null, stdout: "", stderr },
        expectedForeignKeyEvidence,
        "strict exact foreign key failure",
      ),
    ).not.toThrow();
  },
);

it.each([
  'ERROR: 23503: insert or update on table "Child" violates foreign key constraint "Child_parent_fkey"',
  'ERROR: insert or update on table "Child" violates foreign key constraint "Child_parent_fkey"',
  'ERROR: 23505: insert or update on table "Child" violates foreign key constraint "Child_parent_fkey"',
  'ERROR: P0001: update or delete on table "Parent" violates foreign key constraint "Child_parent_fkey" on table "Child"',
  'NOTICE: foreign key constraint "Child_parent_fkey"',
  'ERROR: constraint "Child_parent_fkey" of relation "Child" does not exist',
  'ERROR: cannot drop constraint "Child_parent_fkey" on table "Child" because other objects depend on it',
  'ERROR: duplicate key value violates unique constraint "Child_parent_fkey"',
  "ERROR: Child_parent_fkey",
  'ERROR: unrelated failure mentioning constraint "Child_parent_fkey"',
  'ERROR: insert or update on table "Child" violates foreign key constraint "prefix_Child_parent_fkey"',
  'ERROR: update or delete on table "Parent" violates foreign key constraint "Child_parent_fkey_suffix" on table "Child"',
  'ERROR: 23503: insert or update on table "Attacker" violates foreign key constraint "Child_parent_fkey"\nDETAIL: Key (parent_id)=(1) is not present in table "Parent".\nSCHEMA NAME: public\nTABLE NAME: Attacker\nCONSTRAINT NAME: Child_parent_fkey\nLOCATION: ri_ReportViolation, ri_triggers.c:2598',
])(
  "rejects non-FK ERROR evidence mentioning the exact constraint %#",
  (stderr) => {
    expect(() =>
      assertPsqlFailedWithOneOfExactMessages(
        {
          status: 1,
          signal: null,
          stdout: "",
          stderr,
        },
        [expectedForeignKeyEvidence],
        "strict foreign key failure",
      ),
    ).toThrow(/strict foreign key failure/u);
    expect(() =>
      assertPsqlFailedWithExactMessage(
        { status: 1, signal: null, stdout: "", stderr },
        expectedForeignKeyEvidence,
        "strict exact foreign key failure",
      ),
    ).toThrow(/strict exact foreign key failure/u);
  },
);

it.each([
  { stdout: "expected_failure", stderr: "" },
  { stdout: "ERROR: spoofed\n", stderr: "ERROR: expected_failure" },
  {
    stdout: "\u001B[31mpsql: spoofed\u001B[0m\n",
    stderr: "ERROR: expected_failure",
  },
  { stdout: "", stderr: "expected_failure" },
  { stdout: "", stderr: "NOTICE: expected_failure" },
  { stdout: "", stderr: "DETAIL: expected_failure" },
  { stdout: "", stderr: "ERROR: EXPECTED_FAILURE" },
  { stdout: "", stderr: "ERROR: prefix expected_failure" },
  { stdout: "", stderr: "ERROR: expected_failure suffix" },
  { stdout: "", stderr: "prefix\nERROR: expected_failure" },
  { stdout: "", stderr: "ERROR: expected_failure\nsuffix" },
  {
    stdout: "",
    stderr: "ERROR: unrelated_failure\nERROR: expected_failure",
  },
  {
    stdout: "",
    stderr: "ERROR: expected_failure\nERROR: unrelated_failure",
  },
  {
    stdout: "",
    stderr: "ERROR: expected_failure\nERROR: expected_failure",
  },
  {
    stdout: "",
    stderr: "ERROR: expected_failure\nDETAIL: ERROR: hidden_failure",
  },
  {
    stdout: "",
    stderr: "ERROR: expected_failure\nDETAIL: arbitrary trailing diagnostic",
  },
  {
    stdout: "",
    stderr:
      "\u001B[31mERROR: expected_failure\u001B[0m\n\u001B[31mERROR: hidden_failure\u001B[0m",
  },
  {
    stdout: "",
    stderr: "ERROR: expected_failure\ninjected continuation",
  },
  {
    stdout: "",
    stderr: "psql: error: ERROR: expected_failure",
  },
  {
    stdout: "",
    stderr: "psql:/tmp/migration.sql:42: ERROR: expected_failure",
  },
  {
    stdout: "",
    stderr:
      'psql: warning: extra command-line argument "ERROR: expected_failure" ignored',
  },
  { stdout: "", stderr: "\u001B[\nERROR: expected_failurem" },
  { stdout: "", stderr: "\u001B[31ERROR: expected_failure" },
  {
    stdout: "",
    stderr:
      "\u001B[2JERROR: P0001: expected_failure\nLOCATION: exec_stmt_raise, pl_exec.c:42",
  },
  {
    stdout: "",
    stderr:
      "ERROR: P0001: expected_failure\u001B[999D\nLOCATION: exec_stmt_raise, pl_exec.c:42",
  },
  { stdout: "", stderr: "ERROR: expected_failure\rtrailing" },
  { stdout: "", stderr: "ERROR: expected_failure\u0085" },
  { stdout: "", stderr: "ERROR: expected_failure\u2028" },
  { stdout: "", stderr: "ERROR: expected_failure\u2029" },
  {
    stdout: "",
    stderr:
      "ERROR: P0001: expected_failure\u00a0\nLOCATION: exec_stmt_raise, pl_exec.c:42",
  },
  {
    stdout: "",
    stderr:
      "ERROR: P0001: expected_failure\nLOCATION: exec_stmt_raise, pl_exec.c:42\t",
  },
])("rejects noncanonical PostgreSQL failure evidence %#", (output) => {
  expect(() =>
    assertPsqlFailedWithExactMessage(
      { status: 1, signal: null, ...output },
      expectedDirectPostgresEvidence,
      "strict failure",
    ),
  ).toThrow(/strict failure/u);
  expect(() =>
    assertPsqlFailedWithOneOfExactMessages(
      { status: 1, signal: null, ...output },
      [
        expectedDirectPostgresEvidence,
        {
          sqlState: "P0001",
          message: "other_expected_failure",
          routine: "exec_stmt_raise",
        },
      ],
      "strict one-of failure",
    ),
  ).toThrow(/strict one-of failure/u);
});

it("rejects multiline expected evidence without disclosing it", () => {
  const expected = {
    sqlState: "P0001",
    message: "expected-secret-canary\nERROR: injected-secret-canary",
    routine: "exec_stmt_raise",
  };
  let caught: unknown;
  try {
    assertPsqlFailedWithExactMessage(
      {
        status: 1,
        signal: null,
        stdout: "stdout-secret-canary",
        stderr: "ERROR: stderr-secret-canary",
      },
      expected,
      "sanitized mismatch",
    );
  } catch (error) {
    caught = error;
  }

  const serialized = `${String(caught)}${JSON.stringify(caught)}`;
  expect(serialized).toContain("sanitized mismatch");
  expect(serialized).not.toMatch(
    /expected-secret-canary|injected-secret-canary|stdout-secret-canary|stderr-secret-canary/u,
  );
});

it.each([
  { status: 0, signal: null },
  { status: -1, signal: null },
  { status: 1.5, signal: null },
  { status: 256, signal: null },
  { status: null, signal: "SIGTERM" },
  { status: 1, signal: "SIGTERM" },
  { status: 1, signal: null, error: { code: "EIO" } },
  { status: 1, signal: null, timedOut: true },
  { status: 1, signal: null, error: { code: "ETIMEDOUT" } },
])("rejects non-exit PostgreSQL failure evidence %#", (processState) => {
  expect(() =>
    assertPsqlFailedWithExactMessage(
      {
        stdout: "",
        stderr:
          "ERROR: P0001: expected_failure\nLOCATION: exec_stmt_raise, pl_exec.c:42",
        ...processState,
      },
      expectedDirectPostgresEvidence,
      "invalid process result",
    ),
  ).toThrow(/invalid process result/u);
});
