#!/usr/bin/env node
/* global fetch, WebSocket */
import { spawn, execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const defaultRoutes = [
  "/",
  "/auth/signin",
  "/auth/signin?error=OAuthCallback",
  "/dashboard",
  "/setup",
  "/setup?installation_id=123&setup_action=install",
  "/getting-started",
  "/security",
  "/status",
  "/support",
  "/privacy",
  "/terms",
  "/fair-use",
  "/disconnect",
];

const defaultViewports = [
  { name: "mobile", width: 390, height: 1200, mobile: true },
  { name: "desktop", width: 1440, height: 1100, mobile: false },
];

const cli = parseCliArgs(process.argv.slice(2));
const routes =
  parseRoutes(cli.routes || process.env.REVIEW_ROUTER_UI_AUDIT_ROUTES) ??
  defaultRoutes;
const viewports =
  parseViewports(
    cli.viewports || process.env.REVIEW_ROUTER_UI_AUDIT_VIEWPORTS,
  ) ?? defaultViewports;
const baseUrl = normalizeUrl(
  cli.baseUrl ||
    process.env.REVIEW_ROUTER_UI_AUDIT_BASE_URL ||
    process.env.REVIEW_ROUTER_PUBLIC_WEB_URL ||
    process.env.REVIEW_ROUTER_WEB_URL ||
    "http://localhost:3000",
);
const outDir =
  cli.outDir ||
  process.env.REVIEW_ROUTER_UI_AUDIT_OUT_DIR ||
  `/tmp/reviewrouter-ui-audit-${Date.now()}`;
const chromePath = findChromePath();
const port = 9400 + Math.floor(Math.random() * 500);
const userDataDir = `/tmp/reviewrouter-chrome-${Date.now()}-${Math.random()
  .toString(16)
  .slice(2)}`;

if (!chromePath) {
  throw new Error(
    "Chrome was not found. Set CHROME_BIN to a Chrome or Chromium executable.",
  );
}

await mkdir(outDir, { recursive: true });
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);

try {
  await waitForChrome(port);
  const summary = [];

  for (const viewport of viewports) {
    for (const route of routes) {
      await assertRouteReachable(route);
      const entry = await auditRoute({ route, viewport });
      summary.push(entry);
    }
  }

  await writeFile(
    join(outDir, "summary.json"),
    JSON.stringify(summary, null, 2),
  );
  const issues = collectIssues(summary);

  if (issues.length > 0) {
    console.error(
      JSON.stringify(
        {
          baseUrl,
          outDir,
          pages: summary.length,
          issues,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  } else {
    console.log(
      JSON.stringify(
        {
          baseUrl,
          outDir,
          pages: summary.length,
          status: "ok",
        },
        null,
        2,
      ),
    );
  }
} finally {
  chrome.kill("SIGTERM");
  await delay(300);
  if (chrome.exitCode === null) chrome.kill("SIGKILL");
  await rm(userDataDir, { recursive: true, force: true }).catch(
    () => undefined,
  );
}

async function auditRoute({ route, viewport }) {
  const target = await fetchJson(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent("about:blank")}`,
    { method: "PUT" },
  );
  const client = await connectToCdp(target.webSocketDebuggerUrl);

  try {
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: viewport.mobile,
    });

    client.events.length = 0;
    await client.send("Page.navigate", { url: `${baseUrl}${route}` });
    await waitForLoadEvent(client);
    await delay(500);

    const audit = await client.send("Runtime.evaluate", {
      expression: getAuditExpression(),
      returnByValue: true,
    });
    const screenshot = await client.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    const screenshotPath = join(
      outDir,
      `${viewport.name}-${slugRoute(route)}.png`,
    );
    await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));

    return {
      route,
      viewport: viewport.name,
      screenshot: screenshotPath,
      ...audit.result.value,
    };
  } finally {
    client.ws.close();
    await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(
      () => undefined,
    );
  }
}

async function assertRouteReachable(route) {
  const url = `${baseUrl}${route}`;
  let response;
  try {
    response = await fetch(url, { headers: { accept: "text/html" } });
  } catch (error) {
    throw new Error(
      `UI audit target is not reachable: ${url}. Start the web server first or pass --base-url. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new Error(`UI audit target returned HTTP ${response.status}: ${url}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) {
    throw new Error(
      `UI audit target returned ${contentType || "unknown content type"}; expected text/html: ${url}`,
    );
  }
  const html = await response.text();
  if (!html.includes("ReviewRouter")) {
    throw new Error(
      `UI audit target does not look like ReviewRouter: ${url}. Check --base-url or stop the process using that port.`,
    );
  }
}

function collectIssues(summary) {
  const issues = [];

  for (const entry of summary) {
    if (!entry.h1?.length) {
      issues.push({
        type: "missing-h1",
        route: entry.route,
        viewport: entry.viewport,
      });
    }
    if (entry.documentWidth > entry.viewportWidth + 1) {
      issues.push({
        type: "document-overflow",
        route: entry.route,
        viewport: entry.viewport,
        documentWidth: entry.documentWidth,
        viewportWidth: entry.viewportWidth,
        overflow: entry.overflow.slice(0, 6),
      });
    }
    if (entry.smallTargets.length > 0) {
      issues.push({
        type: "small-targets",
        route: entry.route,
        viewport: entry.viewport,
        smallTargets: entry.smallTargets.slice(0, 10),
      });
    }
  }

  return issues;
}

function getAuditExpression() {
  return `(() => {
  const visible = (el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  const viewportWidth = document.documentElement.clientWidth;
  const documentWidth = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0);
  const overflow = [...document.querySelectorAll('*')]
    .filter(visible)
    .map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 100),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
      };
    })
    .filter((item) => item.right > viewportWidth + 1 || item.left < -1)
    .slice(0, 20);
  const smallTargets = [...document.querySelectorAll('a,button,[role="button"]')]
    .filter(visible)
    .map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 100),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        href: el.getAttribute('href') || null,
      };
    })
    .filter((item) => item.text !== 'Skip to content')
    .filter((item) => item.width < 44 || item.height < 44)
    .slice(0, 30);
  const h1 = [...document.querySelectorAll('h1')].map((el) => el.innerText.trim()).filter(Boolean);
  const ctas = [...document.querySelectorAll('a,button')]
    .filter(visible)
    .map((el) => (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' '))
    .filter(Boolean)
    .slice(0, 24);
  return { title: document.title, url: location.href, h1, ctas, viewportWidth, documentWidth, overflow, smallTargets };
})()`;
}

async function waitForChrome(debugPort) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await fetchJson(`http://127.0.0.1:${debugPort}/json/version`);
      return;
    } catch {
      await delay(100);
    }
  }
  throw new Error("Chrome did not expose a CDP endpoint.");
}

