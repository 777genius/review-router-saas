#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isScmProvider, type ScmProvider } from "@reviewrouter/shared";
import { reviewFindingsArtifactFileName } from "../../domain/review-findings-artifact";
import type {
  ReviewPublicationMode,
  ReviewPublicationTarget,
} from "../../domain/review-publication";
import type { ReviewPublisherPort } from "../../application/ports/review-publisher-port";
import { publishReviewFindingsArtifact } from "../../application/use-cases/publish-review-findings-artifact";
import { GitHubSummaryReviewPublisher } from "../../infrastructure/github/github-summary-review-publisher";
import { GitLabReviewPublisher } from "../../infrastructure/gitlab/gitlab-review-publisher";

type FetchLike = typeof fetch;

type CliStream = {
  write(chunk: string): unknown;
};

type ReadFileLike = (path: string, encoding: "utf8") => Promise<string>;

type GitHubCommentTokenResponse = {
  readonly token?: unknown;
  readonly repository?: unknown;
  readonly permissions?: unknown;
};

const GITHUB_COMMENT_TOKEN_REFRESH_TIMEOUT_MS = 10_000;

export type ReviewPublisherCliInput = {
  readonly argv?: readonly string[] | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly cwd?: string | undefined;
  readonly fetchImpl?: FetchLike | undefined;
  readonly readFileImpl?: ReadFileLike | undefined;
  readonly stdout?: CliStream | undefined;
  readonly stderr?: CliStream | undefined;
};

type CliOptions = {
  readonly artifactPath?: string | undefined;
  readonly provider?: ScmProvider | undefined;
  readonly marker?: string | undefined;
  readonly mode?: ReviewPublicationMode | undefined;
  readonly maxInlineComments?: number | undefined;
  readonly help: boolean;
};

export async function runReviewPublisherCli(
  input: ReviewPublisherCliInput = {},
): Promise<void> {
  const argv = input.argv ?? process.argv.slice(2);
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  const stdout = input.stdout ?? process.stdout;
  const options = parseCliOptions(argv);

  if (options.help) {
    stdout.write(helpText());
    return;
  }

  const provider = readProvider({ cliProvider: options.provider, env });
  const artifactPath = resolve(
    cwd,
    options.artifactPath ??
      readOptionalEnv(env, "REVIEWROUTER_FINDINGS_ARTIFACT_PATH") ??
      reviewFindingsArtifactFileName,
  );
  const target = buildTargetFromEnv({ provider, env });
  const publisher = buildPublisherFromEnv({
    provider,
    env,
    fetchImpl: input.fetchImpl ?? fetch,
  });
  const artifactJson = await (input.readFileImpl ?? readFile)(
    artifactPath,
    "utf8",
  );
  const result = await publishReviewFindingsArtifact(
    {
      artifactJson,
      target,
      marker:
        options.marker ??
        readOptionalEnv(env, "REVIEWROUTER_REVIEW_MARKER") ??
        `reviewrouter:${provider}:review`,
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.maxInlineComments !== undefined
        ? { maxInlineComments: options.maxInlineComments }
        : readMaxInlineCommentsFromEnv(env)),
    },
    { publisher },
  );

  stdout.write(`${JSON.stringify(toSafeCliResult(result), null, 2)}\n`);
}

function parseCliOptions(argv: readonly string[]): CliOptions {
  const options: {
    artifactPath?: string;
    provider?: ScmProvider;
    marker?: string;
    mode?: ReviewPublicationMode;
    maxInlineComments?: number;
    help: boolean;
  } = { help: false };

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
    if (arg === "--provider") {
      const provider = readCliValue(argv, index, arg);
      if (!isScmProvider(provider)) {
        throw new Error("review_publish_provider_invalid");
      }
      options.provider = provider;
      index += 1;
      continue;
    }
    if (arg === "--marker") {
      options.marker = readCliValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--mode") {
      options.mode = parseMode(readCliValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--max-inline-comments") {
      options.maxInlineComments = parseNonNegativeInteger(
        readCliValue(argv, index, arg),
        "review_publish_max_inline_comments_invalid",
      );
      index += 1;
      continue;
    }
    throw new Error(`review_publish_argument_unknown:${arg}`);
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
    throw new Error(`review_publish_argument_value_missing:${option}`);
  }
  return value;
}

