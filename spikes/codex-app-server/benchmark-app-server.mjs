#!/usr/bin/env node
import { spawn, execFile as execFileCallback } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const defaults = {
  mode: "app-server",
  iterations: 3,
  warmup: 0,
  concurrency: 1,
  threadMode: "clean",
  model: process.env.CODEX_MODEL || "gpt-5.5",
  effort: process.env.CODEX_REASONING_EFFORT || "low",
  prompt: "Reply with exactly OK.",
  cwd: process.cwd(),
  timeoutMs: 120_000,
  launcher: "global",
  codexBin: process.env.CODEX_BIN || "codex",
  codexPackage: "@openai/codex@0.135.0",
  sampleMs: 250,
};

async function main(input) {
  const runId = randomUUID();
  console.log(
    JSON.stringify(
      {
        event: "benchmark_start",
        runId,
        mode: input.mode,
        launcher: input.launcher,
        codexBin: input.launcher === "global" ? input.codexBin : undefined,
        codexPackage:
          input.launcher === "pnpm-dlx" ? input.codexPackage : undefined,
        model: input.model,
        effort: input.effort,
        iterations: input.iterations,
        warmup: input.warmup,
        concurrency: input.concurrency,
        threadMode: input.threadMode,
        cwd: input.cwd,
      },
      null,
      2,
    ),
  );

  if (input.mode === "exec" || input.mode === "both") {
    await runExecBenchmark(input);
  }
  if (input.mode === "app-server" || input.mode === "both") {
    await runAppServerBenchmark(input);
  }
}

async function runExecBenchmark(input) {
  const durations = [];
  const rssSamples = [];

  for (let index = 0; index < input.warmup + input.iterations; index += 1) {
    const counted = index >= input.warmup;
    const result = await runExecOnce(input, rssSamples);
    if (counted) durations.push(result.durationMs);
    printJobResult({
      engine: "exec",
      phase: counted ? "measure" : "warmup",
      index,
      durationMs: result.durationMs,
      outputText: result.outputText,
      maxRssBytes: result.maxRssBytes,
    });
  }

  printSummary({
    engine: "exec",
    durations,
    maxRssBytes: maxNumber(rssSamples),
  });
}

async function runExecOnce(input, rssSamples) {
  const startedAt = performance.now();
  const child = spawnCodex(input, [
    "exec",
    "--json",
    "--model",
    input.model,
    "--sandbox",
    "read-only",
    "--config",
    'approval_policy="never"',
    "--config",
    `model_reasoning_effort=${JSON.stringify(input.effort)}`,
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--color",
    "never",
    "--skip-git-repo-check",
    "-",
  ]);

  const sampler = sampleProcessTreeRss(child, input.sampleMs, rssSamples);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(input.prompt);

  const exit = await waitForChild(child, input.timeoutMs);
  await sampler.stop();
  const durationMs = performance.now() - startedAt;
  if (exit.code !== 0) {
    throw new Error(
      `codex_exec_failed:${exit.code}:${safeTail(`${stdout}\n${stderr}`)}`,
    );
  }

  return {
    durationMs,
    outputText: extractExecOutputText(stdout),
    maxRssBytes: sampler.maxRssBytes(),
  };
}

async function runAppServerBenchmark(input) {
  const client = new AppServerClient(input);
  try {
    const startup = await client.start();
    console.log(
      JSON.stringify({
        event: "app_server_ready",
        startupMs: roundMs(startup.startupMs),
        userAgent: startup.userAgent,
        codexHome: startup.codexHome,
        pid: client.pid(),
      }),
    );

    if (input.concurrency > 1) {
      await runAppServerConcurrentJobs({ client, input, startup });
      return;
    }

    const durations = [];
    let reusableThreadId = null;
    if (input.threadMode === "reuse" && input.warmup + input.iterations > 0) {
      reusableThreadId = await client.startThread(input);
    }

    for (let index = 0; index < input.warmup + input.iterations; index += 1) {
      const counted = index >= input.warmup;
      const threadId =
        input.threadMode === "reuse"
          ? reusableThreadId
          : await client.startThread(input);
      const result = await client.runTurn({
        threadId,
        prompt: input.prompt,
        model: input.model,
        effort: input.effort,
        timeoutMs: input.timeoutMs,
      });
      if (counted) durations.push(result.durationMs);
      printJobResult({
        engine: "app-server",
        phase: counted ? "measure" : "warmup",
        index,
        durationMs: result.durationMs,
        outputText: result.outputText,
        maxRssBytes: client.maxRssBytes(),
      });
    }

    printSummary({
      engine: "app-server",
      durations,
      maxRssBytes: client.maxRssBytes(),
      startupMs: startup.startupMs,
      serverRequests: client.serverRequests(),
    });
  } finally {
    await client.stop();
  }
}

