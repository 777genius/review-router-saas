#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { App } from "@octokit/app";
import { loadEnvFile } from "./lib/env-file.mjs";

const envFile = process.env.REVIEW_ROUTER_GITHUB_APP_ENV_FILE || ".env.local";
const env = loadEnvFile(envFile, process.env);
const expectedRepo = String(
  env.REVIEW_ROUTER_GITHUB_APP_EXPECT_REPO ?? "",
).trim();
const checkMode = String(
  env.REVIEW_ROUTER_GITHUB_APP_CHECK_MODE ?? "local",
).trim();
const requireHostedWebhooks =
  checkMode === "hosted" ||
  isTrue(env.REVIEW_ROUTER_GITHUB_APP_REQUIRE_HOSTED_WEBHOOKS);

const requiredPermissions = {
  contents: "write",
  workflows: "write",
  pull_requests: "write",
  issues: "write",
  metadata: "read",
};
const requiredWebhookEvents = ["installation", "installation_repositories"];

const errors = [];
const warnings = [];

const appId = requireValue("GITHUB_APP_ID");
const appSlug = requireValue("GITHUB_APP_SLUG");
const privateKey = readPrivateKey();
let diagnostics = null;

if (errors.length === 0) {
  try {
    await checkGitHubApp();
  } catch (error) {
    errors.push(`GitHub App API check failed: ${safeErrorMessage(error)}`);
  }
}

if (errors.length > 0) {
  console.error("ReviewRouter GitHub App readiness failed:");
  for (const error of errors) console.error(`- ${error}`);
  printFixHints();
  if (warnings.length > 0) {
    console.error("Warnings:");
    for (const warning of warnings) console.error(`- ${warning}`);
  }
  process.exit(1);
}

async function checkGitHubApp() {
  const app = new App({ appId, privateKey });
  const { data: appData } = await app.octokit.request("GET /app");
  const actualId = String(appData.id);
  const actualSlug = String(appData.slug ?? "");

  if (actualId !== String(appId)) {
    errors.push(
      `GITHUB_APP_ID does not match authenticated App id ${actualId}.`,
    );
  }
  if (actualSlug && actualSlug !== appSlug) {
    errors.push(
      `GITHUB_APP_SLUG does not match authenticated App slug ${actualSlug}.`,
    );
  }
  assertPermissions(appData.permissions ?? {});
  assertWebhookEvents(appData.events ?? []);

  const installations = await listInstallations(app);
  if (installations.length === 0) {
    warnings.push(
      "GitHub App has no installations. Install it on at least one test repository before setup PR E2E.",
    );
  }

  let expectedRepoInstallation = null;
  if (expectedRepo) {
    expectedRepoInstallation = await findInstallationForRepo(
      app,
      installations,
      expectedRepo,
    );
    if (!expectedRepoInstallation) {
      errors.push(
        `GitHub App is not installed on ${expectedRepo}, or the installation token cannot read that repository.`,
      );
    }
  }

  diagnostics = {
    ok: errors.length === 0,
    app: {
      id: actualId,
      slug: actualSlug || appSlug,
      owner: appData.owner?.login ?? null,
      ownerType: appData.owner?.type ?? null,
      permissions: pickPermissions(appData.permissions ?? {}),
      events: appData.events ?? [],
      settingsUrl: buildAppSettingsUrl(appData.owner, actualSlug || appSlug),
    },
    installations: installations.map((installation) => ({
      id: installation.id,
      account: installation.account?.login ?? null,
      accountType: installation.account?.type ?? null,
      repositorySelection: installation.repository_selection,
    })),
    expectedRepo: expectedRepo
      ? {
          fullName: expectedRepo,
          installationId: expectedRepoInstallation?.id ?? null,
        }
      : null,
    warnings,
  };

  if (errors.length === 0) {
    console.log(JSON.stringify(diagnostics, null, 2));
  }
}

function assertPermissions(actualPermissions) {
  for (const [permission, requiredAccess] of Object.entries(
    requiredPermissions,
  )) {
    const actualAccess = actualPermissions[permission];
    if (!permissionSatisfies(actualAccess, requiredAccess)) {
      errors.push(
        `GitHub App permission ${permission} must be ${requiredAccess}; current value is ${actualAccess ?? "missing"}.`,
      );
    }
  }
}

