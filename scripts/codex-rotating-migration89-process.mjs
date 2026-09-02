import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import {
  setImmediate as yieldToProcessEvents,
  setTimeout as delay,
} from "node:timers/promises";
import { psqlResultDiagnostic } from "./codex-rotating-rehearsal-process-result.mjs";

const linuxSubreaperSupervisor = "/usr/bin/python3";
const linuxSubreaperProgram = String.raw`
import ctypes
import os
import signal
import subprocess
import sys
import time

PR_SET_CHILD_SUBREAPER = 36
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
    os._exit(125)

try:
    term_grace = float(sys.argv[1])
    settle_grace = float(sys.argv[2])
    command = sys.argv[3:]
except Exception:
    os._exit(125)
if not command or not (0.0 < term_grace <= 10.0) or not (0.0 < settle_grace <= 10.0):
    os._exit(125)

supervisor_pid = os.getpid()
termination_signal = None

def request_termination(value, _frame):
    global termination_signal
    if termination_signal is None:
        termination_signal = value

signal.signal(signal.SIGTERM, request_termination)
signal.signal(signal.SIGINT, request_termination)

def descendants():
    parents = {}
    try:
        entries = os.listdir("/proc")
    except OSError:
        return None
    for entry in entries:
        if not entry.isdigit():
            continue
        try:
            value = open("/proc/" + entry + "/stat", "r", encoding="utf-8").read()
            end = value.rfind(")")
            fields = value[end + 2:].split()
            parent = int(fields[1])
            pid = int(entry)
        except (OSError, ValueError, IndexError):
            continue
        parents.setdefault(parent, []).append(pid)
    found = set()
    pending = [supervisor_pid]
    while pending:
        parent = pending.pop()
        for pid in parents.get(parent, []):
            if pid == supervisor_pid or pid in found:
                continue
            found.add(pid)
            pending.append(pid)
    return found

def reap():
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        except InterruptedError:
            continue
        if pid == 0:
            return

def signal_descendants(value):
    observed = descendants()
    if observed is None:
        return None
    for pid in sorted(observed, reverse=True):
        try:
            os.kill(pid, value)
        except ProcessLookupError:
            pass
        except OSError:
            return None
    return observed

try:
    child = subprocess.Popen(command, close_fds=False)
except Exception:
    os._exit(125)

return_code = None
while termination_signal is None and return_code is None:
    return_code = child.poll()
    if return_code is None:
        time.sleep(0.005)

deadline = time.monotonic() + term_grace
while True:
    reap()
    observed = signal_descendants(signal.SIGTERM)
    if observed is None:
        os._exit(125)
    if not observed or time.monotonic() >= deadline:
        break
    time.sleep(0.01)

kill_required = bool(observed)
deadline = time.monotonic() + settle_grace
while True:
    reap()
    observed = signal_descendants(signal.SIGKILL)
    if observed is None:
        os._exit(125)
    if not observed:
        break
    if time.monotonic() >= deadline:
        os._exit(125)
    time.sleep(0.01)
reap()

if termination_signal is not None:
    final_signal = signal.SIGKILL if kill_required else termination_signal
    signal.signal(termination_signal, signal.SIG_DFL)
    os.kill(supervisor_pid, final_signal)
    os._exit(128 + final_signal)

if return_code < 0:
    final_signal = -return_code
    if final_signal not in (signal.SIGKILL, signal.SIGSTOP):
        signal.signal(final_signal, signal.SIG_DFL)
    os.kill(supervisor_pid, final_signal)
    os._exit(128 + final_signal)
if return_code > 255:
    os._exit(125)
os._exit(return_code)
`;

const allowedProcessErrorCodes = new Set([
  "EACCES",
  "EAGAIN",
  "EPIPE",
  "EMFILE",
  "ENFILE",
  "ENOENT",
  "ENOMEM",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_WRITE_AFTER_END",
]);
const allowedSignals = new Set([
  "SIGABRT",
  "SIGALRM",
  "SIGBUS",
  "SIGFPE",
  "SIGHUP",
  "SIGILL",
  "SIGINT",
  "SIGKILL",
  "SIGPIPE",
  "SIGQUIT",
  "SIGSEGV",
  "SIGTERM",
  "SIGTRAP",
]);
const maximumMigration89InputBytes = 8 * 1024 * 1024;