async function runAppServerConcurrentJobs({ client, input, startup }) {
  if (input.threadMode !== "clean") {
    throw new Error("app_server_concurrency_requires_clean_thread_mode");
  }

  for (let index = 0; index < input.warmup; index += 1) {
    const threadId = await client.startThread(input);
    const result = await client.runTurn({
      threadId,
      prompt: input.prompt,
      model: input.model,
      effort: input.effort,
      timeoutMs: input.timeoutMs,
    });
    printJobResult({
      engine: "app-server",
      phase: "warmup",
      index,
      durationMs: result.durationMs,
      outputText: result.outputText,
      maxRssBytes: client.maxRssBytes(),
    });
  }

  const queue = Array.from({ length: input.iterations }, (_, index) => index);
  const wallStartedAt = performance.now();
  const workers = Array.from(
    { length: Math.min(input.concurrency, input.iterations) },
    async (_, workerIndex) => {
      const results = [];
      while (queue.length > 0) {
        const jobIndex = queue.shift();
        if (jobIndex === undefined) break;
        results.push(await runAppServerConcurrentJob({
          client,
          input,
          jobIndex,
          workerIndex,
        }));
      }
      return results;
    },
  );

  const settled = await Promise.allSettled(workers);
  const flatResults = [];
  for (const item of settled) {
    if (item.status === "fulfilled") {
      flatResults.push(...item.value);
    } else {
      flatResults.push({
        ok: false,
        jobIndex: -1,
        durationMs: 0,
        error: item.reason,
      });
    }
  }

  const successful = flatResults.filter((result) => result.ok);
  const failed = flatResults.filter((result) => !result.ok);
  for (const result of flatResults.sort((a, b) => a.jobIndex - b.jobIndex)) {
    if (result.ok) {
      printJobResult({
        engine: "app-server",
        phase: "measure",
        index: result.jobIndex,
        durationMs: result.durationMs,
        outputText: result.outputText,
        maxRssBytes: client.maxRssBytes(),
      });
    } else {
      console.log(
        JSON.stringify({
          event: "job_error",
          engine: "app-server",
          phase: "measure",
          index: result.jobIndex,
          durationMs: roundMs(result.durationMs),
          error: safeTail(result.error?.message ?? result.error),
        }),
      );
    }
  }

  printSummary({
    engine: "app-server-concurrent",
    durations: successful.map((result) => result.durationMs),
    maxRssBytes: client.maxRssBytes(),
    startupMs: startup.startupMs,
    serverRequests: client.serverRequests(),
    extra: {
      concurrency: input.concurrency,
      successCount: successful.length,
      failureCount: failed.length,
      wallMs: roundMs(performance.now() - wallStartedAt),
    },
  });
}

async function runAppServerConcurrentJob({ client, input, jobIndex, workerIndex }) {
  const startedAt = performance.now();
  try {
    const threadId = await client.startThread(input);
    const result = await client.runTurn({
      threadId,
      prompt: `${input.prompt}\n\nJob index: ${jobIndex}. Worker index: ${workerIndex}.`,
      model: input.model,
      effort: input.effort,
      timeoutMs: input.timeoutMs,
    });
    return {
      ok: true,
      jobIndex,
      workerIndex,
      durationMs: performance.now() - startedAt,
      turnDurationMs: result.durationMs,
      outputText: result.outputText,
    };
  } catch (error) {
    return {
      ok: false,
      jobIndex,
      workerIndex,
      durationMs: performance.now() - startedAt,
      error,
    };
  }
}

class AppServerClient {
  constructor(input) {
    this.input = input;
    this.nextId = 1;
    this.pending = new Map();
    this.turns = new Map();
    this.buffer = "";
    this.stderr = "";
    this.maxRss = 0;
    this.requests = [];
    this.child = null;
    this.rssTimer = null;
  }

  pid() {
    return this.child?.pid ?? null;
  }

  maxRssBytes() {
    return this.maxRss;
  }

  serverRequests() {
    return this.requests.slice();
  }

