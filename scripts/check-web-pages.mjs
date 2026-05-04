#!/usr/bin/env node
/* global fetch */
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const configuredWebUrl = (
  process.env.REVIEW_ROUTER_WEB_URL || "http://localhost:3000"
).replace(/\/$/, "");
const codexInstallerUrl = `${configuredWebUrl}/install/codex`;
const configuredApiUrl = (
  process.env.REVIEW_ROUTER_WEB_SMOKE_EXPECTED_API_URL ??
  "https://reviewrouter-api.onrender.com"
).replace(/\/$/, "");
const apiDemoUrl = `${configuredApiUrl}/docs`;

const commonTexts = [
  "ReviewRouter",
  "Getting started",
  "Dashboard",
  "Security",
  "Support",
  "API demo",
];

const pages = [
  [
    "/",
    ["Review routing for AI pull request checks", "View API demo", apiDemoUrl],
  ],
  ["/dashboard", ["GitHub setup", "Install GitHub App"]],
  [
    "/getting-started",
    [
      "Getting started",
      `curl -fsSL ${codexInstallerUrl} | REVIEW_ROUTER_CONFIRM_WRITE=1 REVIEW_ROUTER_REPO=owner/repo bash`,
      `curl -fsSL ${codexInstallerUrl} | REVIEW_ROUTER_CONFIRM_WRITE=1 REVIEW_ROUTER_SECRET_SCOPE=org REVIEW_ROUTER_ORG=acme REVIEW_ROUTER_ORG_SECRET_REPOS=repo-a,repo-b bash`,
    ],
  ],
  [
    "/security",
    [
      "Designed to avoid code and secret custody",
      `curl -fsSL ${codexInstallerUrl} | REVIEW_ROUTER_CONFIRM_WRITE=1 REVIEW_ROUTER_REPO=owner/repo bash`,
    ],
  ],
  ["/fair-use", ["Fair use"]],
  ["/disconnect", ["Disconnect"]],
  ["/privacy", ["Privacy draft"]],
  ["/terms", ["Terms draft"]],
  ["/status", ["Hosted API demo is live", apiDemoUrl]],
  ["/support", ["Trusted beta support"]],
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

  for (const [path, expectedTexts] of pages) {
    const url = `${baseUrl}${path}`;
    const response = await fetch(url);
    if (!response.ok) {
      await fail(`${path} returned HTTP ${response.status}`);
    }

    const html = await response.text();
    for (const expectedText of commonTexts) {
      if (!html.includes(expectedText)) {
        await fail(
          `${path} did not include shared navigation text: ${expectedText}`,
        );
      }
    }
    for (const expectedText of expectedTexts) {
      if (!html.includes(expectedText)) {
        await fail(`${path} did not include expected text: ${expectedText}`);
      }
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
