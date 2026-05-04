#!/usr/bin/env node
/* global fetch */
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const port = Number(process.env.REVIEW_ROUTER_API_SMOKE_PORT ?? 4100);
const apiUrl = `http://127.0.0.1:${port}/health`;

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
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));

  try {
    const deadline = Date.now() + 20_000;
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

    fail("compiled API did not become healthy within 20s", output);
  } finally {
    child.kill("SIGTERM");
    await delay(250);
  }
}

async function checkWorker() {
  const output = [];
  const child = spawn("pnpm", ["worker:start"], {
    env: {
      ...process.env,
      REVIEW_ROUTER_WORKER_ONCE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));

  const exitCode = await new Promise((resolve) => {
    child.on("exit", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) {
    fail(`compiled worker exited with code ${exitCode}`, output);
  }
}

function fail(message, output) {
  console.error(`ERROR: ${message}`);
  console.error(output.join("").slice(-4000));
  process.exit(1);
}