  async start() {
    const startedAt = performance.now();
    this.child = spawnCodex(this.input, ["app-server", "--listen", "stdio://"]);
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    this.child.on("exit", (code, signal) => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`app_server_exited:${code ?? signal}`));
      }
      this.pending.clear();
    });
    this.rssTimer = setInterval(async () => {
      if (!this.child?.pid) return;
      const rss = await readProcessTreeRss(this.child.pid);
      if (rss > this.maxRss) this.maxRss = rss;
    }, this.input.sampleMs);

    const response = await this.send(
      "initialize",
      {
        clientInfo: {
          name: "review-router-app-server-spike",
          title: "ReviewRouter app-server spike",
          version: "0.0.0",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      },
      this.input.timeoutMs,
    );

    if (response.error) {
      throw new Error(`app_server_initialize_failed:${response.error.message}`);
    }
    const result = response.result ?? {};
    return {
      startupMs: performance.now() - startedAt,
      userAgent: result.userAgent ?? null,
      codexHome: result.codexHome ?? null,
    };
  }

  async startThread(input) {
    const response = await this.send(
      "thread/start",
      {
        model: input.model,
        modelProvider: null,
        serviceTier: null,
        cwd: input.cwd,
        runtimeWorkspaceRoots: [input.cwd],
        approvalPolicy: "never",
        approvalsReviewer: null,
        sandbox: "read-only",
        permissions: null,
        config: {
          model_reasoning_effort: input.effort,
          approval_policy: "never",
          sandbox_mode: "read-only",
          web_search: "disabled",
          apps: {
            _default: {
              enabled: false,
              destructive_enabled: false,
              open_world_enabled: false,
            },
          },
        },
        serviceName: "review-router-spike",
        baseInstructions: null,
        developerInstructions:
          "You are a low-latency benchmark worker. Do not run tools. Reply with the requested final answer only.",
        personality: null,
        ephemeral: true,
        sessionStartSource: "startup",
        threadSource: "user",
        environments: [],
        dynamicTools: [],
        experimentalRawEvents: false,
      },
      input.timeoutMs,
    );
    if (response.error) {
      throw new Error(`app_server_thread_start_failed:${response.error.message}`);
    }
    const threadId = response.result?.thread?.id;
    if (!threadId) throw new Error("app_server_thread_id_missing");
    return threadId;
  }

  async runTurn(input) {
    const startedAt = performance.now();
    const response = await this.send(
      "turn/start",
      {
        threadId: input.threadId,
        input: [
          {
            type: "text",
            text: input.prompt,
            text_elements: [],
          },
        ],
        responsesapiClientMetadata: null,
        additionalContext: null,
        environments: [],
        cwd: null,
        runtimeWorkspaceRoots: null,
        approvalPolicy: "never",
        approvalsReviewer: null,
        sandboxPolicy: null,
        permissions: null,
        model: input.model,
        serviceTier: null,
        effort: input.effort,
        summary: "none",
        personality: null,
        outputSchema: null,
        collaborationMode: null,
      },
      input.timeoutMs,
    );
    if (response.error) {
      throw new Error(`app_server_turn_start_failed:${response.error.message}`);
    }
    const turnId = response.result?.turn?.id;
    if (!turnId) throw new Error("app_server_turn_id_missing");

    const completed = await this.waitForTurn(turnId, input.timeoutMs);
    const durationMs = performance.now() - startedAt;
    if (completed.error) throw completed.error;
    const outputText = completed.outputText.trim();
    if (!outputText) throw new Error("app_server_final_message_missing");
    return {
      durationMs,
      outputText,
    };
  }

  async waitForTurn(turnId, timeoutMs) {
    const existing = this.turns.get(turnId);
    if (existing?.completed) return existing;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`app_server_turn_timeout:${turnId}`));
      }, timeoutMs);
      const turn = existing ?? {
        outputText: "",
        completed: false,
        waiters: [],
      };
      turn.waiters.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
      this.turns.set(turnId, turn);
    });
  }

  async send(method, params, timeoutMs) {
    if (!this.child) throw new Error("app_server_not_started");
    const id = this.nextId;
    this.nextId += 1;
    const payload = { id, method, params };
    const pending = {};
    const promise = new Promise((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
      pending.timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app_server_request_timeout:${method}`));
      }, timeoutMs);
    });
    this.pending.set(id, pending);
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    return promise;
  }

  onStdout(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        continue;
      }
      this.onMessage(message);
    }
  }

  onMessage(message) {
    if (message.id !== undefined && (message.result !== undefined || message.error)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      pending.resolve(message);
      return;
    }

    if (message.id !== undefined && message.method) {
      this.onServerRequest(message);
      return;
    }

    if (!message.method) return;
    const params = message.params ?? {};
    if (message.method === "item/agentMessage/delta") {
      const turn = this.ensureTurn(params.turnId);
      turn.outputText += params.delta ?? "";
      return;
    }
    if (message.method === "item/completed") {
      const turn = this.ensureTurn(params.turnId);
      if (params.item?.type === "agentMessage" && params.item.text) {
        turn.outputText = params.item.text;
      }
      return;
    }
    if (message.method === "turn/completed") {
      const turnId = params.turn?.id;
      const turn = this.ensureTurn(turnId);
      turn.completed = true;
      if (params.turn?.status?.type === "failed") {
        turn.error = new Error(
          `app_server_turn_failed:${params.turn?.error?.message ?? "unknown"}`,
        );
      }
      this.resolveTurn(turnId, turn);
      return;
    }
    if (message.method === "error") {
      const turnId = params.turnId;
      const turn = this.ensureTurn(turnId);
      turn.error = new Error(
        `app_server_error:${params.error?.message ?? "unknown"}`,
      );
      if (turnId) this.resolveTurn(turnId, turn);
    }
  }

  onServerRequest(message) {
    this.requests.push({
      method: message.method,
      seenAt: new Date().toISOString(),
    });
    this.child.stdin.write(
      `${JSON.stringify({
        id: message.id,
        error: {
          code: -32000,
          message: `unsupported_server_request:${message.method}`,
        },
      })}\n`,
    );
  }

  ensureTurn(turnId) {
    if (!turnId) {
      return {
        outputText: "",
        completed: false,
        waiters: [],
      };
    }
    let turn = this.turns.get(turnId);
    if (!turn) {
      turn = {
        outputText: "",
        completed: false,
        waiters: [],
      };
      this.turns.set(turnId, turn);
    }
    return turn;
  }

  resolveTurn(turnId, turn) {
    if (!turnId) return;
    const waiters = turn.waiters.splice(0);
    for (const waiter of waiters) waiter(turn);
  }

  async stop() {
    if (this.rssTimer) clearInterval(this.rssTimer);
    this.rssTimer = null;
    const child = this.child;
    this.child = null;
    if (!child || child.killed) return;
    signalChildGroup(child, "SIGTERM");
    const timeout = setTimeout(() => {
      signalChildGroup(child, "SIGKILL");
    }, 5_000);
    try {
      await once(child, "exit");
    } finally {
      clearTimeout(timeout);
      signalChildGroup(child, "SIGKILL");
    }
  }
}

function spawnCodex(input, args) {
  if (input.launcher === "pnpm-dlx") {
    return spawn("pnpm", ["dlx", input.codexPackage, ...args], {
      cwd: input.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
  }
  return spawn(input.codexBin, args, {
    cwd: input.cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
}

async function waitForChild(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("child_timeout"));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function sampleProcessTreeRss(child, sampleMs, sink) {
  let stopped = false;
  let maxRss = 0;
  const timer = setInterval(async () => {
    if (stopped || !child.pid) return;
    const rss = await readProcessTreeRss(child.pid);
    if (rss > maxRss) maxRss = rss;
    if (rss > 0) sink.push(rss);
  }, sampleMs);
  return {
    maxRssBytes: () => maxRss,
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (child.pid) {
        const rss = await readProcessTreeRss(child.pid);
        if (rss > maxRss) maxRss = rss;
        if (rss > 0) sink.push(rss);
      }
    },
  };
}

async function readProcessTreeRss(rootPid) {
  const pids = await collectProcessTree(rootPid);
  let totalKb = 0;
  for (const pid of pids) {
    try {
      const { stdout } = await execFile("ps", ["-o", "rss=", "-p", String(pid)]);
      const kb = Number(stdout.trim());
      if (Number.isFinite(kb)) totalKb += kb;
    } catch {
      // Process may have exited between pgrep and ps.
    }
  }
  return totalKb * 1024;
}

async function collectProcessTree(rootPid) {
  const result = [rootPid];
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift();
    try {
      const { stdout } = await execFile("pgrep", ["-P", String(pid)]);
      for (const child of stdout.split(/\s+/)) {
        const childPid = Number(child);
        if (Number.isInteger(childPid) && !result.includes(childPid)) {
          result.push(childPid);
          queue.push(childPid);
        }
      }
    } catch {
      // pgrep exits non-zero when there are no children.
    }
  }
  return result;
}

function signalChildGroup(child, signal) {
  try {
    if (process.platform === "win32") {
      child.kill(signal);
      return;
    }
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process may already be gone.
    }
  }
}

function extractExecOutputText(stdout) {
  let finalText = "";
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const text = extractText(event);
    if (text) finalText = text;
  }
  return finalText.trim();
}

function extractText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join("");
  if (typeof value !== "object") return "";
  for (const key of ["message", "text", "output_text", "last_message", "content"]) {
    const text = extractText(value[key]);
    if (text) return text;
  }
  for (const key of ["data", "item", "delta", "response"]) {
    const text = extractText(value[key]);
    if (text) return text;
  }
  return "";
}

function printJobResult(input) {
  console.log(
    JSON.stringify({
      event: "job_result",
      engine: input.engine,
      phase: input.phase,
      index: input.index,
      durationMs: roundMs(input.durationMs),
      maxRssMb: bytesToMb(input.maxRssBytes),
      outputPreview: safeTail(input.outputText, 160),
    }),
  );
}

function printSummary(input) {
  const sorted = input.durations.slice().sort((a, b) => a - b);
  const summary = {
    event: "summary",
    engine: input.engine,
    count: sorted.length,
    startupMs: input.startupMs === undefined ? undefined : roundMs(input.startupMs),
    avgMs: sorted.length ? roundMs(avg(sorted)) : null,
    minMs: sorted.length ? roundMs(sorted[0]) : null,
    p50Ms: sorted.length ? roundMs(percentile(sorted, 0.5)) : null,
    p95Ms: sorted.length ? roundMs(percentile(sorted, 0.95)) : null,
    maxMs: sorted.length ? roundMs(sorted[sorted.length - 1]) : null,
    maxRssMb: bytesToMb(input.maxRssBytes),
    serverRequests: input.serverRequests,
    ...input.extra,
  };
  console.log(JSON.stringify(summary, null, 2));
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const value =
      inlineValue !== undefined
        ? inlineValue
        : argv[index + 1] && !argv[index + 1].startsWith("--")
          ? argv[++index]
          : "true";
    parsed[key] = value;
  }
  return parsed;
}

function validateConfig(input) {
  if (!["exec", "app-server", "both"].includes(input.mode)) {
    throw new Error("mode must be exec, app-server, or both");
  }
  if (!["clean", "reuse"].includes(input.threadMode)) {
    throw new Error("thread-mode must be clean or reuse");
  }
  if (input.concurrency > 1 && input.mode !== "app-server") {
    throw new Error("concurrency > 1 is supported only with mode=app-server");
  }
  if (!["global", "pnpm-dlx"].includes(input.launcher)) {
    throw new Error("launcher must be global or pnpm-dlx");
  }
}

function toNonNegativeInt(value, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`Expected non-negative integer, got ${value}`);
  }
  return number;
}

function toPositiveInt(value, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`Expected positive integer, got ${value}`);
  }
  return number;
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  );
  return sorted[index];
}

function avg(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function maxNumber(values) {
  return values.reduce((max, value) => Math.max(max, value), 0);
}

function roundMs(value) {
  return Math.round(value);
}

function bytesToMb(value) {
  return value ? Math.round((value / 1024 / 1024) * 10) / 10 : 0;
}

function safeTail(value, max = 500) {
  const text = String(value ?? "");
  return text.length <= max ? text : text.slice(text.length - max);
}

function printHelp() {
  console.log(`Usage:
  node spikes/codex-app-server/benchmark-app-server.mjs [options]

Options:
  --mode app-server|exec|both       Engine to benchmark. Default: app-server
  --launcher global|pnpm-dlx        Use installed codex or pnpm dlx package. Default: global
  --codex-bin codex                 Codex binary when launcher=global
  --codex-package @openai/codex@X   Package when launcher=pnpm-dlx
  --iterations N                    Measured jobs. Default: 3
  --warmup N                        Warmup jobs before measurement. Default: 0
  --concurrency N                   Parallel clean-thread jobs in one app-server. Default: 1
  --thread-mode clean|reuse         New thread per job or reused thread. Default: clean
  --model MODEL                     Codex model. Default: CODEX_MODEL or gpt-5.5
  --effort minimal|low|medium|high  Reasoning effort. Default: low
  --prompt TEXT                     Prompt. Default: "Reply with exactly OK."
  --cwd PATH                        Working directory. Default: current directory
  --timeout-ms N                    Per request timeout. Default: 120000

Examples:
  node spikes/codex-app-server/benchmark-app-server.mjs --mode app-server --iterations 2 --warmup 1
  node spikes/codex-app-server/benchmark-app-server.mjs --mode both --launcher pnpm-dlx --iterations 1
`);
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}

const config = {
  ...defaults,
  ...options,
  iterations: toNonNegativeInt(options.iterations, defaults.iterations),
  warmup: toNonNegativeInt(options.warmup, defaults.warmup),
  concurrency: toPositiveInt(options.concurrency, defaults.concurrency),
  timeoutMs: toPositiveInt(options.timeoutMs, defaults.timeoutMs),
  sampleMs: toPositiveInt(options.sampleMs, defaults.sampleMs),
};

validateConfig(config);
await main(config);