function assertWebhookEvents(actualEvents) {
  const actual = new Set(actualEvents);
  const missingEvents = requiredWebhookEvents.filter(
    (eventName) => !actual.has(eventName),
  );
  if (missingEvents.length === 0) {
    return;
  }

  const message = `GitHub App webhook events are missing: ${missingEvents.join(", ")}. Hosted lifecycle sync needs these events.`;
  if (requireHostedWebhooks) {
    errors.push(message);
  } else {
    warnings.push(
      `${message} Local setup PR E2E can still pass without webhooks.`,
    );
  }
}

function printFixHints() {
  const missingEventsError = errors.some((error) =>
    error.startsWith("GitHub App webhook events are missing:"),
  );
  if (!missingEventsError) {
    return;
  }

  const settingsUrl = diagnostics?.app?.settingsUrl || settingsUrlFromSlug();
  console.error("How to fix:");
  console.error(`- Open GitHub App settings: ${settingsUrl}`);
  console.error("- Go to Webhook.");
  console.error(
    "- Enable these events: Installation, Installation repositories.",
  );
  console.error(
    "- Re-run: REVIEW_ROUTER_GITHUB_APP_CHECK_MODE=hosted pnpm github-app:check",
  );
}

function permissionSatisfies(actualAccess, requiredAccess) {
  if (requiredAccess === "read") {
    return actualAccess === "read" || actualAccess === "write";
  }
  return actualAccess === requiredAccess;
}

function pickPermissions(permissions) {
  return Object.fromEntries(
    Object.keys(requiredPermissions).map((permission) => [
      permission,
      permissions[permission] ?? null,
    ]),
  );
}

function buildAppSettingsUrl(owner, slug) {
  const safeSlug = encodeURIComponent(slug);
  if (owner?.type === "Organization" && owner.login) {
    return `https://github.com/organizations/${encodeURIComponent(owner.login)}/settings/apps/${safeSlug}`;
  }
  return `https://github.com/settings/apps/${safeSlug}`;
}

function settingsUrlFromSlug() {
  const slug = String(appSlug || "<github-app-slug>").trim();
  return `https://github.com/settings/apps/${encodeURIComponent(slug)}`;
}

async function listInstallations(app) {
  const installations = [];
  for (let page = 1; page <= 10; page += 1) {
    const { data } = await app.octokit.request("GET /app/installations", {
      per_page: 100,
      page,
    });
    installations.push(...data);
    if (data.length < 100) break;
  }
  return installations;
}

async function findInstallationForRepo(app, installations, repoFullName) {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo || repo.includes("/")) {
    errors.push(
      "REVIEW_ROUTER_GITHUB_APP_EXPECT_REPO must be owner/repo when set.",
    );
    return null;
  }

  for (const installation of installations) {
    const installationOctokit = await app.getInstallationOctokit(
      installation.id,
    );
    try {
      await installationOctokit.request("GET /repos/{owner}/{repo}", {
        owner,
        repo,
      });
      return installation;
    } catch (error) {
      if (!isNotFoundOrForbidden(error)) throw error;
    }
  }
  return null;
}

function requireValue(name) {
  const value = String(env[name] ?? "").trim();
  if (!value) {
    errors.push(`${name} is required.`);
  }
  return value;
}

function readPrivateKey() {
  const inlineKey = String(env.GITHUB_APP_PRIVATE_KEY ?? "").trim();
  if (inlineKey) {
    return inlineKey.includes("\\n")
      ? inlineKey.replaceAll("\\n", "\n")
      : inlineKey;
  }

  const keyFile = String(env.GITHUB_APP_PRIVATE_KEY_FILE ?? "").trim();
  if (!keyFile) {
    errors.push(
      "GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_FILE is required.",
    );
    return "";
  }
  if (!existsSync(keyFile)) {
    errors.push(`GITHUB_APP_PRIVATE_KEY_FILE does not exist: ${keyFile}`);
    return "";
  }
  return readFileSync(keyFile, "utf8");
}

function isNotFoundOrForbidden(error) {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (Number(error.status) === 403 || Number(error.status) === 404)
  );
}

function isTrue(value) {
  return ["1", "true", "TRUE", "yes", "YES", "y", "Y"].includes(
    String(value ?? ""),
  );
}

function safeErrorMessage(error) {
  if (typeof error === "object" && error !== null && "status" in error) {
    return `HTTP ${Number(error.status)}`;
  }
  if (error instanceof Error) {
    return error.message.split("\n")[0] || "unknown_error";
  }
  return "unknown_error";
}
