#!/usr/bin/env node
/* global fetch */
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const port = Number(process.env.REVIEW_ROUTER_API_SMOKE_PORT ?? 4100);
const apiUrl = `http://127.0.0.1:${port}/health`;
const apiSmokeTimeoutMs = Number(
  process.env.REVIEW_ROUTER_API_SMOKE_TIMEOUT_MS ?? 45_000,
);
const workerSmokeTimeoutMs = Number(
  process.env.REVIEW_ROUTER_WORKER_SMOKE_TIMEOUT_MS ?? 20_000,
);

await checkApi();
await checkWorker();

console.log("Production runtime smoke passed for API and worker.");

async function checkApi() {
  const output = [];
  const child = spawn("pnpm", ["api:start"], {
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));

  try {
    const deadline = Date.now() + apiSmokeTimeoutMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        fail(`compiled API exited with code ${child.exitCode}`, output);
      }

      try {
        const response = await fetch(apiUrl);
        if (response.ok) {
          const body = await response.json();
          if (body?.status !== "ok") {
            fail(`compiled API health status was ${body?.status}`, output);
          }
          return;
        }
      } catch {
        // Server is still starting.
      }

      await delay(250);
    }

    fail(
      `compiled API did not become healthy within ${apiSmokeTimeoutMs}ms`,
      output,
    );
  } finally {
    await terminateProcessGroup(child);
  }
}

async function checkWorker() {
  const output = [];
  const child = spawn("pnpm", ["worker:start"], {
    env: {
      ...process.env,
      REVIEW_ROUTER_WORKER_ONCE: "1",
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));

  const exitCode = await waitForExit(child, workerSmokeTimeoutMs);
  if (exitCode === "timeout") {
    await terminateProcessGroup(child);
    fail(
      `compiled worker did not exit within ${workerSmokeTimeoutMs}ms`,
      output,
    );
  }
  if (exitCode !== 0) {
    fail(`compiled worker exited with code ${exitCode}`, output);
  }
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) {
    return child.exitCode;
  }
  if (child.signalCode !== null) {
    return 1;
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve("timeout"), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code ?? 1);
    });
  });
}

async function terminateProcessGroup(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  signalChild(child, "SIGTERM");
  const gracefulExit = await waitForExit(child, 3_000);
  if (
    gracefulExit === "timeout" &&
    child.exitCode === null &&
    child.signalCode === null
  ) {
    signalChild(child, "SIGKILL");
    await waitForExit(child, 1_000);
  }
}

function signalChild(child, signal) {
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // The process may already have exited between checks.
  }

  try {
    child.kill(signal);
  } catch {
    // The process may already have exited between checks.
  }
}

function fail(message, output) {
  console.error(`ERROR: ${message}`);
  console.error(output.join("").slice(-4000));
  process.exit(1);
}
