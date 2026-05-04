#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { App } from "@octokit/app";
import { loadEnvFile } from "./lib/env-file.mjs";

const envFile = process.env.REVIEW_ROUTER_GITHUB_APP_ENV_FILE || ".env.local";
const env = loadEnvFile(envFile, process.env);
const expectedRepo = String(
  env.REVIEW_ROUTER_GITHUB_APP_EXPECT_REPO ?? "",
).trim();

const errors = [];
const warnings = [];

const appId = requireValue("GITHUB_APP_ID");
const appSlug = requireValue("GITHUB_APP_SLUG");
const privateKey = readPrivateKey();

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

  console.log(
    JSON.stringify(
      {
        ok: errors.length === 0,
        app: {
          id: actualId,
          slug: actualSlug || appSlug,
          owner: appData.owner?.login ?? null,
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
      },
      null,
      2,
    ),
  );
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

function safeErrorMessage(error) {
  if (typeof error === "object" && error !== null && "status" in error) {
    return `HTTP ${Number(error.status)}`;
  }
  if (error instanceof Error) {
    return error.message.split("\n")[0] || "unknown_error";
  }
  return "unknown_error";
}
