#!/usr/bin/env node
/* global fetch */
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { platform } from "node:os";

const args = parseArgs(process.argv.slice(2));
const webUrl = normalizeUrl(args["web-url"] ?? "https://reviewrouter.site");
const apiUrl = normalizeUrl(args["api-url"] ?? "https://api.reviewrouter.site");
const appName = String(args.name ?? "ReviewRouter");
const owner = args.owner ? String(args.owner) : "";
const port = Number(args.port ?? 45731);
const host = "127.0.0.1";
const callbackUrl = `http://${host}:${port}/callback`;
const state = randomBytes(24).toString("base64url");
const outputDir = resolve(
  String(args["output-dir"] ?? ".local-secrets/github-apps"),
);
const reviewRouterLogoUrl = "https://i.imgur.com/Yz9XIQM.png";
const noOpen = Boolean(args["no-open"]);
const dryRun = Boolean(args["dry-run"]);
const permissionProfile = normalizePermissionProfile(
  args["permission-profile"] ?? "standard",
);

const manifest = {
  name: appName,
  url: webUrl,
  hook_attributes: {
    active: true,
    url: `${apiUrl}/webhooks/github`,
  },
  redirect_url: callbackUrl,
  callback_urls: [`${webUrl}/api/auth/callback/github`],
  setup_url: `${webUrl}/setup`,
  setup_on_update: true,
  request_oauth_on_install: false,
  default_events: [
    "check_run",
    "issue_comment",
    "pull_request",
    "push",
    "repository",
    "status",
    "workflow_job",
    "workflow_run",
  ],
  public: true,
  description:
    "ReviewRouter connects GitHub pull request review setup while reviews run in customer GitHub Actions.",
  default_permissions: {
    actions: "write",
    checks: "write",
    contents: "write",
    issues: "write",
    pull_requests: "write",
    secrets: "write",
    organization_secrets: "read",
    organization_plan: "read",
    statuses: "write",
    workflows: "write",
    ...(permissionProfile === "org-ruleset"
      ? { organization_administration: "write" }
      : {}),
  },
};

if (dryRun) {
  printPlan();
  console.log(JSON.stringify(manifest, null, 2));
  process.exit(0);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);
    if (url.pathname === "/start") {
      return sendHtml(response, renderStartPage());
    }
    if (url.pathname === "/callback") {
      return await handleCallback(url, response);
    }
    if (url.pathname === "/") {
      response.writeHead(302, { Location: "/start" });
      return response.end();
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    return response.end("Not found");
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end(error instanceof Error ? error.message : String(error));
  }
});

server.listen(port, host, () => {
  const startUrl = `http://${host}:${port}/start`;
  printPlan();
  console.log(
    `\nOpen this URL if the browser does not open automatically:\n${startUrl}\n`,
  );
  if (!noOpen) openUrl(startUrl);
});

async function handleCallback(url, response) {
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  if (!code) {
    return sendHtml(
      response,
      renderResultPage("GitHub did not return a manifest code.", "error"),
    );
  }
  if (returnedState !== state) {
    return sendHtml(
      response,
      renderResultPage("Invalid state returned by GitHub.", "error"),
    );
  }

  const conversion = await convertManifestCode(code);
  const saved = await saveGitHubAppProfile(conversion);
  sendHtml(
    response,
    renderResultPage(
      `GitHub App created. Local profile saved to ${escapeHtml(saved.envFile)}.`,
      "success",
    ),
  );
  printSavedSummary(conversion, saved);
  server.close();
}

