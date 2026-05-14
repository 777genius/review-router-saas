import { createHash } from "node:crypto";
import {
  actionConflictReviewRuntimeConfigSchema,
  conflictReviewAdvisoryStatusContext,
  conflictReviewSummaryMaxBytes,
  type ActionConflictReviewRuntimeConfig,
} from "@reviewrouter/features-action-control-plane";
import { z } from "zod";

export const conflictRuntimeProviderEnvAllowlist = [
  "REVIEW_AUTH_MODE",
  "REVIEW_PROVIDERS",
  "PROVIDER_LIMIT",
  "PROVIDER_MAX_PARALLEL",
  "INLINE_MIN_AGREEMENT",
  "SYNTHESIS_MODEL",
  "CODEX_MODEL",
  "CODEX_REASONING_EFFORT",
  "CODEX_AGENTIC_CONTEXT",
  "CODEX_FAST_MODE",
  "CODEX_AUTH_JSON",
  "CODEX_CONFIG_TOML",
  "OPENAI_API_KEY",
] as const;

export const conflictRuntimeForbiddenProviderEnvPatterns = [
  /^GITHUB_/,
  /^ACTIONS_ID_TOKEN_/,
  /^REVIEW_ROUTER_CONFLICT_/,
  /^REVIEW_ROUTER_ACTION_SESSION/,
  /^REVIEW_ROUTER_POSTING_/,
  /^REVIEWROUTER_ACTION_SESSION/,
  /^REVIEWROUTER_POSTING_/,
  /OIDC/i,
  /SESSION_TOKEN/i,
  /NONCE/i,
] as const;

export type ConflictRuntimeProviderEnvKey =
  (typeof conflictRuntimeProviderEnvAllowlist)[number];

export type ConflictRuntimeCheckoutPlan = {
  readonly mode: "exact_head_sha";
  readonly headSha: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly persistCredentials: false;
};

export type ConflictRuntimeFileDiff = {
  readonly path: string;
  readonly previousPath?: string | undefined;
  readonly status:
    | "added"
    | "modified"
    | "removed"
    | "renamed"
    | "copied"
    | "changed";
  readonly patch?: string | undefined;
  readonly binary?: boolean | undefined;
};

export type ConflictRuntimeBoundedFileDiff = {
  readonly path: string;
  readonly previousPath?: string | undefined;
  readonly status: ConflictRuntimeFileDiff["status"];
  readonly binary: boolean;
  readonly patch: string;
  readonly patchBytes: number;
  readonly patchSha256: string;
  readonly truncated: boolean;
};

export type ConflictRuntimeDiffPacket = {
  readonly protocolVersion: 1;
  readonly baseSha: string;
  readonly headSha: string;
  readonly files: readonly ConflictRuntimeBoundedFileDiff[];
  readonly omittedFileCount: number;
  readonly totalPatchBytes: number;
  readonly truncated: boolean;
  readonly manifestHash: string;
};

export type ConflictRuntimeModelOutput = z.infer<
  typeof conflictRuntimeModelOutputSchema
>;

export type ConflictRuntimePostingManifest = {
  readonly protocolVersion: 1;
  readonly dispatchId: string;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly diffManifestHash: string;
  readonly diffTruncated: boolean;
  readonly omittedFileCount: number;
  readonly summaryMarkdownSha256: string;
  readonly findingFingerprints: readonly string[];
  readonly advisoryStatus: {
    readonly context: typeof conflictReviewAdvisoryStatusContext;
    readonly state: "success";
  };
  readonly manifestHash: string;
};

const providerEnvSchema = z.record(z.string(), z.string().optional());
const safeModelMarkdownSchema = createSafeModelMarkdownSchema(
  conflictReviewSummaryMaxBytes,
);

export const conflictRuntimeModelFindingSchema = z
  .object({
    severity: z.enum(["critical", "major", "minor", "info"]),
    title: createSafeModelMarkdownSchema(200),
    body: createSafeModelMarkdownSchema(4_000),
    path: z
      .string()
      .optional()
      .transform((value) =>
        value === undefined
          ? undefined
          : normalizeConflictRuntimeRepositoryPath(value),
      ),
    startLine: z.number().int().positive().max(1_000_000).optional(),
    endLine: z.number().int().positive().max(1_000_000).optional(),
  })
  .strict()
  .superRefine((finding, context) => {
    if (
      finding.startLine !== undefined &&
      finding.endLine !== undefined &&
      finding.endLine < finding.startLine
    ) {
      context.addIssue({
        code: "custom",
        message: "conflict_model_output_line_range_invalid",
      });
    }
  });

export const conflictRuntimeModelOutputSchema = z
  .object({
    protocolVersion: z.literal(1),
    summaryMarkdown: safeModelMarkdownSchema,
    findings: z.array(conflictRuntimeModelFindingSchema).max(50).default([]),
  })
  .strict();

