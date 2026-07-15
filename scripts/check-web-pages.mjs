#!/usr/bin/env node
/* global fetch */
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const repoCodexCommandFragment =
  "/install/codex | REVIEW_ROUTER_CODEX_ROTATING_SETUP_URL";
const installCodexFragment = "/install/codex";
const setupNonceFragment = "short-lived setup nonce";
const rotatingCodexSecretFragment = "REVIEWROUTER_CODEX_AUTH_JSON";
const commonTexts = ["ReviewRouter", "Security", "Support"];
const landingHeroText = "Free privacy-first";

const pages = [
  [
    "/",
    [
      landingHeroText,
      "AI code review",
      "that stays inside your CI",
      "Install GitHub App",
    ],
  ],
  [
    "/auth/signin",
    [
      "Sign in to ReviewRouter",
      "Continue with GitHub",
      "No secrets stored here",
    ],
  ],
  [
    "/auth/signin?error=OAuthCallback",
    ["Finish dashboard sign-in", "GitHub returned from the App installation"],
  ],
  ["/dashboard", []],
  ["/setup", ["Set up ReviewRouter", "Already installed? Sign in"]],
  [
    "/getting-started",
    [
      "Getting started",
      "curl -fsSL ",
      repoCodexCommandFragment,
      rotatingCodexSecretFragment,
    ],
  ],
  [
    "/security",
    [
      "Code and secrets stay under your control",
      installCodexFragment,
      setupNonceFragment,
      rotatingCodexSecretFragment,
    ],
  ],
  ["/fair-use", ["Fair use"]],
  ["/disconnect", ["Disconnect"]],
  ["/privacy", ["Privacy"]],
  ["/terms", ["Terms"]],
  ["/support", ["Trusted beta support"]],
];

const redirectChecks = [
  ["/status", "/support"],
  [
    "/install/codex",
    "https://raw.githubusercontent.com/777genius/review-router/main/scripts/seed-codex-rotating-auth.sh",
  ],
  [
    "/install/codex-reseed",
    "https://raw.githubusercontent.com/777genius/review-router/main/scripts/reseed-codex-rotating-auth.sh",
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
  if ([301, 302, 303, 307, 308].includes(dashboardPostInstallResponse.status)) {
    const dashboardPostInstallLocation =
      dashboardPostInstallResponse.headers.get("location") ?? "";
    assertIncludes(
      dashboardPostInstallLocation,
      "installation_id=123",
      "dashboard post-install redirect should preserve installation id",
    );
    assertIncludes(
      dashboardPostInstallLocation,
      "setup_action=install",
      "dashboard post-install redirect should preserve setup action",
    );
  } else if (dashboardPostInstallResponse.ok) {
    const dashboardPostInstallHtml = await dashboardPostInstallResponse.text();
    assertIncludesAny(
      dashboardPostInstallHtml,
      [
        landingHeroText,
        "Finish ReviewRouter setup",
        "Manage repository review rollout",
        "ReviewRouter is a metadata control plane",
      ],
      "dashboard post-install should render landing, setup handoff, dashboard, or signed-out metadata shell",
    );
    assertNotIncludes(
      dashboardPostInstallHtml,
      "This page couldn",
      "dashboard post-install should not render an error page",
    );
  } else {
    await fail(
      `/dashboard post-install returned HTTP ${dashboardPostInstallResponse.status}`,
    );
  }

  const dashboardCleanResponse = await fetch(
    `${baseUrl}/dashboard?workspace=777genius&section=repositories&notice=app_installed&installation_id=123`,
    { redirect: "manual" },
  );
  if ([301, 302, 303, 307, 308].includes(dashboardCleanResponse.status)) {
    const dashboardCleanLocation =
      dashboardCleanResponse.headers.get("location") ?? "";
    assertIncludes(
      dashboardCleanLocation,
      "/dashboard?",
      "stale install query should stay on dashboard",
    );
    assertIncludes(
      dashboardCleanLocation,
      "workspace=777genius",
      "stale install query should preserve workspace",
    );
    if (dashboardCleanLocation.includes("installation_id=")) {
      await fail("stale install query should drop installation_id");
    }
  } else if (dashboardCleanResponse.ok) {
    const dashboardCleanHtml = await dashboardCleanResponse.text();
    assertIncludesAny(
      dashboardCleanHtml,
      [
        landingHeroText,
        "Manage repository review rollout",
        "ReviewRouter is a metadata control plane",
      ],
      "stale install query should render landing, dashboard, or signed-out metadata shell",
    );
    assertNotIncludes(
      dashboardCleanHtml,
      "This page couldn",
      "stale install query should not render an error page",
    );
  } else {
    await fail(
      `/dashboard stale install query returned HTTP ${dashboardCleanResponse.status}`,
    );
  }

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
    "Finish ReviewRouter setup",
    "post-install dashboard did not show the setup handoff title",
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
  assertIncludesAny(
    setupPrDashboardHtml,
    [
      landingHeroText,
      "Manage repository review rollout",
      "ReviewRouter is a metadata control plane",
    ],
    "dashboard setup PR notice should render landing or dashboard",
  );
  assertNotIncludes(
    setupPrDashboardHtml,
    "This page couldn",
    "dashboard setup PR notice should not render an error page when no workspace exists",
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
  assertIncludesAny(
    syncDashboardHtml,
    [
      landingHeroText,
      "Manage repository review rollout",
      "ReviewRouter is a metadata control plane",
    ],
    "dashboard sync notice should render landing or dashboard",
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

function assertIncludesAny(input, expectedOptions, message) {
  if (!expectedOptions.some((expected) => input.includes(expected))) {
    throw new Error(
      `${message}: expected one of ${expectedOptions.join(", ")}`,
    );
  }
}

function assertNotIncludes(input, expected, message) {
  if (input.includes(expected)) {
    throw new Error(`${message}: unexpected ${expected}`);
  }
}
