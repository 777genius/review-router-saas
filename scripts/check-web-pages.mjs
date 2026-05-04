#!/usr/bin/env node
/* global fetch */
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const pages = [
  ["/", "Review routing for AI pull request checks"],
  ["/dashboard", "Dashboard"],
  ["/getting-started", "Getting started"],
  ["/security", "Designed to avoid code and secret custody"],
  ["/fair-use", "Fair use"],
  ["/disconnect", "Disconnect"],
  ["/privacy", "Privacy draft"],
  ["/terms", "Terms draft"],
  ["/status", "Trusted beta is usable"],
  ["/support", "Trusted beta support"],
];

const redirectChecks = [
  [
    "/install/codex",
    "https://raw.githubusercontent.com/777genius/review-router/main/scripts/seed-codex-auth.sh",
  ],
];

const port = Number(process.env.REVIEW_ROUTER_WEB_SMOKE_PORT ?? 3300);
const baseUrl = `http://127.0.0.1:${port}`;
const output = [];

const child = spawn(
  "pnpm",
  [
    "--filter",
    "@reviewrouter/web",
    "exec",
    "next",
    "start",
    "-p",
    String(port),
  ],
  {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  },
);

child.stdout.on("data", (chunk) => output.push(chunk.toString()));
child.stderr.on("data", (chunk) => output.push(chunk.toString()));

const fail = async (message) => {
  child.kill("SIGTERM");
  await delay(250);
  if (!child.killed) child.kill("SIGKILL");
  console.error(`ERROR: ${message}`);
  console.error(output.join("").slice(-4000));
  process.exit(1);
};

const waitForServer = async () => {
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      await fail(`web smoke server exited with code ${child.exitCode}`);
    }

    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }

    await delay(250);
  }

  await fail("web smoke server did not become ready within 20s");
};

try {
  await waitForServer();

  for (const [path, expectedText] of pages) {
    const url = `${baseUrl}${path}`;
    const response = await fetch(url);
    if (!response.ok) {
      await fail(`${path} returned HTTP ${response.status}`);
    }

    const html = await response.text();
    if (!html.includes(expectedText)) {
      await fail(`${path} did not include expected text: ${expectedText}`);
    }
  }

  for (const [path, expectedLocation] of redirectChecks) {
    const response = await fetch(`${baseUrl}${path}`, { redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      await fail(`${path} returned HTTP ${response.status}; expected redirect`);
    }
    const location = response.headers.get("location");
    if (location !== expectedLocation) {
      await fail(
        `${path} redirected to ${location ?? "missing location"}; expected ${expectedLocation}`,
      );
    }
  }

  console.log(
    `Web page smoke passed for ${pages.length} pages and ${redirectChecks.length} redirects.`,
  );
} finally {
  child.kill("SIGTERM");
}