function boundedMilliseconds(value, maximum) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error("migration89_process_bound_invalid");
  return Math.min(value, maximum);
}

function containedSupervisorInvocation(
  command,
  { terminationGraceMs = 250, settleGraceMs = 1_000 } = {},
) {
  const termGraceMs = boundedMilliseconds(terminationGraceMs, 10_000);
  const boundedSettleGraceMs = boundedMilliseconds(settleGraceMs, 10_000);
  return Object.freeze({
    kind: "subreaper",
    binary: linuxSubreaperSupervisor,
    args: Object.freeze([
      "-c",
      linuxSubreaperProgram,
      `${(termGraceMs / 1_000).toFixed(3)}`,
      `${(boundedSettleGraceMs / 1_000).toFixed(3)}`,
      ...command,
    ]),
  });
}

function sanitizedErrorCode(error, fallback) {
  return allowedProcessErrorCodes.has(error?.code) ? error.code : fallback;
}

function sanitizedExitStatus(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 255
    ? value
    : null;
}

function sanitizedSignal(value) {
  return allowedSignals.has(value) ? value : null;
}

function databaseBoundLock(snapshot, lock) {
  const databaseOid = snapshot?.databaseOid;
  return Boolean(
    Number.isSafeInteger(databaseOid) &&
    databaseOid > 0 &&
    lock &&
    lock.databaseOid === databaseOid &&
    lock.lockDatabaseOid === databaseOid &&
    Number.isSafeInteger(lock.pid) &&
    lock.pid > 0 &&
    Array.isArray(lock.blockers) &&
    lock.blockers.every(
      (pid) => Number.isSafeInteger(pid) && pid > 0 && pid !== lock.pid,
    ) &&
    new Set(lock.blockers).size === lock.blockers.length,
  );
}

function relationBoundLock(snapshot, lock) {
  return Boolean(
    databaseBoundLock(snapshot, lock) &&
    lock.lockType === "relation" &&
    Number.isSafeInteger(snapshot?.relationOid) &&
    snapshot.relationOid > 0 &&
    lock.relationOid === snapshot.relationOid,
  );
}

function findDatabaseBoundLock(snapshot, predicate) {
  if (!Array.isArray(snapshot?.locks)) return undefined;
  return snapshot.locks.find(
    (lock) => databaseBoundLock(snapshot, lock) && predicate(lock),
  );
}

export function findMigration89RelationLock(
  snapshot,
  application,
  relation,
  mode,
  granted,
) {
  if (!Array.isArray(snapshot?.locks)) return undefined;
  return snapshot.locks.find(
    (lock) =>
      relationBoundLock(snapshot, lock) &&
      lock.application === application &&
      lock.relation === relation &&
      lock.mode === mode &&
      lock.granted === granted,
  );
}

export function findMigration89AdvisoryLock(snapshot, application, granted) {
  return findDatabaseBoundLock(
    snapshot,
    (lock) =>
      lock.application === application &&
      lock.lockType === "advisory" &&
      lock.relationOid === null &&
      lock.mode === "ExclusiveLock" &&
      lock.granted === granted &&
      lock.classId === 810081 &&
      lock.objectId === 1 &&
      lock.objectSubId === 2,
  );
}

export function migration89LockBlockedBy(snapshot, blockedLock, blockerLock) {
  return Boolean(
    Array.isArray(snapshot?.locks) &&
    snapshot.locks.includes(blockedLock) &&
    snapshot.locks.includes(blockerLock) &&
    databaseBoundLock(snapshot, blockedLock) &&
    databaseBoundLock(snapshot, blockerLock) &&
    blockedLock.granted === false &&
    typeof blockerLock.granted === "boolean" &&
    blockedLock.pid !== blockerLock.pid &&
    blockedLock.blockers.includes(blockerLock.pid),
  );
}

