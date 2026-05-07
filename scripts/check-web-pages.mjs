#!/usr/bin/env node
/* global fetch */
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const repoCodexCommandFragment =
  "/install/codex | REVIEW_ROUTER_CONFIRM_WRITE=1 REVIEW_ROUTER_REPO=owner/repo bash";
const orgCodexCommandFragment =
  "/install/codex | REVIEW_ROUTER_CONFIRM_WRITE=1 REVIEW_ROUTER_SECRET_SCOPE=org REVIEW_ROUTER_ORG=acme REVIEW_ROUTER_ORG_SECRET_REPOS=repo-a,repo-b bash";
const commonTexts = ["ReviewRouter", "Dashboard", "Security", "Support"];

const pages = [
  ["/", ["AI pull request review that runs in your CI", "Install GitHub App"]],
  [
    "/auth/signin",
    ["Sign in to ReviewRouter", "Continue with GitHub", "No secret custody"],
  ],
  [
    "/auth/signin?error=OAuthCallback",
    [
      "GitHub did not complete sign-in",
      "GitHub returned an OAuth callback error",
    ],
  ],
  ["/dashboard", ["GitHub setup"]],
  ["/setup", ["Finish repository setup", "One sign-in finishes the handoff"]],
  [
    "/getting-started",
    [
      "Getting started",
      "curl -fsSL ",
      repoCodexCommandFragment,
      orgCodexCommandFragment,
    ],
  ],
  [
    "/security",
    ["Designed to avoid code and secret custody", repoCodexCommandFragment],
  ],
  ["/fair-use", ["Fair use"]],
  ["/disconnect", ["Disconnect"]],
  ["/privacy", ["Privacy"]],
  ["/terms", ["Terms"]],
  ["/status", ["Hosted demo is live", "API demo"]],
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

  const dashboardPostInstallResponse = await fetch(
    `${baseUrl}/dashboard?installation_id=123&setup_action=install`,
    { redirect: "manual" },
  );
  if (!dashboardPostInstallResponse.ok) {
    await fail(
      `/dashboard post-install returned HTTP ${dashboardPostInstallResponse.status}`,
    );
  }
  const dashboardPostInstallHtml = await dashboardPostInstallResponse.text();
  assertIncludes(
    dashboardPostInstallHtml,
    "GitHub App installed",
    "dashboard post-install should keep the App install handoff visible",
  );
  assertIncludes(
    dashboardPostInstallHtml,
    "Sign in with GitHub",
    "dashboard post-install should show sign-in as the next action when signed out",
  );

  const postInstallResponse = await fetch(
    `${baseUrl}/setup?installation_id=123&setup_action=install`,
  );
  if (!postInstallResponse.ok) {
    await fail(
      `/setup post-install returned HTTP ${postInstallResponse.status}`,
    );
  }
  const postInstallHtml = await postInstallResponse.text();
  assertIncludes(
    postInstallHtml,
    "GitHub App installed",
    "post-install dashboard did not include install notice",
  );
  assertIncludes(
    postInstallHtml,
    "Sign in with GitHub",
    "post-install dashboard did not include primary sign-in CTA",
  );
  assertIncludes(
    postInstallHtml,
    "GitHub confirmed the App install",
    "post-install dashboard did not clearly explain the App is installed",
  );
  assertIncludes(
    postInstallHtml,
    "Installation #",
    "post-install dashboard did not expose installation metadata as a small chip",
  );
  assertIncludes(
    postInstallHtml,
    "123",
    "post-install dashboard did not include the GitHub installation id",
  );
  assertNotIncludes(
    postInstallHtml,
    "Installation ID: 123",
    "post-install dashboard should not put raw installation ids in the main copy",
  );
  assertIncludes(
    postInstallHtml,
    "Sign in to finish setup",
    "post-install dashboard did not show sign-in as the next onboarding step",
  );
  assertNotIncludes(
    postInstallHtml,
    "Choose only the repositories to review.",
    "post-install dashboard should not ask users to install the App again",
  );
  assertNotIncludes(
    postInstallHtml,
    "Install or manage App",
    "post-install dashboard should not show install as the primary next action",
  );
  assertNotIncludes(
    postInstallHtml,
    "Search synced App repositories",
    "setup should not contain repository management",
  );
  assertNotIncludes(
    postInstallHtml,
    "Provider secrets",
    "setup should not contain provider secret management",
  );
  assertBefore(
    postInstallHtml,
    "GitHub App installed",
    "Finish repository setup.",
    "post-install notice should appear before onboarding hero",
  );

  const authSignInRedirectResponse = await fetch(
    `${baseUrl}/api/auth/signin?callbackUrl=%2Fdashboard`,
    { redirect: "manual" },
  );
  if (![301, 302, 303, 307, 308].includes(authSignInRedirectResponse.status)) {
    await fail(
      `/api/auth/signin returned HTTP ${authSignInRedirectResponse.status}; expected redirect to branded sign-in page`,
    );
  }
  const authSignInRedirectLocation =
    authSignInRedirectResponse.headers.get("location");
  if (
    !authSignInRedirectLocation?.startsWith(
      `${baseUrl}/auth/signin?callbackUrl=`,
    ) &&
    !authSignInRedirectLocation?.startsWith("/auth/signin?callbackUrl=")
  ) {
    await fail(
      `/api/auth/signin redirected to ${authSignInRedirectLocation}; expected /auth/signin`,
    );
  }

  const setupPrDashboardResponse = await fetch(
    `${baseUrl}/dashboard?notice=setup_pr_ready&repository=owner%2Frepo&pr=https%3A%2F%2Fgithub.com%2Fowner%2Frepo%2Fpull%2F1`,
  );
  if (!setupPrDashboardResponse.ok) {
    await fail(
      `/dashboard setup PR notice returned HTTP ${setupPrDashboardResponse.status}`,
    );
  }
  const setupPrDashboardHtml = await setupPrDashboardResponse.text();
  assertIncludes(
    setupPrDashboardHtml,
    "Setup PR ready",
    "dashboard setup PR notice should use a specific success title",
  );
  assertNotIncludes(
    setupPrDashboardHtml,
    ">Done<",
    "dashboard setup PR notice should not use a generic Done label",
  );

  const syncDashboardResponse = await fetch(
    `${baseUrl}/dashboard?notice=sync_requested`,
  );
  if (!syncDashboardResponse.ok) {
    await fail(
      `/dashboard sync notice returned HTTP ${syncDashboardResponse.status}`,
    );
  }
  const syncDashboardHtml = await syncDashboardResponse.text();
  assertIncludes(
    syncDashboardHtml,
    "Reload in a few seconds",
    "dashboard sync notice should give customer-facing next steps",
  );
  assertNotIncludes(
    syncDashboardHtml,
    "Run the worker",
    "dashboard sync notice must not expose internal worker language",
  );

  const setupSyncNoticeResponse = await fetch(
    `${baseUrl}/setup?notice=sync_requested`,
  );
  if (!setupSyncNoticeResponse.ok) {
    await fail(
      `/setup sync notice returned HTTP ${setupSyncNoticeResponse.status}`,
    );
  }
  const setupSyncNoticeHtml = await setupSyncNoticeResponse.text();
  assertIncludes(
    setupSyncNoticeHtml,
    "GitHub metadata catches up",
    "setup sync notice should use customer-facing copy",
  );
  assertNotIncludes(
    setupSyncNoticeHtml,
    "worker processes the event",
    "setup sync notice must not expose worker internals",
  );

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

function assertIncludes(input, expected, message) {
  if (!input.includes(expected)) {
    throw new Error(`${message}: expected to find ${expected}`);
  }
}

function assertNotIncludes(input, expected, message) {
  if (input.includes(expected)) {
    throw new Error(`${message}: unexpected ${expected}`);
  }
}

function assertBefore(input, first, second, message) {
  const firstIndex = input.indexOf(first);
  const secondIndex = input.indexOf(second);
  if (firstIndex === -1 || secondIndex === -1 || firstIndex >= secondIndex) {
    throw new Error(`${message}: expected ${first} before ${second}`);
  }
}