function readProvider(input: {
  readonly cliProvider?: ScmProvider | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
}): ScmProvider {
  if (input.cliProvider) {
    return input.cliProvider;
  }
  const envProvider = readOptionalEnv(input.env, "REVIEWROUTER_SCM_PROVIDER");
  if (envProvider) {
    if (!isScmProvider(envProvider)) {
      throw new Error("review_publish_provider_invalid");
    }
    return envProvider;
  }
  if (readOptionalEnv(input.env, "GITLAB_CI")) {
    return "gitlab";
  }
  if (readOptionalEnv(input.env, "GITHUB_ACTIONS")) {
    return "github";
  }
  throw new Error("review_publish_provider_required");
}

function buildTargetFromEnv(input: {
  readonly provider: ScmProvider;
  readonly env: Readonly<Record<string, string | undefined>>;
}): ReviewPublicationTarget {
  switch (input.provider) {
    case "github":
      return {
        provider: "github",
        repositoryExternalId:
          readOptionalEnv(input.env, "REVIEWROUTER_REPOSITORY_EXTERNAL_ID") ??
          readOptionalEnv(input.env, "GITHUB_REPOSITORY_ID") ??
          readRequiredEnv(input.env, "GITHUB_REPOSITORY"),
        repositoryFullName:
          readOptionalEnv(input.env, "REVIEWROUTER_REPOSITORY_FULL_NAME") ??
          readRequiredEnv(input.env, "GITHUB_REPOSITORY"),
        changeRequestExternalId:
          readOptionalEnv(
            input.env,
            "REVIEWROUTER_CHANGE_REQUEST_EXTERNAL_ID",
          ) ?? readRequiredEnv(input.env, "PR_NUMBER"),
        headSha:
          readOptionalEnv(input.env, "REVIEWROUTER_HEAD_SHA") ??
          readRequiredEnv(input.env, "GITHUB_SHA"),
        ...optionalShaField(input.env, "baseSha", [
          "REVIEWROUTER_BASE_SHA",
          "GITHUB_BASE_SHA",
        ]),
        ...optionalShaField(input.env, "startSha", [
          "REVIEWROUTER_START_SHA",
          "GITHUB_START_SHA",
        ]),
      };
    case "gitlab":
      return {
        provider: "gitlab",
        repositoryExternalId:
          readOptionalEnv(input.env, "REVIEWROUTER_REPOSITORY_EXTERNAL_ID") ??
          readRequiredEnv(input.env, "CI_PROJECT_ID"),
        repositoryFullName:
          readOptionalEnv(input.env, "REVIEWROUTER_REPOSITORY_FULL_NAME") ??
          readRequiredEnv(input.env, "CI_PROJECT_PATH"),
        changeRequestExternalId:
          readOptionalEnv(
            input.env,
            "REVIEWROUTER_CHANGE_REQUEST_EXTERNAL_ID",
          ) ?? readRequiredEnv(input.env, "CI_MERGE_REQUEST_IID"),
        headSha:
          readOptionalEnv(input.env, "REVIEWROUTER_HEAD_SHA") ??
          readRequiredEnv(input.env, "CI_COMMIT_SHA"),
        ...optionalShaField(input.env, "baseSha", [
          "REVIEWROUTER_BASE_SHA",
          "CI_MERGE_REQUEST_DIFF_BASE_SHA",
        ]),
        ...optionalShaField(input.env, "startSha", [
          "REVIEWROUTER_START_SHA",
          "CI_MERGE_REQUEST_DIFF_START_SHA",
        ]),
      };
  }
}

function buildPublisherFromEnv(input: {
  readonly provider: ScmProvider;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl: FetchLike;
}): ReviewPublisherPort {
  switch (input.provider) {
    case "github":
      return new GitHubSummaryReviewPublisher({
        token:
          readOptionalEnv(input.env, "REVIEWROUTER_GITHUB_TOKEN") ??
          readRequiredEnv(input.env, "GITHUB_TOKEN"),
        ...optionalGitHubTokenRefresh(input.env, input.fetchImpl),
        ...(readOptionalEnv(input.env, "REVIEWROUTER_GITHUB_API_BASE_URL")
          ? {
              apiBaseUrl: readOptionalEnv(
                input.env,
                "REVIEWROUTER_GITHUB_API_BASE_URL",
              ),
            }
          : {}),
        fetchImpl: input.fetchImpl,
      });
    case "gitlab":
      return new GitLabReviewPublisher({
        token: readRequiredEnv(input.env, "REVIEWROUTER_GITLAB_TOKEN"),
        ...(readOptionalEnv(input.env, "REVIEWROUTER_GITLAB_API_BASE_URL")
          ? {
              apiBaseUrl: readOptionalEnv(
                input.env,
                "REVIEWROUTER_GITLAB_API_BASE_URL",
              ),
            }
          : {}),
        fetchImpl: input.fetchImpl,
      });
  }
}

