#!/usr/bin/env node
/* global fetch */
import { loadEnvFile } from "./lib/env-file.mjs";

const hostedEnvFile =
  process.env.REVIEW_ROUTER_HOSTED_ENV_FILE ||
  process.env.REVIEW_ROUTER_WEB_ENV_FILE ||
  ".env.production";
const env = loadEnvFile(hostedEnvFile, process.env);

const webUrl = normalizeUrl(
  env.REVIEW_ROUTER_PUBLIC_WEB_URL ||
    env.REVIEW_ROUTER_HOSTED_WEB_URL ||
    process.env.REVIEW_ROUTER_PUBLIC_WEB_URL ||
    process.env.REVIEW_ROUTER_HOSTED_WEB_URL ||
    "https://reviewrouter.site",
);
const expectedAppSlug = String(
  env.REVIEW_ROUTER_EXPECTED_GITHUB_APP_SLUG || env.GITHUB_APP_SLUG || "",
).trim();

const dashboard = await fetchHtml("/dashboard");
assertIncludes(dashboard.html, "ReviewRouter", "dashboard missing product");
assertIncludesAny(
  dashboard.html,
  [
    "AI code review that stays inside your CI",
    "Manage repository review rollout",
    "ReviewRouter is a metadata control plane",
    "ReviewRouter is an open-source metadata control plane",
    "Metadata control plane for CI-native AI review",
  ],
  "dashboard missing landing or workspace hero",
);
assertIncludesAny(
  dashboard.html,
  ["Install GitHub App", "Start setup", "Sign in"],
  "dashboard missing install or sign-in CTA",
);
assertIncludes(
  dashboard.html,
  "/_next/static/",
  "dashboard missing Next static assets",
);
assertIncludes(
  dashboard.html,
  'rel="stylesheet"',
  "dashboard missing stylesheet link",
);

const signIn = await fetchHtml("/auth/signin");
assertIncludes(
  signIn.html,
  "Sign in to ReviewRouter",
  "sign-in missing branded title",
);
assertIncludes(
  signIn.html,
  "Continue with GitHub",
  "sign-in missing GitHub CTA",
);
const signInError = await fetchHtml("/auth/signin?error=OAuthCallback");
assertIncludes(
  signInError.html,
  "Finish dashboard sign-in",
  "sign-in error missing customer-facing title",
);
assertIncludes(
  signInError.html,
  "GitHub returned from the App installation",
  "sign-in error missing customer-facing guidance",
);

