#!/usr/bin/env node
/* global fetch */
import { loadEnvFile } from "./lib/env-file.mjs";

const hostedEnvFile =
  process.env.REVIEW_ROUTER_HOSTED_ENV_FILE ||
  process.env.REVIEW_ROUTER_WEB_ENV_FILE ||
  ".env.local";
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
assertIncludes(dashboard.html, "GitHub setup", "dashboard missing setup hero");
assertIncludes(
  dashboard.html,
  "Install GitHub App",
  "dashboard missing install CTA",
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

const installUrls = uniqueMatches(
  dashboard.html,
  /https:\/\/github\.com\/apps\/[^"'\\\s]+\/installations\/new/g,
);
if (installUrls.length === 0) {
  throw new Error("dashboard does not include a GitHub App install URL");
}
if (expectedAppSlug) {
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
  "Installation ID: 123",
  "install redirect notice missing installation id",
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
assertIncludes(
  installNotice.html,
  "callbackUrl=%2Fsetup%3Finstallation_id%3D123%26setup_action%3Dinstall",
  "install redirect sign-in must return users to the setup handoff page",
);
assertIncludes(
  installNotice.html,
  "One sign-in finishes the handoff.",
  "install redirect dashboard must show sign-in as the next onboarding step",
);
assertNotIncludes(
  installNotice.html,
  "Choose only the repositories to review.",
  "install redirect dashboard must not ask users to install the App again",
);
assertBefore(
  installNotice.html,
  "GitHub App installed",
  "Finish repository setup.",
  "install redirect notice should appear before onboarding hero",
);

const invalidNotice = await fetchHtml(
  "/setup?installation_id=abc&setup_action=install",
);
assertNotIncludes(
  invalidNotice.html,
  "Installation ID: abc",
  "invalid installation id must not be rendered",
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
