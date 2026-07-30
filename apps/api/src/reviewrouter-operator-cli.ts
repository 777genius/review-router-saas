#!/usr/bin/env node

import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ReviewReasoningEffort } from "@reviewrouter/features-review-config/review-reasoning-effort";
import { isScmProvider, type ScmProvider } from "@reviewrouter/shared/scm";

type OperatorCliEnvironment = Readonly<Record<string, string | undefined>>;
type OperatorCliFetch = typeof fetch;

type OperatorProfile = Readonly<{
  apiUrl: URL;
  credential: string;
}>;

type ParsedArguments = Readonly<{
  positionals: readonly string[];
  options: Readonly<Record<string, string | true>>;
}>;

export type ReviewRouterOperatorCliDependencies = Readonly<{
  fetchImpl?: OperatorCliFetch;
  readFileImpl?: typeof readFile;
  statImpl?: typeof stat;
  homeDirectory?: string;
}>;

export async function executeReviewRouterOperatorCli(
  argv: readonly string[],
  env: OperatorCliEnvironment,
  dependencies: ReviewRouterOperatorCliDependencies = {},
): Promise<unknown> {
  const parsed = parseArguments(argv);
  const command = parsed.positionals.join(" ");
  if (parsed.options.help === true || command.length === 0) {
    return { usage: usageText() };
  }
  if (command !== "config get" && command !== "config set") {
    throw new Error("reviewrouter_operator_command_unknown");
  }
  assertAllowedOptions(
    parsed,
    command === "config get"
      ? [
          "repo",
          "workspace",
          "provider",
          "source-base-url",
          "api-url",
          "profile",
        ]
      : [
          "repo",
          "effort",
          "reason",
          "workspace",
          "provider",
          "source-base-url",
          "api-url",
          "profile",
        ],
  );

  const repository = requireOption(parsed, "repo");
  const provider = parseProvider(readOption(parsed, "provider") ?? "github");
  const workspace = readOption(parsed, "workspace");
  const sourceBaseUrl = readOption(parsed, "source-base-url");
  const { apiUrl, credential } = await readOperatorProfile(
    parsed,
    env,
    dependencies,
  );
  const fetchImpl = dependencies.fetchImpl ?? fetch;

  if (command === "config get") {
    const query = new URLSearchParams({ repo: repository, provider });
    if (workspace) query.set("workspace", workspace);
    if (sourceBaseUrl) query.set("sourceBaseUrl", sourceBaseUrl);
    return requestJson(
      new URL(`/api/operator/v1/review-config?${query}`, apiUrl),
      {
        method: "GET",
        headers: operatorHeaders(credential),
        redirect: "error",
      },
      fetchImpl,
    );
  }

  const effort = parseReasoningEffort(requireOption(parsed, "effort"));
  const reason = readOption(parsed, "reason");
  return requestJson(
    new URL("/api/operator/v1/review-config", apiUrl),
    {
      method: "PATCH",
      headers: {
        ...operatorHeaders(credential),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        repository,
        provider,
        effort,
        ...(reason ? { reason } : {}),
        ...(workspace ? { workspace } : {}),
        ...(sourceBaseUrl ? { sourceBaseUrl } : {}),
      }),
      redirect: "error",
    },
    fetchImpl,
  );
}

export function parseArguments(argv: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const options: Record<string, string | true> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const name = value.slice(2);
    if (!name || Object.hasOwn(options, name)) {
      throw new Error("reviewrouter_operator_option_invalid");
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      options[name] = true;
      continue;
    }
    options[name] = next;
    index += 1;
  }
  return { positionals, options };
}

