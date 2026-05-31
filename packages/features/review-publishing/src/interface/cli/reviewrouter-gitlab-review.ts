#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  reviewFindingsArtifactFileName,
  stringifyReviewFindingsArtifact,
} from "../../domain/review-findings-artifact";
import { createReviewFindingsArtifactFromModelOutput } from "../../domain/review-model-output-artifact";
import { publishReviewFindingsArtifact } from "../../application/use-cases/publish-review-findings-artifact";
import { GitLabReviewPublisher } from "../../infrastructure/gitlab/gitlab-review-publisher";

type FetchLike = typeof fetch;

type CliStream = {
  write(chunk: string): unknown;
};

type CommandRunner = (input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly stdin?: string | undefined;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
}) => Promise<{ readonly stdout: string; readonly stderr: string }>;

type FileSystem = {
  readonly readFile: typeof readFile;
  readonly writeFile: typeof writeFile;
  readonly mkdir: typeof mkdir;
  readonly mkdtemp: typeof mkdtemp;
  readonly rm: typeof rm;
  readonly chmod: typeof chmod;
};

export type GitLabReviewCliInput = {
  readonly argv?: readonly string[] | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly cwd?: string | undefined;
  readonly fetchImpl?: FetchLike | undefined;
  readonly runCommand?: CommandRunner | undefined;
  readonly fs?: Partial<FileSystem> | undefined;
  readonly stdout?: CliStream | undefined;
  readonly stderr?: CliStream | undefined;
  readonly now?: Date | undefined;
};

type CliOptions = {
  readonly artifactPath?: string | undefined;
  readonly diffFile?: string | undefined;
  readonly modelOutputFile?: string | undefined;
  readonly skipPublish: boolean;
  readonly help: boolean;
};

type GitLabControlPlaneSessionMetadata = {
  readonly exchanged: true;
  readonly repository: string;
  readonly expiresAt: string;
};

const defaultCodexModel = "gpt-5.5";
const defaultTimeoutMs = 15 * 60 * 1000;

