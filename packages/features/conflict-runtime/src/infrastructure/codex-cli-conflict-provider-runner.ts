import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionConflictReviewRuntimeConfig } from "@reviewrouter/features-action-control-plane";
import type { ConflictRuntimeProviderRunnerPort } from "../application/conflict-runtime-runner.js";
import {
  parseConflictRuntimeModelOutput,
  type ConflictRuntimeDiffPacket,
} from "../domain/conflict-runtime.js";
import {
  nodeCommandRunner,
  type ConflictRuntimeCommandRunner,
} from "./node-command-runner.js";

export type CodexCliConflictProviderRunnerOptions = {
  readonly workspace: string;
  readonly command?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly tempRoot?: string | undefined;
  readonly runCommand?: ConflictRuntimeCommandRunner | undefined;
};

const defaultTimeoutMs = 15 * 60 * 1000;

export class CodexCliConflictProviderRunner implements ConflictRuntimeProviderRunnerPort {
  private readonly workspace: string;
  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly tempRoot: string;
  private readonly runCommand: ConflictRuntimeCommandRunner;

  constructor(options: CodexCliConflictProviderRunnerOptions) {
    this.workspace = options.workspace;
    this.command = options.command ?? "codex";
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.tempRoot = options.tempRoot ?? tmpdir();
    this.runCommand = options.runCommand ?? nodeCommandRunner;
  }

  async runReview(input: {
    readonly config: ActionConflictReviewRuntimeConfig;
    readonly diffPacket: ConflictRuntimeDiffPacket;
    readonly providerEnv: Readonly<Record<string, string>>;
  }): Promise<unknown> {
    const authMode = input.providerEnv.REVIEW_AUTH_MODE;
    if (authMode !== "codex-oauth" && authMode !== "openai-api") {
      throw new Error("conflict_provider_runtime_unsupported");
    }
    const model = input.providerEnv.CODEX_MODEL?.trim();
    if (!model) {
      throw new Error("conflict_provider_codex_model_missing");
    }

    const tempDir = await mkdtemp(
      join(this.tempRoot, "reviewrouter-conflict-"),
    );
    try {
      const schemaFile = join(tempDir, "model-output.schema.json");
      const outputFile = join(tempDir, "model-output.json");
      await writeFile(schemaFile, JSON.stringify(modelOutputJsonSchema), {
        encoding: "utf8",
        mode: 0o600,
      });
      const codexHome = await prepareCodexHome(tempDir, input.providerEnv);
      const commandEnv = buildCodexCommandEnvironment({
        providerEnv: input.providerEnv,
        codexHome,
      });
      const prompt = buildCodexConflictReviewPrompt(input);
      await this.runCommand({
        command: this.command,
        args: buildCodexExecArgs({
          model,
          reasoningEffort: input.providerEnv.CODEX_REASONING_EFFORT,
          schemaFile,
          outputFile,
          workspace: this.workspace,
        }),
        cwd: this.workspace,
        env: commandEnv,
        stdin: prompt,
        timeoutMs: this.timeoutMs,
        maxStdoutBytes: 128 * 1024,
        maxStderrBytes: 128 * 1024,
      });
      const rawOutput = await readFile(outputFile, "utf8");
      return parseConflictRuntimeModelOutput(JSON.parse(rawOutput));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
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

function buildCodexConflictReviewPrompt(input: {
  readonly config: ActionConflictReviewRuntimeConfig;
  readonly diffPacket: ConflictRuntimeDiffPacket;
  readonly providerEnv: Readonly<Record<string, string>>;
}): string {
  return [
    "You are ReviewRouter conflict-head runtime.",
    "",
    "Review only the provided bounded diff for bugs, security issues, and clear regressions.",
    "This is not a merge-result review. Do not claim branch protection passed or that the merge result was reviewed.",
    "Return only JSON that matches the provided schema.",
    "For findings without a file path or line range, set path, startLine, and endLine to null.",
    ...conflictReviewLanguageDirective(
      input.providerEnv.REVIEW_OUTPUT_LANGUAGE,
    ),
    "",
    "Context:",
    JSON.stringify(
      {
        reviewKind: input.config.reviewKind,
        pullRequestNumber: input.config.pullRequestNumber,
        headSha: input.config.headSha,
        baseRef: input.config.baseRef,
        baseSha: input.config.baseSha,
        diffTruncated: input.diffPacket.truncated,
        omittedFileCount: input.diffPacket.omittedFileCount,
        model: input.providerEnv.CODEX_MODEL,
        reasoningEffort: input.providerEnv.CODEX_REASONING_EFFORT,
      },
      null,
      2,
    ),
    "",
    "Bounded diff packet:",
    JSON.stringify(input.diffPacket, null, 2),
  ].join("\n");
}

function conflictReviewLanguageDirective(
  value: string | undefined,
): readonly string[] {
  const language = normalizeConflictReviewLanguage(value);
  if (!language) {
    return [];
  }
  return [
    "",
    `Write "summaryMarkdown" and every finding "message" in ${language}. Keep the JSON structure, field names, severity values, file paths, and code identifiers unchanged; never translate code or JSON keys.`,
  ];
}

/**
 * Mirror of the saas-side language sanitizer: keep a single line of
 * letters/marks/spaces, cap the length, and skip English (the default) so the
 * prompt stays byte-identical for English reviews.
 */
function normalizeConflictReviewLanguage(
  value: string | undefined,
): string | null {
  if (!value) {
    return null;
  }
  const firstLine = value.split(/[\r\n]/)[0] ?? "";
  const cleaned = firstLine
    .replace(/[^\p{L}\p{M}\s()\-\/]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  if (!cleaned) {
    return null;
  }
  const lower = cleaned.toLowerCase();
  if (lower === "english" || lower === "en" || lower === "en-us") {
    return null;
  }
  return cleaned;
}

async function prepareCodexHome(
  tempDir: string,
  providerEnv: Readonly<Record<string, string>>,
): Promise<string> {
  const codexHome = join(tempDir, "codex-home");
  await writeFile(join(tempDir, ".keep"), "", { mode: 0o600 });
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  const authJson = providerEnv.CODEX_AUTH_JSON;
  if (authJson) {
    const authFile = join(codexHome, "auth.json");
    await writeFile(authFile, authJson, { encoding: "utf8", mode: 0o600 });
    await chmod(authFile, 0o600);
  }
  const configToml = providerEnv.CODEX_CONFIG_TOML;
  if (configToml) {
    const configFile = join(codexHome, "config.toml");
    await writeFile(configFile, configToml, { encoding: "utf8", mode: 0o600 });
    await chmod(configFile, 0o600);
  }
  return codexHome;
}

function buildCodexCommandEnvironment(input: {
  readonly providerEnv: Readonly<Record<string, string>>;
  readonly codexHome: string;
}): Readonly<Record<string, string | undefined>> {
  return {
    PATH: process.env.PATH,
    HOME: input.codexHome,
    XDG_CONFIG_HOME: join(input.codexHome, "config"),
    XDG_CACHE_HOME: join(input.codexHome, "cache"),
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    TEMP: process.env.TEMP ?? tmpdir(),
    TMP: process.env.TMP ?? tmpdir(),
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL,
    CI: "true",
    CODEX_HOME: input.codexHome,
    OPENAI_API_KEY: input.providerEnv.OPENAI_API_KEY,
  };
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
          body: { type: "string", minLength: 1, maxLength: 4_000 },
          path: {
            type: ["string", "null"],
            minLength: 1,
            maxLength: 500,
          },
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