async function readOperatorProfile(
  parsed: ParsedArguments,
  env: OperatorCliEnvironment,
  dependencies: ReviewRouterOperatorCliDependencies,
): Promise<OperatorProfile> {
  const environmentCredential =
    env.REVIEW_ROUTER_REVIEW_CONFIG_OPERATOR_CREDENTIAL;
  const explicitApiUrl =
    readOption(parsed, "api-url") ?? env.REVIEW_ROUTER_API_URL?.trim();
  if (environmentCredential?.trim()) {
    if (!explicitApiUrl) {
      throw new Error("reviewrouter_operator_api_url_required");
    }
    return {
      apiUrl: parseApiUrl(explicitApiUrl),
      credential: validateCredential(environmentCredential.trim()),
    };
  }
  const profileFile =
    readOption(parsed, "profile") ??
    env.REVIEW_ROUTER_OPERATOR_PROFILE ??
    path.join(
      env.XDG_CONFIG_HOME ?? dependencies.homeDirectory ?? homedir(),
      ...(env.XDG_CONFIG_HOME ? [] : [".config"]),
      "reviewrouter",
      "operator.json",
    );
  if (process.platform !== "win32") {
    let profileStat: Awaited<ReturnType<typeof stat>>;
    try {
      profileStat = await (dependencies.statImpl ?? stat)(profileFile);
    } catch {
      throw new Error("reviewrouter_operator_profile_unavailable");
    }
    if (!profileStat.isFile() || (profileStat.mode & 0o077) !== 0) {
      throw new Error("reviewrouter_operator_profile_permissions_invalid");
    }
  }
  let value: string;
  try {
    value = await (dependencies.readFileImpl ?? readFile)(profileFile, "utf8");
  } catch {
    throw new Error("reviewrouter_operator_profile_unavailable");
  }
  let parsedProfile: {
    readonly apiUrl?: unknown;
    readonly credential?: unknown;
  };
  try {
    parsedProfile = JSON.parse(value) as {
      readonly apiUrl?: unknown;
      readonly credential?: unknown;
    };
  } catch {
    throw new Error("reviewrouter_operator_profile_invalid");
  }
  if (
    typeof parsedProfile.apiUrl !== "string" ||
    typeof parsedProfile.credential !== "string"
  ) {
    throw new Error("reviewrouter_operator_profile_invalid");
  }
  const profileApiUrl = parseApiUrl(parsedProfile.apiUrl);
  if (
    explicitApiUrl &&
    parseApiUrl(explicitApiUrl).href !== profileApiUrl.href
  ) {
    throw new Error("reviewrouter_operator_profile_api_url_mismatch");
  }
  return {
    apiUrl: profileApiUrl,
    credential: validateCredential(parsedProfile.credential),
  };
}

function validateCredential(value: string): string {
  if (value.length < 32 || value.length > 8_192 || /\s/.test(value)) {
    throw new Error("reviewrouter_operator_credential_invalid");
  }
  return value;
}

function parseProvider(value: string): ScmProvider {
  if (!isScmProvider(value)) {
    throw new Error("reviewrouter_operator_provider_invalid");
  }
  return value;
}

function parseReasoningEffort(value: string): ReviewReasoningEffort {
  if (
    !Object.values(ReviewReasoningEffort).includes(
      value as ReviewReasoningEffort,
    )
  ) {
    throw new Error("reviewrouter_operator_effort_invalid");
  }
  return value as ReviewReasoningEffort;
}

function parseApiUrl(value: string): URL {
  const url = new URL(value);
  const local =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("reviewrouter_operator_api_url_invalid");
  }
  return url;
}

function operatorHeaders(credential: string): Record<string, string> {
  return {
    authorization: `Bearer ${credential}`,
    accept: "application/json",
    "user-agent": "reviewrouter-operator-cli",
  };
}

async function requestJson(
  url: URL,
  init: RequestInit,
  fetchImpl: OperatorCliFetch,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    ...init,
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json()) as {
    readonly result?: unknown;
    readonly error?: { readonly code?: unknown };
  };
  if (!response.ok) {
    const code =
      typeof body.error?.code === "string" ? body.error.code : "unknown_error";
    throw new Error(
      `reviewrouter_operator_api_error:${response.status}:${code}`,
    );
  }
  return body.result;
}

function requireOption(parsed: ParsedArguments, name: string): string {
  const value = readOption(parsed, name);
  if (!value) throw new Error(`reviewrouter_operator_option_required:${name}`);
  return value;
}

function assertAllowedOptions(
  parsed: ParsedArguments,
  allowedOptions: readonly string[],
): void {
  const allowed = new Set(allowedOptions);
  if (Object.keys(parsed.options).some((name) => !allowed.has(name))) {
    throw new Error("reviewrouter_operator_option_unknown");
  }
}

function readOption(parsed: ParsedArguments, name: string): string | undefined {
  const value = parsed.options[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function usageText(): string {
  return [
    "ReviewRouter operator CLI",
    "",
    "  reviewrouter config get --repo OWNER/REPO [--workspace SLUG] [--provider github|gitlab] [--source-base-url URL] [--profile PATH]",
    "  reviewrouter config set --repo OWNER/REPO --effort low|medium|high|xhigh [--reason TEXT] [--workspace SLUG] [--provider github|gitlab] [--source-base-url URL] [--profile PATH]",
  ].join("\n");
}

async function main(): Promise<void> {
  const result = await executeReviewRouterOperatorCli(
    process.argv.slice(2),
    process.env,
  );
  if (
    result &&
    typeof result === "object" &&
    "usage" in result &&
    typeof result.usage === "string"
  ) {
    process.stdout.write(`${result.usage}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const entrypoint = process.argv[1];
if (
  entrypoint &&
  (await realpath(entrypoint).catch(() => path.resolve(entrypoint))) ===
    (await realpath(fileURLToPath(import.meta.url)).catch(() =>
      path.resolve(fileURLToPath(import.meta.url)),
    ))
) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown_error";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