export async function runGitLabReviewCli(
  input: GitLabReviewCliInput = {},
): Promise<void> {
  const argv = input.argv ?? process.argv.slice(2);
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  const stdout = input.stdout ?? process.stdout;
  const options = parseCliOptions(argv);
  const fs = {
    readFile: input.fs?.readFile ?? readFile,
    writeFile: input.fs?.writeFile ?? writeFile,
    mkdir: input.fs?.mkdir ?? mkdir,
    mkdtemp: input.fs?.mkdtemp ?? mkdtemp,
    rm: input.fs?.rm ?? rm,
    chmod: input.fs?.chmod ?? chmod,
  };

  if (options.help) {
    stdout.write(helpText());
    return;
  }

  const artifactPath = resolve(
    cwd,
    options.artifactPath ??
      readOptionalEnv(env, "REVIEWROUTER_FINDINGS_ARTIFACT_PATH") ??
      reviewFindingsArtifactFileName,
  );
  const controlPlaneSession = options.skipPublish
    ? null
    : await maybeExchangeGitLabControlPlaneSession({
        env,
        fetchImpl: input.fetchImpl ?? fetch,
      });
  const modelOutput = options.modelOutputFile
    ? JSON.parse(
        await fs.readFile(resolve(cwd, options.modelOutputFile), "utf8"),
      )
    : await runCodexReview({
        cwd,
        env,
        fs,
        runCommand: input.runCommand ?? nodeCommandRunner,
        diff: await readDiff({
          cwd,
          env,
          options,
          fs,
          runCommand: input.runCommand ?? nodeCommandRunner,
        }),
      });
  const artifact = createReviewFindingsArtifactFromModelOutput({
    generatedAt: input.now ?? new Date(),
    modelOutput,
  });
  const artifactJson = stringifyReviewFindingsArtifact(artifact);
  await fs.mkdir(dirname(artifactPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(artifactPath, artifactJson, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.chmod(artifactPath, 0o600);

  if (options.skipPublish) {
    stdout.write(
      `${JSON.stringify(
        {
          protocolVersion: 1,
          status: "artifact_written",
          artifactPath,
          findingCount: artifact.findings.length,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const target = buildGitLabTargetFromEnv(env);
  const result = await publishReviewFindingsArtifact(
    {
      artifactJson,
      target,
      marker:
        readOptionalEnv(env, "REVIEWROUTER_REVIEW_MARKER") ??
        `reviewrouter:gitlab:review`,
      ...readMaxInlineCommentsFromEnv(env),
    },
    {
      publisher: new GitLabReviewPublisher({
        token: readRequiredEnv(env, "REVIEWROUTER_GITLAB_TOKEN"),
        ...(readOptionalEnv(env, "REVIEWROUTER_GITLAB_API_BASE_URL")
          ? {
              apiBaseUrl: readOptionalEnv(
                env,
                "REVIEWROUTER_GITLAB_API_BASE_URL",
              ),
            }
          : {}),
        fetchImpl: input.fetchImpl ?? fetch,
      }),
    },
  );

  stdout.write(
    `${JSON.stringify(
      {
        protocolVersion: 1,
        status: "published",
        artifactPath,
        provider: result.target.provider,
        repositoryExternalId: result.target.repositoryExternalId,
        changeRequestExternalId: result.target.changeRequestExternalId,
        inlineCommentCount: result.inlineCommentCount,
        summaryCommentCount: result.summaryCommentCount,
        skippedInlineFindings: result.skippedInlineFindings,
        externalIds: result.externalIds,
        ...(controlPlaneSession ? { controlPlaneSession } : {}),
      },
      null,
      2,
    )}\n`,
  );
}

function parseCliOptions(argv: readonly string[]): CliOptions {
  const options: {
    artifactPath?: string;
    diffFile?: string;
    modelOutputFile?: string;
    skipPublish: boolean;
    help: boolean;
  } = { skipPublish: false, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--artifact") {
      options.artifactPath = readCliValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--diff-file") {
      options.diffFile = readCliValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--model-output") {
      options.modelOutputFile = readCliValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--skip-publish") {
      options.skipPublish = true;
      continue;
    }
    throw new Error(`gitlab_review_argument_unknown:${arg}`);
  }
  return options;
}

function readCliValue(
  argv: readonly string[],
  index: number,
  option: string,
): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`gitlab_review_argument_value_missing:${option}`);
  }
  return value;
}

async function readDiff(input: {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly options: CliOptions;
  readonly fs: Pick<FileSystem, "readFile">;
  readonly runCommand: CommandRunner;
}): Promise<string> {
  if (input.options.diffFile) {
    return input.fs.readFile(
      resolve(input.cwd, input.options.diffFile),
      "utf8",
    );
  }
  const headSha =
    readOptionalEnv(input.env, "REVIEWROUTER_HEAD_SHA") ??
    readRequiredEnv(input.env, "CI_COMMIT_SHA");
  const baseSha =
    readOptionalEnv(input.env, "REVIEWROUTER_BASE_SHA") ??
    readOptionalEnv(input.env, "CI_MERGE_REQUEST_DIFF_BASE_SHA") ??
    (await resolveFallbackMergeRequestBaseSha({
      cwd: input.cwd,
      env: input.env,
      headSha,
      runCommand: input.runCommand,
    }));
  const diff = await input.runCommand({
    command: "git",
    args: ["diff", "--no-ext-diff", "--unified=80", baseSha, headSha, "--"],
    cwd: input.cwd,
    timeoutMs: readPositiveIntegerEnv(
      input.env,
      "REVIEWROUTER_GIT_DIFF_TIMEOUT_MS",
      60_000,
    ),
    maxStdoutBytes: 2_000_000,
    maxStderrBytes: 128_000,
  });
  if (!diff.stdout.trim()) {
    throw new Error("gitlab_review_diff_empty");
  }
  return diff.stdout;
}

async function runCodexReview(input: {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fs: FileSystem;
  readonly runCommand: CommandRunner;
  readonly diff: string;
}): Promise<unknown> {
  const tempDir = await input.fs.mkdtemp(
    join(tmpdir(), "reviewrouter-gitlab-"),
  );
  try {
    const schemaFile = join(tempDir, "review-model-output.schema.json");
    const outputFile = join(tempDir, "review-model-output.json");
    await input.fs.writeFile(
      schemaFile,
      JSON.stringify(modelOutputJsonSchema),
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
    const codexHome = await prepareCodexHome({
      tempDir,
      env: input.env,
      fs: input.fs,
    });
    await input.runCommand({
      command:
        readOptionalEnv(input.env, "REVIEWROUTER_CODEX_COMMAND") ?? "codex",
      args: buildCodexExecArgs({
        model: readOptionalEnv(input.env, "CODEX_MODEL") ?? defaultCodexModel,
        reasoningEffort: readOptionalEnv(input.env, "CODEX_REASONING_EFFORT"),
        schemaFile,
        outputFile,
        workspace: input.cwd,
      }),
      cwd: input.cwd,
      env: buildCodexCommandEnvironment({ env: input.env, codexHome }),
      stdin: buildGitLabReviewPrompt({ env: input.env, diff: input.diff }),
      timeoutMs: readPositiveIntegerEnv(
        input.env,
        "REVIEWROUTER_CODEX_TIMEOUT_MS",
        defaultTimeoutMs,
      ),
      maxStdoutBytes: 128_000,
      maxStderrBytes: 128_000,
    });
    return JSON.parse(await input.fs.readFile(outputFile, "utf8"));
  } finally {
    await input.fs.rm(tempDir, { recursive: true, force: true });
  }
}

function buildCodexExecArgs(input: {
  readonly model: string;
  readonly reasoningEffort?: string | undefined;
  readonly schemaFile: string;
  readonly outputFile: string;
  readonly workspace: string;
}): readonly string[] {
  const args = [
    "exec",
    "--model",
    input.model,
    "--sandbox",
    "read-only",
    "--config",
    'approval_policy="never"',
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--color",
    "never",
    "--cd",
    input.workspace,
    "--output-schema",
    input.schemaFile,
    "--output-last-message",
    input.outputFile,
    "-",
  ];
  if (input.reasoningEffort?.trim()) {
    args.splice(
      args.indexOf("--ephemeral"),
      0,
      "--config",
      `model_reasoning_effort=${JSON.stringify(input.reasoningEffort.trim())}`,
    );
  }
  return args;
}

function buildGitLabReviewPrompt(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly diff: string;
}): string {
  return [
    "You are ReviewRouter normal merge request review runtime.",
    "",
    "Review only the provided GitLab merge request diff for bugs, security issues, and clear regressions.",
    "Return only JSON that matches the provided schema.",
    "Use current/new-file line numbers for findings when available. For findings without a precise current line, set path, startLine, and endLine to null.",
    "",
    "Context:",
    JSON.stringify(
      {
        provider: "gitlab",
        projectPath: readOptionalEnv(input.env, "CI_PROJECT_PATH"),
        mergeRequestIid: readMergeRequestIid(input.env),
        headSha:
          readOptionalEnv(input.env, "REVIEWROUTER_HEAD_SHA") ??
          readOptionalEnv(input.env, "CI_COMMIT_SHA"),
        baseSha:
          readOptionalEnv(input.env, "REVIEWROUTER_BASE_SHA") ??
          readOptionalEnv(input.env, "CI_MERGE_REQUEST_DIFF_BASE_SHA"),
      },
      null,
      2,
    ),
    "",
    "Diff:",
    input.diff,
  ].join("\n");
}

async function prepareCodexHome(input: {
  readonly tempDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fs: Pick<FileSystem, "mkdir" | "writeFile" | "chmod">;
}): Promise<string> {
  const codexHome = join(input.tempDir, "codex-home");
  await input.fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
  const authJson = readOptionalEnv(input.env, "CODEX_AUTH_JSON");
  if (authJson) {
    const authFile = join(codexHome, "auth.json");
    await input.fs.writeFile(authFile, authJson, {
      encoding: "utf8",
      mode: 0o600,
    });
    await input.fs.chmod(authFile, 0o600);
  }
  const configToml = readOptionalEnv(input.env, "CODEX_CONFIG_TOML");
  if (configToml) {
    const configFile = join(codexHome, "config.toml");
    await input.fs.writeFile(configFile, configToml, {
      encoding: "utf8",
      mode: 0o600,
    });
    await input.fs.chmod(configFile, 0o600);
  }
  return codexHome;
}

function buildCodexCommandEnvironment(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly codexHome: string;
}): Readonly<Record<string, string | undefined>> {
  return {
    PATH: input.env.PATH ?? process.env.PATH,
    HOME: input.codexHome,
    XDG_CONFIG_HOME: join(input.codexHome, "config"),
    XDG_CACHE_HOME: join(input.codexHome, "cache"),
    TMPDIR: input.env.TMPDIR ?? tmpdir(),
    TEMP: input.env.TEMP ?? tmpdir(),
    TMP: input.env.TMP ?? tmpdir(),
    LANG: input.env.LANG ?? "C.UTF-8",
    LC_ALL: input.env.LC_ALL,
    CI: "true",
    CODEX_HOME: input.codexHome,
    OPENAI_API_KEY: input.env.OPENAI_API_KEY,
  };
}

function buildGitLabTargetFromEnv(
  env: Readonly<Record<string, string | undefined>>,
) {
  const startSha =
    readOptionalEnv(env, "REVIEWROUTER_START_SHA") ??
    readOptionalEnv(env, "CI_MERGE_REQUEST_DIFF_START_SHA");
  return {
    provider: "gitlab" as const,
    repositoryExternalId:
      readOptionalEnv(env, "REVIEWROUTER_REPOSITORY_EXTERNAL_ID") ??
      readRequiredEnv(env, "CI_PROJECT_ID"),
    repositoryFullName:
      readOptionalEnv(env, "REVIEWROUTER_REPOSITORY_FULL_NAME") ??
      readRequiredEnv(env, "CI_PROJECT_PATH"),
    changeRequestExternalId: readRequiredMergeRequestIid(env),
    headSha:
      readOptionalEnv(env, "REVIEWROUTER_HEAD_SHA") ??
      readRequiredEnv(env, "CI_COMMIT_SHA"),
    baseSha:
      readOptionalEnv(env, "REVIEWROUTER_BASE_SHA") ??
      readOptionalEnv(env, "CI_MERGE_REQUEST_DIFF_BASE_SHA"),
    ...(startSha ? { startSha } : {}),
  };
}

async function resolveFallbackMergeRequestBaseSha(input: {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly headSha: string;
  readonly runCommand: CommandRunner;
}): Promise<string> {
  readRequiredMergeRequestIid(input.env);
  const targetBranch =
    readOptionalEnv(input.env, "CI_MERGE_REQUEST_TARGET_BRANCH_NAME") ??
    readOptionalEnv(input.env, "CI_DEFAULT_BRANCH") ??
    "main";
  const result = await input.runCommand({
    command: "git",
    args: ["merge-base", `origin/${targetBranch}`, input.headSha],
    cwd: input.cwd,
    timeoutMs: readPositiveIntegerEnv(
      input.env,
      "REVIEWROUTER_GIT_DIFF_TIMEOUT_MS",
      60_000,
    ),
    maxStdoutBytes: 4_096,
    maxStderrBytes: 128_000,
  });
  const baseSha = result.stdout.trim();
  if (!/^[a-fA-F0-9]{40}$/.test(baseSha)) {
    throw new Error("gitlab_review_diff_base_sha_unavailable");
  }
  return baseSha;
}

async function maybeExchangeGitLabControlPlaneSession(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl: FetchLike;
}): Promise<GitLabControlPlaneSessionMetadata | null> {
  const apiUrl = readOptionalEnv(input.env, "REVIEWROUTER_API_URL");
  const idToken = readOptionalEnv(input.env, "REVIEWROUTER_ID_TOKEN");
  if (!apiUrl && !idToken) {
    return null;
  }
  if (!apiUrl || !idToken) {
    throw new Error("gitlab_control_plane_session_incomplete");
  }

  const audience = readOptionalEnv(input.env, "REVIEWROUTER_ID_TOKEN_AUDIENCE");
  const response = await input.fetchImpl(
    `${normalizeUrlBase(apiUrl, "gitlab_reviewrouter_api_url_invalid")}/api/gitlab/action/v1/session/exchange`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        idToken,
        ...(audience ? { audience } : {}),
        mergeRequestIid: readRequiredMergeRequestIid(input.env),
        headSha: readRequiredEnv(input.env, "CI_COMMIT_SHA"),
      }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `gitlab_control_plane_session_exchange_failed:${response.status}`,
    );
  }
  const body = (await response.json()) as unknown;
  if (!isControlPlaneSessionExchangeResponse(body)) {
    throw new Error("gitlab_control_plane_session_exchange_invalid");
  }
  return {
    exchanged: true,
    repository: body.repository,
    expiresAt: body.expiresAt,
  };
}

function readMaxInlineCommentsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): { readonly maxInlineComments?: number | undefined } {
  const value =
    readOptionalEnv(env, "REVIEWROUTER_MAX_INLINE_COMMENTS") ??
    readOptionalEnv(env, "INLINE_MAX_COMMENTS");
  return value
    ? {
        maxInlineComments: parseNonNegativeInteger(
          value,
          "gitlab_review_max_inline_comments_invalid",
        ),
      }
    : {};
}

function parseNonNegativeInteger(value: string, errorCode: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(errorCode);
  }
  return Number(value);
}

function readPositiveIntegerEnv(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
  fallback: number,
): number {
  const value = readOptionalEnv(env, key);
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`gitlab_review_env_invalid:${key}`);
  }
  return parsed;
}

function readRequiredEnv(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): string {
  const value = readOptionalEnv(env, key);
  if (!value) {
    throw new Error(`gitlab_review_env_missing:${key}`);
  }
  return value;
}

function readRequiredMergeRequestIid(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const mergeRequestIid = readMergeRequestIid(env);
  if (!mergeRequestIid) {
    throw new Error("gitlab_review_env_missing:CI_MERGE_REQUEST_IID");
  }
  return mergeRequestIid;
}

function readMergeRequestIid(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const explicit =
    readOptionalEnv(env, "REVIEWROUTER_CHANGE_REQUEST_EXTERNAL_ID") ??
    readOptionalEnv(env, "CI_MERGE_REQUEST_IID");
  if (explicit) {
    return explicit;
  }
  for (const key of ["CI_MERGE_REQUEST_REF_PATH", "CI_COMMIT_REF_NAME"]) {
    const value = readOptionalEnv(env, key);
    const match = value?.match(
      /^refs\/merge-requests\/([1-9][0-9]*)\/(?:head|merge)$/,
    );
    if (match?.[1]) {
      return match[1];
    }
  }
  const openMergeRequests = readOptionalEnv(env, "CI_OPEN_MERGE_REQUESTS");
  if (openMergeRequests) {
    const projectPath = readOptionalEnv(env, "CI_PROJECT_PATH");
    const matches = openMergeRequests
      .split(",")
      .map((entry) => entry.trim())
      .map((entry) => entry.match(/^(.+)!([1-9][0-9]*)$/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .filter((match) => !projectPath || match[1] === projectPath);
    if (matches.length === 1 && matches[0]?.[2]) {
      return matches[0][2];
    }
  }
  return undefined;
}

function readOptionalEnv(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function normalizeUrlBase(value: string, errorCode: string): string {
  try {
    return new URL(value).toString().replace(/\/+$/, "");
  } catch {
    throw new Error(errorCode);
  }
}

function isControlPlaneSessionExchangeResponse(value: unknown): value is {
  readonly protocolVersion: 1;
  readonly sessionToken: string;
  readonly expiresAt: string;
  readonly repository: string;
} {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.protocolVersion === 1 &&
    typeof record.sessionToken === "string" &&
    record.sessionToken.length > 0 &&
    typeof record.expiresAt === "string" &&
    record.expiresAt.length > 0 &&
    typeof record.repository === "string" &&
    record.repository.length > 0
  );
}

async function nodeCommandRunner(
  input: Parameters<CommandRunner>[0],
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: { ...process.env, ...input.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("gitlab_review_command_timeout"));
    }, input.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = appendBounded(stdout, chunk, input.maxStdoutBytes);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk, input.maxStderrBytes);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(`gitlab_review_command_failed:${input.command}:${code}`),
        );
        return;
      }
      resolvePromise({ stdout, stderr });
    });
    if (input.stdin) {
      child.stdin.end(input.stdin);
    } else {
      child.stdin.end();
    }
  });
}

function appendBounded(
  current: string,
  chunk: string,
  maxBytes: number,
): string {
  const next = `${current}${chunk}`;
  const buffer = Buffer.from(next, "utf8");
  return buffer.byteLength <= maxBytes
    ? next
    : buffer.subarray(buffer.byteLength - maxBytes).toString("utf8");
}

function helpText(): string {
  return [
    "Usage: reviewrouter-gitlab-review [--artifact reviewrouter-findings.json] [--diff-file diff.patch] [--model-output model-output.json] [--skip-publish]",
    "",
    "Runs a GitLab MR review in CI, writes reviewrouter-findings.json, then publishes through GitLab MR Discussions.",
    "",
  ].join("\n");
}

function safeCliErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown_error";
  if (
    /authorization|bearer|glpat-|gh[spou]_|github_pat_|sk-[a-z0-9]|api[_-]?key|secret|token/i.test(
      message,
    )
  ) {
    return "gitlab_review_error";
  }
  return message.replaceAll(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 160);
}

const modelOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["protocolVersion", "summaryMarkdown", "findings"],
  properties: {
    protocolVersion: { type: "integer", const: 1 },
    summaryMarkdown: { type: "string", minLength: 1, maxLength: 60_000 },
    findings: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "title", "body", "path", "startLine", "endLine"],
        properties: {
          severity: {
            type: "string",
            enum: ["critical", "major", "minor", "info"],
          },
          title: { type: "string", minLength: 1, maxLength: 200 },
          body: { type: "string", minLength: 1, maxLength: 8_000 },
          path: { type: ["string", "null"], minLength: 1, maxLength: 500 },
          startLine: {
            type: ["integer", "null"],
            minimum: 1,
            maximum: 1_000_000,
          },
          endLine: {
            type: ["integer", "null"],
            minimum: 1,
            maximum: 1_000_000,
          },
        },
      },
    },
  },
} as const;

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runGitLabReviewCli().catch((error: unknown) => {
    process.stderr.write(`${safeCliErrorCode(error)}\n`);
    process.exitCode = 1;
  });
}