async function waitForLoadEvent(client) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (client.events.some((event) => event.method === "Page.loadEventFired")) {
      return;
    }
    await delay(100);
  }
  throw new Error("Page load timed out.");
}

function connectToCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const events = [];

  ws.addEventListener("message", (message) => {
    const data = JSON.parse(message.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(new Error(JSON.stringify(data.error)));
      else resolve(data.result ?? {});
      return;
    }
    if (data.method) events.push(data);
  });

  return new Promise((resolve, reject) => {
    ws.addEventListener(
      "open",
      () => {
        resolve({
          ws,
          events,
          send(method, params = {}) {
            const callId = ++id;
            ws.send(JSON.stringify({ id: callId, method, params }));
            return new Promise((res, rej) => {
              pending.set(callId, { resolve: res, reject: rej });
              setTimeout(() => {
                if (!pending.has(callId)) return;
                pending.delete(callId);
                rej(new Error(`CDP timeout: ${method}`));
              }, 15_000);
            });
          },
        });
      },
      { once: true },
    );
    ws.addEventListener("error", reject, { once: true });
  });
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok)
    throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.json();
}

function parseCliArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--base-url") parsed.baseUrl = args[++index];
    else if (arg === "--out-dir") parsed.outDir = args[++index];
    else if (arg === "--routes") parsed.routes = args[++index];
    else if (arg === "--viewports") parsed.viewports = args[++index];
    else if (arg === "--help") {
      console.log(
        "Usage: node scripts/check-ui-layout.mjs [--base-url URL] [--out-dir DIR] [--routes ROUTES] [--viewports VIEWPORTS]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function findChromePath() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  for (const binary of [
    "google-chrome-stable",
    "google-chrome",
    "chromium",
    "chromium-browser",
  ]) {
    try {
      return execFileSync("which", [binary], { encoding: "utf8" }).trim();
    } catch {
      // Try the next binary.
    }
  }

  return null;
}

function normalizeUrl(url) {
  return String(url).replace(/\/+$/, "");
}

function parseRoutes(value) {
  if (!value) return null;
  const routes = String(value)
    .split(",")
    .map((route) => route.trim())
    .filter(Boolean);
  if (routes.length === 0) return null;
  for (const route of routes) {
    if (!route.startsWith("/")) {
      throw new Error(`UI audit route must start with "/": ${route}`);
    }
  }
  return routes;
}

function parseViewports(value) {
  if (!value) return null;
  const viewports = String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const match = /^([a-z0-9_-]+):(\d+)x(\d+)(?::mobile)?$/i.exec(entry);
      if (!match) {
        throw new Error(
          `UI audit viewport must look like name:390x844 or name:390x844:mobile: ${entry}`,
        );
      }
      return {
        name: match[1],
        width: Number.parseInt(match[2], 10),
        height: Number.parseInt(match[3], 10),
        mobile: entry.endsWith(":mobile"),
      };
    });
  return viewports.length > 0 ? viewports : null;
}

function slugRoute(route) {
  if (route === "/") return "home";
  return route
    .replace(/^\//, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 90);
}