export function parseConflictRuntimeConfig(
  input: unknown,
): ActionConflictReviewRuntimeConfig {
  return actionConflictReviewRuntimeConfigSchema.parse(input);
}

export function parseConflictRuntimeModelOutput(
  input: unknown,
): ConflictRuntimeModelOutput {
  return conflictRuntimeModelOutputSchema.parse(input);
}

export function buildConflictRuntimeSummaryMarkdown(
  output: ConflictRuntimeModelOutput,
): string {
  const parsed = parseConflictRuntimeModelOutput(output);
  const lines = [parsed.summaryMarkdown.trim()];
  if (parsed.findings.length > 0) {
    lines.push("", "Findings:");
    for (const finding of parsed.findings) {
      const location = finding.path
        ? ` (${escapeMarkdownInline(finding.path)}${finding.startLine ? `:${finding.startLine}` : ""})`
        : "";
      lines.push(`- [${finding.severity}] ${finding.title.trim()}${location}`);
    }
  }
  const markdown = lines.join("\n");
  if (byteLength(markdown) > conflictReviewSummaryMaxBytes) {
    throw new Error("conflict_model_output_summary_too_large");
  }
  return markdown;
}

export function buildConflictRuntimePostingManifest(input: {
  readonly config: ActionConflictReviewRuntimeConfig;
  readonly diffPacket: ConflictRuntimeDiffPacket;
  readonly modelOutput: ConflictRuntimeModelOutput;
  readonly summaryMarkdown: string;
}): ConflictRuntimePostingManifest {
  const config = parseConflictRuntimeConfig(input.config);
  const modelOutput = parseConflictRuntimeModelOutput(input.modelOutput);
  const summaryMarkdown = input.summaryMarkdown.trim();
  if (summaryMarkdown.length === 0) {
    throw new Error("conflict_posting_manifest_summary_invalid");
  }
  const manifestWithoutHash = {
    protocolVersion: 1 as const,
    dispatchId: config.dispatchId,
    pullRequestNumber: config.pullRequestNumber,
    headSha: config.headSha,
    baseRef: config.baseRef,
    baseSha: config.baseSha,
    diffManifestHash: input.diffPacket.manifestHash,
    diffTruncated: input.diffPacket.truncated,
    omittedFileCount: input.diffPacket.omittedFileCount,
    summaryMarkdownSha256: sha256(summaryMarkdown),
    findingFingerprints: modelOutput.findings.map((finding) =>
      sha256(
        canonicalJson({
          severity: finding.severity,
          title: finding.title,
          body: finding.body,
          path: finding.path ?? null,
          startLine: finding.startLine ?? null,
          endLine: finding.endLine ?? null,
        }),
      ),
    ),
    advisoryStatus: {
      context: conflictReviewAdvisoryStatusContext,
      state: "success" as const,
    } as const,
  };
  return {
    ...manifestWithoutHash,
    manifestHash: sha256(canonicalJson(manifestWithoutHash)),
  };
}

export function buildConflictRuntimeCheckoutPlan(
  config: ActionConflictReviewRuntimeConfig,
): ConflictRuntimeCheckoutPlan {
  const parsed = parseConflictRuntimeConfig(config);
  return parsed.checkout;
}

export function buildConflictProviderEnvironment(input: {
  readonly sourceEnv: Readonly<Record<string, string | undefined>>;
  readonly allowlist?: readonly ConflictRuntimeProviderEnvKey[] | undefined;
}): Readonly<Record<string, string>> {
  const sourceEnv = providerEnvSchema.parse(input.sourceEnv);
  const allowlist = input.allowlist ?? conflictRuntimeProviderEnvAllowlist;
  const providerEnv: Record<string, string> = {};

  for (const key of allowlist) {
    assertProviderEnvKeyAllowed(key);
    const value = sourceEnv[key];
    if (typeof value === "string" && value.length > 0) {
      providerEnv[key] = value;
    }
  }
  assertProviderEnvironmentHasNoRuntimeSecrets(providerEnv);
  return providerEnv;
}

export function assertProviderEnvironmentHasNoRuntimeSecrets(
  env: Readonly<Record<string, string | undefined>>,
): void {
  for (const key of Object.keys(env)) {
    assertProviderEnvKeyAllowed(key);
  }
}