function optionalGitHubTokenRefresh(
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl: FetchLike,
):
  | {
      readonly tokenRefresh: { refreshToken(): Promise<string> };
    }
  | Record<string, never> {
  const refreshUrl = readOptionalEnv(
    env,
    "REVIEWROUTER_COMMENT_TOKEN_REFRESH_URL",
  );
  const leaseId = readOptionalEnv(env, "REVIEWROUTER_COMMENT_TOKEN_LEASE_ID");
  const providerInstanceId = readOptionalEnv(
    env,
    "REVIEWROUTER_COMMENT_TOKEN_PROVIDER_INSTANCE_ID",
  );
  if (!refreshUrl && !leaseId && !providerInstanceId) return {};
  if (!refreshUrl || !leaseId || !providerInstanceId) {
    throw new Error("github_comment_token_refresh_config_incomplete");
  }

  return {
    tokenRefresh: {
      refreshToken: () =>
        refreshGitHubCommentToken({
          fetchImpl,
          refreshUrl,
          leaseId,
          providerInstanceId,
        }),
    },
  };
}

async function refreshGitHubCommentToken(input: {
  readonly fetchImpl: FetchLike;
  readonly refreshUrl: string;
  readonly leaseId: string;
  readonly providerInstanceId: string;
}): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    GITHUB_COMMENT_TOKEN_REFRESH_TIMEOUT_MS,
  );
  let response: Response;
  try {
    response = await input.fetchImpl(input.refreshUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        leaseId: input.leaseId,
        providerInstanceId: input.providerInstanceId,
        authCleared: true,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error("github_comment_token_refresh_timeout", {
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`github_comment_token_refresh_failed:${response.status}`);
  }

  const payload = (await response.json()) as GitHubCommentTokenResponse;
  if (typeof payload.token !== "string" || payload.token.trim().length === 0) {
    throw new Error("github_comment_token_refresh_invalid");
  }
  return payload.token;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException ||
      (typeof error === "object" && error !== null && "name" in error)) &&
    (error as { readonly name?: unknown }).name === "AbortError"
  );
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
          "review_publish_max_inline_comments_invalid",
        ),
      }
    : {};
}

function optionalShaField(
  env: Readonly<Record<string, string | undefined>>,
  field: "baseSha" | "startSha",
  keys: readonly string[],
): { readonly baseSha?: string | undefined } | { readonly startSha?: string } {
  for (const key of keys) {
    const value = readOptionalEnv(env, key);
    if (value) {
      return field === "baseSha" ? { baseSha: value } : { startSha: value };
    }
  }
  return {};
}

function parseMode(value: string): ReviewPublicationMode {
  if (value === "inline-and-summary" || value === "summary-only") {
    return value;
  }
  throw new Error("review_publish_mode_invalid");
}

function parseNonNegativeInteger(value: string, errorCode: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(errorCode);
  }
  return Number(value);
}

function readRequiredEnv(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): string {
  const value = readOptionalEnv(env, key);
  if (!value) {
    throw new Error(`review_publish_env_missing:${key}`);
  }
  return value;
}

function readOptionalEnv(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function toSafeCliResult(
  result: Awaited<ReturnType<ReviewPublisherPort["publishReview"]>>,
) {
  return {
    protocolVersion: 1,
    provider: result.target.provider,
    repositoryExternalId: result.target.repositoryExternalId,
    changeRequestExternalId: result.target.changeRequestExternalId,
    inlineCommentCount: result.inlineCommentCount,
    summaryCommentCount: result.summaryCommentCount,
    skippedInlineFindings: result.skippedInlineFindings,
    externalIds: result.externalIds,
  };
}

function helpText(): string {
  return [
    "Usage: reviewrouter-publish-review [--artifact reviewrouter-findings.json] [--provider github|gitlab]",
    "",
    "Publishes a CI-local ReviewRouter findings artifact through the configured SCM provider.",
    "Required provider env is read from GitHub Actions or GitLab CI variables.",
    "",
  ].join("\n");
}

function safeCliErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown_error";
  return message.replaceAll(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 160);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runReviewPublisherCli().catch((error: unknown) => {
    process.stderr.write(`${safeCliErrorCode(error)}\n`);
    process.exitCode = 1;
  });
}