async function convertManifestCode(code) {
  const response = await fetch(
    `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "reviewrouter-app-manifest-helper",
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `GitHub manifest conversion failed: HTTP ${response.status} ${JSON.stringify(body)}`,
    );
  }
  return body;
}

async function saveGitHubAppProfile(app) {
  const slug = String(app.slug ?? slugify(String(app.name ?? appName)));
  const pem = String(app.pem ?? "");
  if (!pem.includes("BEGIN") || !pem.includes("PRIVATE KEY")) {
    throw new Error("GitHub response did not include a PEM private key.");
  }

  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const pemFile = join(outputDir, `${slug}.private-key.pem`);
  const envFile = join(outputDir, `${slug}.env`);
  await writeFile(pemFile, pem, { mode: 0o600 });
  await writeFile(envFile, renderEnvProfile(app, pemFile), { mode: 0o600 });
  return { envFile, pemFile, slug };
}

function renderEnvProfile(app, pemFile) {
  return [
    `GITHUB_APP_ID=${shellQuote(String(app.id ?? ""))}`,
    `GITHUB_APP_CLIENT_ID=${shellQuote(String(app.client_id ?? ""))}`,
    `GITHUB_APP_CLIENT_SECRET=${shellQuote(String(app.client_secret ?? ""))}`,
    `GITHUB_APP_SLUG=${shellQuote(String(app.slug ?? ""))}`,
    `GITHUB_APP_PRIVATE_KEY_FILE=${shellQuote(pemFile)}`,
    `GITHUB_WEBHOOK_SECRET=${shellQuote(String(app.webhook_secret ?? ""))}`,
    `GITHUB_CLIENT_ID=${shellQuote(String(app.client_id ?? ""))}`,
    `GITHUB_CLIENT_SECRET=${shellQuote(String(app.client_secret ?? ""))}`,
    `REVIEW_ROUTER_WEB_URL=${shellQuote(webUrl)}`,
    `REVIEW_ROUTER_API_URL=${shellQuote(apiUrl)}`,
    "",
  ].join("\n");
}

function renderStartPage() {
  const action = owner
    ? `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new?state=${encodeURIComponent(state)}`
    : `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Create ReviewRouter GitHub App</title>
    <style>
      body { background: #0a0a0f; color: #e0e6ff; font-family: ui-sans-serif, system-ui, sans-serif; display: grid; min-height: 100vh; place-items: center; }
      main { max-width: 720px; padding: 32px; border: 1px solid rgba(0,240,255,.2); border-radius: 24px; background: rgba(255,255,255,.05); box-shadow: 0 30px 90px rgba(0,0,0,.45); }
      button { width: 100%; min-height: 56px; border: 0; border-radius: 16px; color: #0a0a0f; font-weight: 800; font-size: 16px; background: linear-gradient(135deg,#00f0ff,#ff00ff); cursor: pointer; }
      code { color: #9ffcff; }
    </style>
  </head>
  <body>
    <main>
      <h1>Create ${escapeHtml(appName)} GitHub App</h1>
      <p>This page will submit a GitHub App manifest to GitHub. The script will receive the temporary code on <code>${escapeHtml(callbackUrl)}</code> and save the generated local profile.</p>
      <form action="${escapeHtml(action)}" method="post">
        <input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}" />
        <button type="submit">Continue to GitHub</button>
      </form>
    </main>
  </body>
</html>`;
}

function renderResultPage(message, tone) {
  const color = tone === "success" ? "#39ff14" : "#ff6b6b";
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>ReviewRouter GitHub App</title></head>
  <body style="background:#0a0a0f;color:#e0e6ff;font-family:ui-sans-serif,system-ui,sans-serif;display:grid;min-height:100vh;place-items:center;">
    <main style="max-width:720px;padding:32px;border:1px solid ${color};border-radius:24px;background:rgba(255,255,255,.05);">
      <h1 style="color:${color};">${tone === "success" ? "Done" : "Failed"}</h1>
      <p>${escapeHtml(message)}</p>
      <p>You can close this tab.</p>
    </main>
  </body>
</html>`;
}

function printPlan() {
  console.log("ReviewRouter GitHub App manifest helper");
  console.log(`App name: ${appName}`);
  console.log(`Owner: ${owner || "personal account"}`);
  console.log(`Web URL: ${webUrl}`);
  console.log(`API URL: ${apiUrl}`);
  console.log(`Callback URL: ${webUrl}/api/auth/callback/github`);
  console.log(`Setup URL: ${webUrl}/setup`);
  console.log(`Webhook URL: ${apiUrl}/webhooks/github`);
  console.log(`Permission profile: ${permissionProfile}`);
  console.log(`Output dir: ${outputDir}`);
}

function printSavedSummary(app, saved) {
  console.log("\nCreated GitHub App:");
  console.log(`Name: ${app.name ?? appName}`);
  console.log(`Slug: ${saved.slug}`);
  console.log(`App ID: ${app.id}`);
  console.log(`Client ID: ${app.client_id}`);
  console.log(
    `App URL: ${app.html_url ?? `https://github.com/apps/${saved.slug}`}`,
  );
  console.log(
    `Install URL: https://github.com/apps/${saved.slug}/installations/new`,
  );
  console.log(`Settings URL: ${buildAppSettingsUrl(app, saved.slug)}`);
  console.log("\nSaved local files:");
  console.log(`Env profile: ${saved.envFile}`);
  console.log(`Private key: ${saved.pemFile}`);
  console.log("\nOptional logo:");
  console.log(
    `Upload this image in GitHub App settings: ${reviewRouterLogoUrl}`,
  );
  console.log("\nRender env source:");
  console.log(
    `REVIEW_ROUTER_HOSTED_ENV_FILE=${saved.envFile} pnpm hosted:check`,
  );
  console.log("\nSecrets were saved locally only and were not printed.");
}

function sendHtml(response, html) {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
}

function openUrl(url) {
  const command =
    platform() === "darwin"
      ? "open"
      : platform() === "win32"
        ? "cmd"
        : "xdg-open";
  const commandArgs = platform() === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, commandArgs, {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
}

function normalizeUrl(value) {
  return String(value).replace(/\/$/, "");
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (key === "no-open" || key === "dry-run") {
      parsed[key] = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function normalizePermissionProfile(value) {
  const normalized = String(value).trim();
  if (normalized === "standard" || normalized === "org-ruleset") {
    return normalized;
  }
  throw new Error(
    "--permission-profile must be either standard or org-ruleset",
  );
}

function shellQuote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildAppSettingsUrl(app, slug) {
  const safeSlug = encodeURIComponent(slug);
  const appOwner = String(app.owner?.login ?? owner ?? "").trim();
  if (appOwner && owner) {
    return `https://github.com/organizations/${encodeURIComponent(appOwner)}/settings/apps/${safeSlug}`;
  }
  return `https://github.com/settings/apps/${safeSlug}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