export function buildBoundedConflictDiffPacket(input: {
  readonly config: ActionConflictReviewRuntimeConfig;
  readonly files: readonly ConflictRuntimeFileDiff[];
}): ConflictRuntimeDiffPacket {
  const config = parseConflictRuntimeConfig(input.config);
  const files = normalizeAndSortDiffFiles(input.files);
  const boundedFiles: ConflictRuntimeBoundedFileDiff[] = [];
  let totalPatchBytes = 0;
  let truncated = false;

  for (const file of files) {
    if (boundedFiles.length >= config.diff.maxFiles) {
      truncated = true;
      continue;
    }
    const patch = file.binary === true ? "" : (file.patch ?? "");
    const remainingBytes = config.diff.maxBytes - totalPatchBytes;
    if (remainingBytes <= 0) {
      truncated = true;
      continue;
    }
    const patchMaxBytes = Math.min(
      config.diff.maxPatchBytesPerFile,
      remainingBytes,
    );
    const boundedPatch = sliceUtf8(patch, patchMaxBytes);
    const patchBytes = byteLength(boundedPatch);
    const fileTruncated = patchBytes < byteLength(patch);
    totalPatchBytes += patchBytes;
    truncated = truncated || fileTruncated;
    boundedFiles.push({
      path: file.path,
      ...(file.previousPath ? { previousPath: file.previousPath } : {}),
      status: file.status,
      binary: file.binary === true,
      patch: boundedPatch,
      patchBytes,
      patchSha256: sha256(boundedPatch),
      truncated: fileTruncated,
    });
  }

  const omittedFileCount = Math.max(files.length - boundedFiles.length, 0);
  const packetWithoutHash = {
    protocolVersion: 1 as const,
    baseSha: config.diff.baseSha,
    headSha: config.diff.headSha,
    files: boundedFiles,
    omittedFileCount,
    totalPatchBytes,
    truncated,
  };

  return {
    ...packetWithoutHash,
    manifestHash: sha256(canonicalJson(packetWithoutHash)),
  };
}

function normalizeAndSortDiffFiles(
  files: readonly ConflictRuntimeFileDiff[],
): readonly ConflictRuntimeFileDiff[] {
  const seen = new Set<string>();
  const seenDisplayKeys = new Set<string>();
  return files
    .map((file) => {
      const path = normalizeConflictRuntimeRepositoryPath(file.path);
      const previousPath =
        file.previousPath === undefined
          ? undefined
          : normalizeConflictRuntimeRepositoryPath(file.previousPath);
      if (seen.has(path)) {
        throw new Error("conflict_diff_path_collision");
      }
      const displayKey = path.toLowerCase();
      if (seenDisplayKeys.has(displayKey)) {
        throw new Error("conflict_diff_path_collision");
      }
      seen.add(path);
      seenDisplayKeys.add(displayKey);
      return {
        ...file,
        path,
        ...(previousPath ? { previousPath } : {}),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function createSafeModelMarkdownSchema(maxLength: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(maxLength)
    .superRefine((value, context) => {
      if (/<!--|-->|reviewrouter:conflict-review/i.test(value)) {
        context.addIssue({
          code: "custom",
          message: "conflict_model_output_marker_forbidden",
        });
      }
      if (/merge result was reviewed|required review passed/i.test(value)) {
        context.addIssue({
          code: "custom",
          message: "conflict_model_output_claim_forbidden",
        });
      }
      if ((value.match(/@[A-Za-z0-9_-]+/g) ?? []).length > 10) {
        context.addIssue({
          code: "custom",
          message: "conflict_model_output_mentions_unbounded",
        });
      }
    });
}

export function normalizeConflictRuntimeRepositoryPath(path: string): string {
  const normalized = path.normalize("NFC");
  if (
    normalized.length === 0 ||
    normalized.length > 500 ||
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    hasUnsafePathControlCharacters(normalized)
  ) {
    throw new Error("conflict_diff_path_unsafe");
  }
  const segments = normalized.split("/");
  if (
    segments.some((segment) => segment.length === 0 || segment === ".") ||
    segments.some((segment) => segment === "..") ||
    segments[0]?.toLowerCase() === ".git"
  ) {
    throw new Error("conflict_diff_path_unsafe");
  }
  return normalized;
}

function hasUnsafePathControlCharacters(path: string): boolean {
  for (const character of path) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f ||
        codePoint === 0x7f ||
        (codePoint >= 0x202a && codePoint <= 0x202e) ||
        (codePoint >= 0x2066 && codePoint <= 0x2069))
    ) {
      return true;
    }
  }
  return false;
}

function escapeMarkdownInline(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("<", "\\<")
    .replaceAll(">", "\\>")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)");
}

function assertProviderEnvKeyAllowed(key: string): void {
  if (
    conflictRuntimeForbiddenProviderEnvPatterns.some((pattern) =>
      pattern.test(key),
    )
  ) {
    throw new Error("conflict_provider_env_contains_runtime_secret");
  }
}

function sliceUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return value;
  }
  let sliced = buffer.subarray(0, maxBytes).toString("utf8");
  while (byteLength(sliced) > maxBytes) {
    sliced = sliced.slice(0, -1);
  }
  return sliced;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