export function spawnMigration89Process({
  binary,
  args,
  environment,
  input,
  keepStdinOpen = false,
  cleanup = () => {},
  timeoutMs = 30_000,
  terminationGraceMs = 2_000,
  closeDrainGraceMs = 100,
  maxBuffer = 8 * 1024 * 1024,
  maxInputBytes = maximumMigration89InputBytes,
}) {
  let cleanupAttempted = false;
  const cleanupOnce = () => {
    if (cleanupAttempted) return;
    cleanupAttempted = true;
    cleanup();
  };
  const rejectBeforeSpawn = (code) => {
    try {
      cleanupOnce();
    } catch {
      throw new Error(`${code}_and_cleanup_failed`);
    }
    throw new Error(code);
  };

  if (
    typeof binary !== "string" ||
    binary.length === 0 ||
    binary.includes("\0") ||
    !Array.isArray(args) ||
    args.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
    !environment ||
    typeof environment !== "object"
  )
    rejectBeforeSpawn("migration89_process_invocation_invalid");

  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(terminationGraceMs) ||
    terminationGraceMs <= 0 ||
    !Number.isSafeInteger(closeDrainGraceMs) ||
    closeDrainGraceMs <= 0 ||
    !Number.isSafeInteger(maxBuffer) ||
    maxBuffer <= 0 ||
    !Number.isSafeInteger(maxInputBytes) ||
    maxInputBytes <= 0
  )
    rejectBeforeSpawn("migration89_process_bounds_invalid");

  const executionTimeoutMs = boundedMilliseconds(timeoutMs, 600_000);
  const killGraceMs = boundedMilliseconds(terminationGraceMs, 10_000);
  const forcedSettleGraceMs = Math.max(killGraceMs, 1_000);
  const drainGraceMs = boundedMilliseconds(closeDrainGraceMs, 1_000);
  const outputLimitBytes = Math.min(maxBuffer, 16 * 1024 * 1024);
  const inputLimitBytes = Math.min(maxInputBytes, 16 * 1024 * 1024);

  if (input !== undefined && typeof input !== "string")
    rejectBeforeSpawn("migration89_process_input_invalid");
  const initialInputBytes =
    input === undefined ? 0 : Buffer.byteLength(input, "utf8");
  if (initialInputBytes > inputLimitBytes)
    rejectBeforeSpawn("migration89_process_input_too_large");

  if (process.platform !== "linux") {
    try {
      cleanupOnce();
    } catch {
      throw new Error(
        "migration89_descendant_containment_unsupported_and_cleanup_failed",
      );
    }
    throw new Error("migration89_descendant_containment_unsupported");
  }

  const supervisor = containedSupervisorInvocation(
    [
      "/bin/sh",
      "-c",
      'command=$1; shift; command -v "$command" >/dev/null 2>&1 || exit 127; exec "$command" "$@"',
      "migration89-supervisor",
      binary,
      ...args,
    ],
    {
      interactive: true,
      terminationGraceMs: killGraceMs,
      settleGraceMs: forcedSettleGraceMs,
    },
  );
  let child;
  try {
    // The detached outer process supplies an ordinary process group. The
    // selected supervisor additionally contains a setsid descendant either
    // in a nested PID namespace or beneath a Linux child subreaper.
    child = spawn(supervisor.binary, supervisor.args, {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
  } catch {
    let cleanupFailed = false;
    try {
      cleanupOnce();
    } catch {
      cleanupFailed = true;
    }
    throw new Error(
      cleanupFailed
        ? "migration89_process_spawn_and_cleanup_failed"
        : "migration89_process_spawn_failed",
    );
  }

  let stdout = "";
  let stderr = "";
  let capturedOutputBytes = 0;
  let submittedInputBytes = initialInputBytes;
  let outputLimitExceeded = false;
  let status = null;
  let signal = null;
  let timedOut = false;
  let processEnded = false;
  let closeObserved = false;
  const processGroupId =
    Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : null;
  const subreaperContainment = supervisor.kind === "subreaper";
  let processGroupGone = processGroupId === null;
  let terminationStarted = false;
  let killSent = false;
  let unavailableResult;
  let settledResult;
  let finalized = false;
  const failureCodes = new Set();
  let executionTimer;
  let killTimer;
  let forcedSettleTimer;
  let drainTimer;
  let processGroupProbeTimer;
  let resolveUnavailable;
  let resolveResult;
  const unavailable = new Promise((resolve) => (resolveUnavailable = resolve));
  const result = new Promise((resolve) => (resolveResult = resolve));

  const recordFailure = (code) => failureCodes.add(code);
  const processResult = () => {
    const codes = [...failureCodes];
    return Object.freeze({
      status,
      signal,
      stdout,
      stderr,
      timedOut,
      ...(codes.length > 0
        ? {
            error: Object.freeze({
              code: codes[0],
              ...(codes.length > 1
                ? { additionalCodes: Object.freeze(codes.slice(1)) }
                : {}),
            }),
          }
        : {}),
    });
  };
  const clearTimer = (timer) => {
    if (timer !== undefined) clearTimeout(timer);
  };
  const destroyProcessStreams = () => {
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
  };
  const markUnavailable = () => {
    if (unavailableResult !== undefined) return;
    clearTimer(executionTimer);
    unavailableResult = processResult();
    resolveUnavailable(unavailableResult);
  };
  const finalize = () => {
    if (finalized) return;
    finalized = true;
    clearTimer(executionTimer);
    clearTimer(killTimer);
    clearTimer(forcedSettleTimer);
    clearTimer(drainTimer);
    clearTimer(processGroupProbeTimer);
    try {
      cleanupOnce();
    } catch {
      recordFailure("CLEANUP_FAILED");
    } finally {
      settledResult = processResult();
      resolveResult(settledResult);
    }
  };
  const maybeFinalize = () => {
    if (unavailableResult !== undefined && closeObserved && processGroupGone)
      finalize();
  };
  const waitForCloseAfterGroupExit = () => {
    if (!processGroupGone || closeObserved || drainTimer !== undefined) return;
    drainTimer = setTimeout(() => {
      if (!closeObserved) {
        recordFailure("STDIO_DRAIN_TIMEOUT");
        destroyProcessStreams();
        closeObserved = true;
        maybeFinalize();
      }
    }, drainGraceMs);
  };
  const markProcessGroupGone = () => {
    if (processGroupGone) return;
    processGroupGone = true;
    clearTimer(killTimer);
    clearTimer(forcedSettleTimer);
    clearTimer(processGroupProbeTimer);
    waitForCloseAfterGroupExit();
    maybeFinalize();
  };
  const processGroupIsGone = () => {
    if (processGroupGone) return true;
    if (processGroupId === null) {
      markProcessGroupGone();
      return true;
    }
    try {
      process.kill(-processGroupId, 0);
      return false;
    } catch (error) {
      if (error?.code === "ESRCH" && processEnded) {
        markProcessGroupGone();
        return true;
      }
      if (error?.code === "ESRCH") return false;
      recordFailure("PROCESS_GROUP_PROBE_FAILED");
      return false;
    }
  };
  const signalProcessGroup = (nextSignal) => {
    if (processGroupIsGone()) return;
    try {
      if (subreaperContainment && nextSignal === "SIGTERM" && !processEnded)
        child.kill(nextSignal);
      else if (processGroupId !== null)
        process.kill(-processGroupId, nextSignal);
      else if (!processEnded) child.kill(nextSignal);
    } catch (error) {
      if (error?.code === "ESRCH" && processEnded) markProcessGroupGone();
      else {
        if (!processEnded) {
          try {
            if (!child.kill(nextSignal)) recordFailure("TERMINATION_FAILED");
          } catch {
            recordFailure("TERMINATION_FAILED");
          }
        } else recordFailure("TERMINATION_FAILED");
      }
    }
  };
  const scheduleProcessGroupProbe = () => {
    if (processGroupGone || processGroupProbeTimer !== undefined) return;
    processGroupProbeTimer = setTimeout(
      () => {
        processGroupProbeTimer = undefined;
        if (processGroupIsGone()) return;
        if (killSent) signalProcessGroup("SIGKILL");
        scheduleProcessGroupProbe();
      },
      Math.min(drainGraceMs, 25),
    );
  };
  const settleUncertainProcessGroup = () => {
    recordFailure("PROCESS_GROUP_CLEANUP_UNCERTAIN");
    signalProcessGroup("SIGKILL");
    destroyProcessStreams();
    child.unref();
    markProcessGroupGone();
  };
  const beginTermination = () => {
    if (processGroupIsGone()) {
      waitForCloseAfterGroupExit();
      maybeFinalize();
      return;
    }
    if (!terminationStarted) {
      terminationStarted = true;
      signalProcessGroup("SIGTERM");
      if (processGroupGone) return;
      killTimer = setTimeout(
        () => {
          killTimer = undefined;
          if (processGroupIsGone()) return;
          killSent = true;
          signalProcessGroup("SIGKILL");
          if (processGroupGone) return;
          forcedSettleTimer = setTimeout(() => {
            forcedSettleTimer = undefined;
            if (!processGroupIsGone()) settleUncertainProcessGroup();
          }, forcedSettleGraceMs);
        },
        subreaperContainment
          ? killGraceMs + forcedSettleGraceMs + drainGraceMs
          : killGraceMs,
      );
    }
    scheduleProcessGroupProbe();
  };
  const markProcessEnded = (nextStatus, nextSignal) => {
    if (processEnded) return;
    processEnded = true;
    status = sanitizedExitStatus(nextStatus);
    signal = sanitizedSignal(nextSignal);
    if (subreaperContainment && status === 125)
      recordFailure("SUPERVISOR_FAILED");
    clearTimer(executionTimer);
    if (!processGroupIsGone() && !terminationStarted) {
      recordFailure("PROCESS_GROUP_SURVIVED_LEADER");
      beginTermination();
    } else if (!processGroupGone) {
      scheduleProcessGroupProbe();
    }
    markUnavailable();
    waitForCloseAfterGroupExit();
    maybeFinalize();
  };
  const handleProcessFailure = (error, fallback) => {
    if (finalized) return;
    recordFailure(sanitizedErrorCode(error, fallback));
    markUnavailable();
    beginTermination();
  };
  const captureOutput = (stream, chunk) => {
    if (finalized || outputLimitExceeded) return;
    const value = String(chunk);
    const byteLength = Buffer.byteLength(value, "utf8");
    if (capturedOutputBytes + byteLength > outputLimitBytes) {
      outputLimitExceeded = true;
      recordFailure("MAX_BUFFER_EXCEEDED");
      markUnavailable();
      beginTermination();
      destroyProcessStreams();
      return;
    }
    capturedOutputBytes += byteLength;
    if (stream === "stdout") stdout += value;
    else stderr += value;
  };

  child.stdout?.on("data", (chunk) => captureOutput("stdout", chunk));
  child.stderr?.on("data", (chunk) => captureOutput("stderr", chunk));
  child.stdin?.on("error", (error) =>
    handleProcessFailure(error, "STDIN_FAILED"),
  );
  child.stdout?.on("error", (error) =>
    handleProcessFailure(error, "STDOUT_FAILED"),
  );
  child.stderr?.on("error", (error) =>
    handleProcessFailure(error, "STDERR_FAILED"),
  );
  child.on("error", (error) => {
    if (finalized) return;
    recordFailure(
      sanitizedErrorCode(
        error,
        child.pid === undefined ? "SPAWN_FAILED" : "PROCESS_FAILED",
      ),
    );
    markUnavailable();
    if (
      child.pid === undefined ||
      child.exitCode !== null ||
      child.signalCode !== null
    )
      markProcessEnded(child.exitCode, child.signalCode);
    else beginTermination();
  });
  child.once("exit", (nextStatus, nextSignal) =>
    markProcessEnded(nextStatus, nextSignal),
  );
  child.once("close", (nextStatus, nextSignal) => {
    closeObserved = true;
    markProcessEnded(nextStatus, nextSignal);
    if (!processGroupIsGone()) beginTermination();
    maybeFinalize();
  });

  executionTimer = setTimeout(() => {
    timedOut = true;
    recordFailure("ETIMEDOUT");
    markUnavailable();
    beginTermination();
  }, executionTimeoutMs);
  executionTimer.unref();

  const write = (sql) => {
    if (unavailableResult !== undefined) return false;
    if (typeof sql !== "string") {
      handleProcessFailure(undefined, "STDIN_FAILED");
      return false;
    }
    const inputBytes = Buffer.byteLength(sql, "utf8");
    if (submittedInputBytes + inputBytes > inputLimitBytes) {
      recordFailure("MAX_INPUT_EXCEEDED");
      markUnavailable();
      beginTermination();
      return false;
    }
    submittedInputBytes += inputBytes;
    try {
      return child.stdin.write(sql);
    } catch (error) {
      handleProcessFailure(error, "STDIN_FAILED");
      return false;
    }
  };
  const end = (sql) => {
    if (unavailableResult !== undefined) return false;
    if (sql !== undefined && typeof sql !== "string") {
      handleProcessFailure(undefined, "STDIN_FAILED");
      return false;
    }
    const inputBytes = sql === undefined ? 0 : Buffer.byteLength(sql, "utf8");
    if (submittedInputBytes + inputBytes > inputLimitBytes) {
      recordFailure("MAX_INPUT_EXCEEDED");
      markUnavailable();
      beginTermination();
      return false;
    }
    submittedInputBytes += inputBytes;
    try {
      child.stdin.end(sql);
      return true;
    } catch (error) {
      handleProcessFailure(error, "STDIN_FAILED");
      return false;
    }
  };
  const abort = () => {
    if (!finalized && unavailableResult === undefined) {
      recordFailure("ABORTED");
      markUnavailable();
      beginTermination();
    }
    return result;
  };
  const handle = Object.freeze({
    child,
    unavailable,
    result,
    stdout: () => stdout,
    stderr: () => stderr,
    unavailableResult: () => unavailableResult,
    closedResult: () => settledResult,
    write,
    end,
    abort,
    terminateAndWait: abort,
  });

  try {
    if (keepStdinOpen) {
      if (input !== undefined) child.stdin.write(input);
    } else {
      child.stdin.end(input);
    }
  } catch (error) {
    handleProcessFailure(error, "STDIN_FAILED");
  }

  return handle;
}

function exitedBeforeLockState(description, watchedProcess, result) {
  return new Error(
    `migration89_child_exited_before_lock_state:${description}:${watchedProcess.name}:${psqlResultDiagnostic(result)}`,
  );
}

function assertProcessesLive(description, watchedProcesses) {
  for (const watchedProcess of watchedProcesses) {
    const result = watchedProcess.handle.unavailableResult();
    if (result !== undefined)
      throw exitedBeforeLockState(description, watchedProcess, result);
  }
}

function terminalRaces(watchedProcesses) {
  return watchedProcesses.map((watchedProcess) =>
    watchedProcess.handle.unavailable.then((result) => ({
      watchedProcess,
      result,
    })),
  );
}

function throwIfProcessEnded(description, outcome) {
  if (outcome !== undefined)
    throw exitedBeforeLockState(
      description,
      outcome.watchedProcess,
      outcome.result,
    );
}

export async function waitForMigration89LockState({
  description,
  lockSnapshot,
  predicate,
  watchedProcesses = [],
  timeoutMs = 15_000,
  pollIntervalMs = 20,
}) {
  const waitTimeoutMs = boundedMilliseconds(timeoutMs, 600_000);
  const intervalMs = boundedMilliseconds(pollIntervalMs, waitTimeoutMs);
  const deadline = performance.now() + waitTimeoutMs;
  let snapshot = Object.freeze({ locks: Object.freeze([]) });
  while (performance.now() < deadline) {
    assertProcessesLive(description, watchedProcesses);
    const snapshotTimeoutMs = Math.max(
      1,
      Math.ceil(deadline - performance.now()),
    );
    snapshot = lockSnapshot(snapshotTimeoutMs);
    assertProcessesLive(description, watchedProcesses);
    if (performance.now() >= deadline) break;
    const matched = predicate(snapshot);
    assertProcessesLive(description, watchedProcesses);
    if (matched) {
      if (performance.now() >= deadline) break;
      const outcome = await Promise.race([
        yieldToProcessEvents().then(() => undefined),
        ...terminalRaces(watchedProcesses),
      ]);
      throwIfProcessEnded(description, outcome);
      assertProcessesLive(description, watchedProcesses);
      if (performance.now() >= deadline) break;
      return snapshot;
    }

    const remainingMs = Math.max(0, deadline - performance.now());
    const outcome = await Promise.race([
      delay(Math.min(intervalMs, remainingMs)).then(() => undefined),
      ...terminalRaces(watchedProcesses),
    ]);
    throwIfProcessEnded(description, outcome);
  }
  assertProcessesLive(description, watchedProcesses);
  throw new Error(
    `migration89_lock_state_not_observed:${description}:${JSON.stringify(snapshot)}`,
  );
}