const installUrls = uniqueMatches(
  dashboard.html,
  /https:\/\/github\.com\/apps\/[^"'\\\s]+\/installations\/new/g,
);
if (installUrls.length === 0) {
  assertIncludesAny(
    dashboard.html,
    [
      "ReviewRouter is a metadata control plane",
      "ReviewRouter is an open-source metadata control plane",
      "Metadata control plane for CI-native AI review",
    ],
    "dashboard without install URL must render signed-out metadata shell",
  );
}
if (expectedAppSlug && installUrls.length > 0) {
  const expectedInstallUrl = `https://github.com/apps/${expectedAppSlug}/installations/new`;
  if (!installUrls.includes(expectedInstallUrl)) {
    throw new Error(
      `dashboard install URL mismatch; expected ${expectedInstallUrl}, observed ${installUrls.join(", ")}`,
    );
  }
}

await assertFirstStylesheetLoads(dashboard.html);

const installNotice = await fetchHtml(
  "/setup?installation_id=123&setup_action=install",
);
assertIncludes(
  installNotice.html,
  "GitHub App installed",
  "install redirect notice missing",
);
assertIncludes(
  installNotice.html,
  "Installation #",
  "install redirect notice missing installation metadata chip",
);
assertIncludes(
  installNotice.html,
  "123",
  "install redirect notice missing installation id",
);
assertNotIncludes(
  installNotice.html,
  "Installation ID: 123",
  "install redirect notice should not put raw installation ids in main copy",
);
assertIncludes(
  installNotice.html,
  "Sign in",
  "install redirect notice must guide signed-out users",
);
assertIncludes(
  installNotice.html,
  "Sign in with GitHub",
  "install redirect dashboard must promote sign-in over reinstall",
);
assertSetupCallback(installNotice.html);
assertIncludes(
  installNotice.html,
  "Finish ReviewRouter setup",
  "install redirect dashboard must show the setup handoff title",
);
assertNotIncludes(
  installNotice.html,
  "Choose only the repositories to review.",
  "install redirect dashboard must not ask users to install the App again",
);
const invalidNotice = await fetchHtml(
  "/setup?installation_id=abc&setup_action=install",
);
assertNotIncludes(
  invalidNotice.html,
  "Installation ID: abc",
  "invalid installation id must not be rendered",
);

const setupPrDashboardNotice = await fetchHtml(
  "/dashboard?notice=setup_pr_ready&repository=owner%2Frepo&pr=https%3A%2F%2Fgithub.com%2Fowner%2Frepo%2Fpull%2F1",
);
assertIncludesAny(
  setupPrDashboardNotice.html,
  [
    "AI code review that stays inside your CI",
    "Manage repository review rollout",
    "ReviewRouter is a metadata control plane",
    "ReviewRouter is an open-source metadata control plane",
    "Metadata control plane for CI-native AI review",
  ],
  "dashboard setup PR notice should render landing or dashboard",
);
assertNotIncludes(
  setupPrDashboardNotice.html,
  "This page couldn't load",
  "dashboard setup PR notice should not render an error page when signed out",
);

const syncDashboardNotice = await fetchHtml("/dashboard?notice=sync_requested");
assertIncludesAny(
  syncDashboardNotice.html,
  [
    "AI code review that stays inside your CI",
    "Manage repository review rollout",
    "ReviewRouter is a metadata control plane",
    "ReviewRouter is an open-source metadata control plane",
    "Metadata control plane for CI-native AI review",
  ],
  "dashboard sync notice should render landing or dashboard",
);
assertNotIncludes(
  syncDashboardNotice.html,
  "This page couldn't load",
  "dashboard sync notice should not render an error page when signed out",
);

const setupSyncNotice = await fetchHtml("/setup?notice=sync_requested");
assertIncludes(
  setupSyncNotice.html,
  "GitHub metadata catches up",
  "setup sync notice should give customer-facing next steps",
);
assertNotIncludes(
  setupSyncNotice.html,
  "worker processes the event",
  "setup sync notice must not expose worker internals",
);

console.log(
  JSON.stringify(
    {
      webUrl,
      dashboard: "ok",
      stylesheet: "ok",
      installUrl: expectedAppSlug ? `github_app:${expectedAppSlug}` : "ok",
      setupNotice: "ok",
    },
    null,
    2,
  ),
);

async function fetchHtml(path) {
  const response = await fetch(`${webUrl}${path}`, {
    headers: { accept: "text/html" },
  });
  const html = await response.text();
  if (!response.ok) {
    throw new Error(`${path} failed ${response.status}: ${html.slice(0, 160)}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) {
    throw new Error(`${path} returned ${contentType}; expected text/html`);
  }
  return { response, html };
}

async function assertFirstStylesheetLoads(html) {
  const stylesheet = html.match(
    /<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/,
  );
  if (!stylesheet?.[1]) {
    throw new Error("dashboard stylesheet href not found");
  }

  const href = stylesheet[1].startsWith("http")
    ? stylesheet[1]
    : `${webUrl}${stylesheet[1]}`;
  const response = await fetch(href, { headers: { accept: "text/css" } });
  if (!response.ok) {
    throw new Error(`dashboard stylesheet failed ${response.status}: ${href}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/css")) {
    throw new Error(
      `dashboard stylesheet returned ${contentType}; expected text/css`,
    );
  }
}

function normalizeUrl(url) {
  return String(url).replace(/\/+$/, "");
}

function uniqueMatches(input, regex) {
  return [...new Set(input.match(regex) ?? [])];
}

function assertIncludes(input, expected, message) {
  if (!input.includes(expected)) {
    throw new Error(`${message}: expected to find ${expected}`);
  }
}

function assertSetupCallback(input) {
  if (
    input.includes("callbackUrl") &&
    input.includes("/setup?installation_id=123") &&
    input.includes("setup_action=install")
  ) {
    return;
  }
  throw new Error(
    "install redirect sign-in must return users to the setup handoff page",
  );
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
