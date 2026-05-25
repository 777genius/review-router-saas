import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import http from "node:http";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  chmod,
  mkdir,
  access,
  lstat,
  realpath,
  stat,
  statfs,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexRotatingRuntimeAuthMode,
  compactCodexAuthJson,
  computeCodexAuthGenerationHash,
  encryptCodexRotatingAuthForGitHubSecret,
  classifyCodexRuntimeFailure,
  pruneCodexRotatingChildEnv,
  validateCodexAuthJsonBytes,
} from "../domain/codex-oauth-rotating";

declare const __dirname: string | undefined;

const defaultOidcAudience = "reviewrouter";
const bundledCodexPlatform = "linux-x64";
const bundledCodexVersion = "0.125.0";
const bundledCodexPackageName = ["@openai", "codex"].join("/");
const bundledCodexArchiveName = "codex-linux-x64.tgz";
const bundledCodexBinaryPathInArchive =
  "package/vendor/x86_64-unknown-linux-musl/codex/codex";
const maxDiffBytes = 180_000;
const maxCommentBytes = 60_000;
const maxCapturedProcessOutputBytes = 256_000;
const maxProxyRequestBodyBytes = 2_000_000;
const maxProxyRequestsPerReview = 16;
const minimumRunnerFreeDiskBytes = 4 * 1024 * 1024 * 1024;
const supportedRunnerOs = "Linux";
const supportedRunnerArch = "X64";
const supportedRunnerImageOs = "ubuntu24";
const minimumNodeMajor = 20;

type FetchLike = typeof fetch;

type ActionIO = {
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
};

type ActionRuntime = {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly fetchImpl: FetchLike;
  readonly io: ActionIO;
  readonly localProviderProxyFactory: LocalProviderProxyFactory;
  readonly fullReviewRuntimeRunner: FullReviewRuntimeRunner;
};

type ActionInputs = {
  readonly mode: string;
  readonly apiUrl: string;
  readonly providerInstanceId: string;
  readonly workflowSchemaVersion: number;
};

type PullRequestEvent = {
  readonly number: number;
  readonly repository: string;
  readonly owner: string;
  readonly repo: string;
  readonly headSha: string;
  readonly baseSha: string;
};

type PreleaseResponse = {
  readonly leaseId: string;
  readonly generationHashSalt: string;
};

type FinalizeResponse =
  | {
      readonly status: "finalized";
      readonly nextGeneration: number;
      readonly repositoryOwner: string;
      readonly repositoryName: string;
      readonly publicKeyReadToken: string;
      readonly runtimeConfigVersion: number;
      readonly runtimeEnv: Record<string, string>;
    }
  | {
      readonly status: "stale_queued_secret";
      readonly nextGeneration: number;
    };

type GitHubPublicKeyResponse = {
  readonly key: string;
  readonly key_id: string;
};

type CheckoutTokenResponse = {
  readonly token: string;
  readonly repository: string;
};

type WritebackResponse = {
  readonly protocolVersion: 1;
  readonly status:
    | "accepted"
    | "idempotent_replay"
    | "github_put_failed"
    | "writeback_idempotency_conflict";
};

type CommentTokenResponse = {
  readonly token: string;
  readonly repository: string;
};

type GitHubIssueCommentResponse = {
  readonly id: number;
  readonly body?: string | null;
};

type LocalProviderProxy = {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
};

type LocalProviderProxyFactory = (input: {
  readonly fetchImpl: FetchLike;
  readonly accessToken: string;
  readonly upstreamResponsesUrl: string;
}) => Promise<LocalProviderProxy>;

type FullReviewRuntimeRunner = (input: {
  readonly inputs: ActionInputs;
  readonly codexBinaryPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly workspace: string;
  readonly tempHome: string;
  readonly tempCodexHome: string;
  readonly event: PullRequestEvent;
  readonly commentToken: string;
  readonly runtimeConfigVersion: number;
  readonly runtimeEnv: Record<string, string>;
}) => Promise<void>;

type CodexBinaryManifest = {
  readonly protocolVersion: 1;
  readonly packageName: string;
  readonly version: string;
  readonly platform: string;
  readonly archive: string;
  readonly archiveSize: number;
  readonly archiveSha256: string;
  readonly binaryPathInArchive: string;
  readonly binary: string;
  readonly size: number;
  readonly sha256: string;
};

type RunnerEnvironmentCheckOptions = {
  readonly minimumFreeDiskBytes?: number;
  readonly nodeVersion?: string;
};

export async function runCodexRotatingGitHubAction(
  runtime: Partial<ActionRuntime> = {},
): Promise<void> {
  const env = runtime.env ?? process.env;
  const io = runtime.io ?? { stdout: process.stdout, stderr: process.stderr };
  const fetchImpl = runtime.fetchImpl ?? fetch;
  const fullReviewRuntimeRunner =
    runtime.fullReviewRuntimeRunner ?? runFullReviewRouterRuntime;
  const inputs = readActionInputs(env);

  if (inputs.mode !== codexRotatingRuntimeAuthMode) {
    throw new Error(`unsupported_reviewrouter_action_mode:${inputs.mode}`);
  }

  const event = await readPullRequestEvent(env);
  assertSameRepositoryPullRequest(event, env);
  const oidcToken = await requestGitHubActionsOidcToken({
    env,
    fetchImpl,
    audience: defaultOidcAudience,
  });
  mask(io, oidcToken);
  clearOidcRequestEnv(env);

  const prelease = await postJson<PreleaseResponse>({
    fetchImpl,
    url: `${inputs.apiUrl}/api/action/v1/codex-oauth/prelease`,
    body: {
      oidcToken,
      audience: defaultOidcAudience,
      providerInstanceId: inputs.providerInstanceId,
      workflowSchemaVersion: inputs.workflowSchemaVersion,
    },
  });

  await assertSupportedRunnerEnvironment(env);
  const codexBinaryPath = await resolveCodexBinary(env);
  const authJson = readActionAuthJson(env);
  mask(io, authJson);
  clearActionAuthEnv(env);
  validateCodexAuthJsonBytes({ authJsonBytes: authJson });
  const restoredGenerationHash = computeCodexAuthGenerationHash({
    authJsonBytes: authJson,
    generationHashSalt: prelease.generationHashSalt,
  });

  const finalize = await postJson<FinalizeResponse>({
    fetchImpl,
    url: `${inputs.apiUrl}/api/action/v1/codex-oauth/finalize`,
    body: {
      leaseId: prelease.leaseId,
      providerInstanceId: inputs.providerInstanceId,
      restoredGenerationHash,
    },
  });

  if (finalize.status === "stale_queued_secret") {
    clearActionAuthEnv(env);
    notice(io, "ReviewRouter skipped a stale queued Codex OAuth secret.");
    return;
  }

  mask(io, finalize.publicKeyReadToken);
  const publicKey = await fetchGitHubRepositoryPublicKey({
    fetchImpl,
    owner: finalize.repositoryOwner,
    repo: finalize.repositoryName,
    token: finalize.publicKeyReadToken,
  });

  await postJson({
    fetchImpl,
    url: `${inputs.apiUrl}/api/action/v1/codex-oauth/writeback-preflight`,
    body: {
      leaseId: prelease.leaseId,
      providerInstanceId: inputs.providerInstanceId,
      githubKeyId: publicKey.key_id,
    },
  });

  try {
    const workspace = await makeTempDirectory("reviewrouter-workspace-");
    try {
      const tempHome = await makeTempDirectory("reviewrouter-home-");
      const tempCodexHome = await makeTempDirectory("reviewrouter-codex-");
      try {
        await writeCodexAuthSnapshot(tempCodexHome, authJson);
        await runCodexBootstrap({
          inputs,
          codexBinaryPath,
          env,
          tempHome,
          tempCodexHome,
        });

        const refreshedAuthJson = await readFile(
          join(tempCodexHome, "auth.json"),
          "utf8",
        );
        const compact = compactCodexAuthJson({
          authJsonBytes: refreshedAuthJson,
        });
        const encrypted = await encryptCodexRotatingAuthForGitHubSecret({
          authJsonBytes: compact.compactAuthJsonBytes,
          githubPublicKeyBase64: publicKey.key,
          githubKeyId: publicKey.key_id,
          generationHashSalt: prelease.generationHashSalt,
        });

        const writeback = await postJson<WritebackResponse>({
          fetchImpl,
          url: `${inputs.apiUrl}/api/action/v1/codex-oauth/writeback`,
          body: {
            protocolVersion: 1,
            leaseId: prelease.leaseId,
            providerInstanceId: inputs.providerInstanceId,
            generation: finalize.nextGeneration,
            latestGenerationHash: encrypted.latestGenerationHash,
            encryptedValue: encrypted.encryptedValue,
            keyId: encrypted.keyId,
            idempotencyKey: buildWritebackIdempotencyKey(env, prelease.leaseId),
          },
        });
        assertWritebackAccepted(writeback);

        const checkout = await postJson<CheckoutTokenResponse>({
          fetchImpl,
          url: `${inputs.apiUrl}/api/action/v1/codex-oauth/checkout-token`,
          body: {
            leaseId: prelease.leaseId,
            providerInstanceId: inputs.providerInstanceId,
          },
        });
        mask(io, checkout.token);

        await safeCheckoutPullRequest({
          env,
          workspace,
          event,
          checkoutToken: checkout.token,
        });

        const commentToken = await postJson<CommentTokenResponse>({
          fetchImpl,
          url: `${inputs.apiUrl}/api/action/v1/codex-oauth/comment-token`,
          body: {
            leaseId: prelease.leaseId,
            providerInstanceId: inputs.providerInstanceId,
            authCleared: true,
          },
        });
        mask(io, commentToken.token);
        await deleteStaleCodexRotatingSummaryComments({
          fetchImpl,
          token: commentToken.token,
          owner: event.owner,
          repo: event.repo,
          issueNumber: event.number,
        });

        const reviewHome = await makeTempDirectory("reviewrouter-review-home-");
        try {
          await fullReviewRuntimeRunner({
            inputs,
            codexBinaryPath,
            env,
            workspace,
            tempHome: reviewHome,
            tempCodexHome,
            event,
            commentToken: commentToken.token,
            runtimeConfigVersion: finalize.runtimeConfigVersion,
            runtimeEnv: finalize.runtimeEnv,
          });
        } finally {
          await removeTree(reviewHome);
        }
      } finally {
        clearActionAuthEnv(env);
        await removeTree(tempCodexHome);
        await removeTree(tempHome);
      }
      notice(io, "ReviewRouter Codex OAuth review completed.");
    } finally {
      await removeTree(workspace);
    }
  } finally {
    clearActionAuthEnv(env);
    clearOidcRequestEnv(env);
  }
}

export function readActionInputs(env: NodeJS.ProcessEnv): ActionInputs {
  const mode = readInput(env, "mode") || codexRotatingRuntimeAuthMode;
  const apiUrl = requireInput(env, "api-url").replace(/\/+$/, "");
  const workflowSchemaVersion = Number(
    readInput(env, "workflow-schema-version") || "1",
  );
  if (!Number.isInteger(workflowSchemaVersion) || workflowSchemaVersion <= 0) {
    throw new Error("invalid_workflow_schema_version");
  }

  return {
    mode,
    apiUrl,
    providerInstanceId: requireInput(env, "provider-instance-id"),
    workflowSchemaVersion,
  };
}

export function readActionAuthJson(env: NodeJS.ProcessEnv): string {
  const value = readRawInput(env, "auth-json");
  if (value === undefined || value.length === 0) {
    throw new Error("needs_reconnect");
  }
  clearActionAuthEnv(env);
  return value;
}

export async function assertSupportedRunnerEnvironment(
  env: NodeJS.ProcessEnv,
  options: RunnerEnvironmentCheckOptions = {},
): Promise<void> {
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const nodeMajor = Number(nodeVersion.split(".")[0]);
  if (!Number.isInteger(nodeMajor) || nodeMajor < minimumNodeMajor) {
    throw new Error("unsupported_node_runtime");
  }
  if (env.RUNNER_OS !== supportedRunnerOs) {
    throw new Error("unsupported_runner_os");
  }
  if (env.RUNNER_ARCH !== supportedRunnerArch) {
    throw new Error("unsupported_runner_arch");
  }
  if ((env.ImageOS ?? env.IMAGE_OS) !== supportedRunnerImageOs) {
    throw new Error("unsupported_runner_image_os");
  }
  const imageVersion = env.ImageVersion ?? env.IMAGE_VERSION;
  if (!imageVersion || !/^[A-Za-z0-9._-]{1,80}$/.test(imageVersion)) {
    throw new Error("unsupported_runner_image_version");
  }

  const actionPath = resolveGitHubActionPath(env);
  const freeDiskBytes = await getAvailableDiskBytes(actionPath);
  if (
    freeDiskBytes < (options.minimumFreeDiskBytes ?? minimumRunnerFreeDiskBytes)
  ) {
    throw new Error("runner_disk_budget_too_low");
  }
}

export function sanitizeReviewComment(
  body: string,
  options: { readonly marker?: string } = {},
): string {
  const sanitized =
    body
      .replace(
        /<!--\s*reviewrouter:codex-oauth-rotating(?:\s+head=[a-f0-9]{40})?\s*-->\s*/gi,
        "",
      )
      .replace(
        /refresh_token["'\s:=]+[A-Za-z0-9._~+/=-]+/gi,
        "refresh_token: [redacted]",
      )
      .replace(
        /access_token["'\s:=]+[A-Za-z0-9._~+/=-]+/gi,
        "access_token: [redacted]",
      )
      .replace(/id_token["'\s:=]+[A-Za-z0-9._~+/=-]+/gi, "id_token: [redacted]")
      .trim() ||
    "ReviewRouter completed the Codex review without a response body.";
  const header = `${options.marker ?? "<!-- reviewrouter:codex-oauth-rotating -->"}\n`;
  return limitUtf8(`${header}${sanitized}`, maxCommentBytes);
}

export function buildCodexCommand(input: {
  readonly codexBinaryPath: string;
  readonly mode: "bootstrap" | "review";
  readonly cwd: string;
  readonly outputFile?: string;
}): { readonly command: string; readonly args: readonly string[] } {
  const args = [
    "exec",
    "--sandbox",
    "read-only",
    "--ignore-rules",
    "--ephemeral",
    "-C",
    input.cwd,
  ];
  if (input.mode === "bootstrap") {
    args.push("--skip-git-repo-check");
  }
  if (input.outputFile) {
    args.push("--output-last-message", input.outputFile);
  }
  args.push("-");
  return { command: input.codexBinaryPath, args };
}

function readInput(env: NodeJS.ProcessEnv, name: string): string {
  return (readRawInput(env, name) ?? "").trim();
}

function readRawInput(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const canonical = `INPUT_${name.toUpperCase()}`;
  const underscore = `INPUT_${name.toUpperCase().replaceAll("-", "_")}`;
  return env[canonical] ?? env[underscore];
}

function requireInput(env: NodeJS.ProcessEnv, name: string): string {
  const value = readInput(env, name);
  if (!value) {
    throw new Error(`missing_action_input:${name}`);
  }
  return value;
}

async function readPullRequestEvent(
  env: NodeJS.ProcessEnv,
): Promise<PullRequestEvent> {
  if (env.GITHUB_EVENT_NAME !== "pull_request") {
    throw new Error("unsupported_event");
  }
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error("missing_github_event_path");
  }
  const event = JSON.parse(await readFile(eventPath, "utf8")) as {
    readonly number?: unknown;
    readonly repository?: { readonly full_name?: unknown };
    readonly pull_request?: {
      readonly draft?: unknown;
      readonly head?: {
        readonly sha?: unknown;
        readonly repo?: { readonly full_name?: unknown };
      };
      readonly base?: { readonly sha?: unknown };
    };
  };
  const repository = requireString(event.repository?.full_name, "event_repo");
  const headRepo = requireString(
    event.pull_request?.head?.repo?.full_name,
    "head_repo",
  );
  if (event.pull_request?.draft === true) {
    throw new Error("draft_pull_request_unsupported");
  }
  if (repository !== headRepo) {
    throw new Error("fork_pull_request_unsupported");
  }
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    throw new Error("invalid_github_repository");
  }
  return {
    number: requireNumber(event.number, "pr_number"),
    repository,
    owner,
    repo,
    headSha: requireSha(event.pull_request?.head?.sha, "head_sha"),
    baseSha: requireSha(event.pull_request?.base?.sha, "base_sha"),
  };
}

function assertSameRepositoryPullRequest(
  event: PullRequestEvent,
  env: NodeJS.ProcessEnv,
): void {
  if (env.GITHUB_REPOSITORY && env.GITHUB_REPOSITORY !== event.repository) {
    throw new Error("github_repository_mismatch");
  }
}

async function requestGitHubActionsOidcToken(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly fetchImpl: FetchLike;
  readonly audience: string;
}): Promise<string> {
  const requestUrl = input.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = input.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    throw new Error("github_oidc_unavailable");
  }
  const separator = requestUrl.includes("?") ? "&" : "?";
  const response = await input.fetchImpl(
    `${requestUrl}${separator}audience=${encodeURIComponent(input.audience)}`,
    { headers: { authorization: `bearer ${requestToken}` } },
  );
  const body = (await response.json()) as { readonly value?: unknown };
  if (
    !response.ok ||
    typeof body.value !== "string" ||
    body.value.length === 0
  ) {
    throw new Error("github_oidc_request_failed");
  }
  return body.value;
}

async function postJson<T = unknown>(input: {
  readonly fetchImpl: FetchLike;
  readonly url: string;
  readonly body: unknown;
}): Promise<T> {
  const response = await input.fetchImpl(input.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input.body),
  });
  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as unknown) : {};
  if (!response.ok) {
    throw new Error(safeRemoteError(parsed, response.status));
  }
  return parsed as T;
}

async function fetchGitHubRepositoryPublicKey(input: {
  readonly fetchImpl: FetchLike;
  readonly owner: string;
  readonly repo: string;
  readonly token: string;
}): Promise<GitHubPublicKeyResponse> {
  const response = await input.fetchImpl(
    `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/actions/secrets/public-key`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${input.token}`,
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  const body = (await response.json()) as Partial<GitHubPublicKeyResponse>;
  if (
    !response.ok ||
    typeof body.key !== "string" ||
    typeof body.key_id !== "string"
  ) {
    throw new Error("github_public_key_fetch_failed");
  }
  return { key: body.key, key_id: body.key_id };
}

function assertWritebackAccepted(response: WritebackResponse): void {
  if (!response || response.protocolVersion !== 1) {
    throw new Error("unknown_auth_state");
  }
  if (
    response.status === "accepted" ||
    response.status === "idempotent_replay"
  ) {
    return;
  }
  if (response.status === "writeback_idempotency_conflict") {
    throw new Error("security_invariant_failed");
  }
  throw new Error("unknown_auth_state");
}

export function routeCodexLocalProviderRequest(input: {
  readonly method: string;
  readonly path: string;
  readonly nonce: string;
  readonly bodyBytes: number;
}): "responses" | "deny" {
  if (input.method !== "POST") return "deny";
  if (input.bodyBytes > maxProxyRequestBodyBytes) return "deny";
  if (input.path !== `/${input.nonce}/v1/responses`) return "deny";
  return "responses";
}

export async function startCodexLocalProviderProxy(input: {
  readonly fetchImpl: FetchLike;
  readonly accessToken: string;
  readonly upstreamResponsesUrl: string;
}): Promise<LocalProviderProxy> {
  const nonce = randomBytes(24).toString("base64url");
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const body = await readProxyRequestBody(req);
        const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
        const route = routeCodexLocalProviderRequest({
          method: req.method ?? "GET",
          path,
          nonce,
          bodyBytes: body.byteLength,
        });
        if (route !== "responses") {
          writeProxyDeny(res);
          return;
        }
        requestCount += 1;
        if (requestCount > maxProxyRequestsPerReview) {
          writeProxyError(res, 429, "proxy_request_budget_exceeded");
          return;
        }
        const acceptHeader = Array.isArray(req.headers.accept)
          ? req.headers.accept.join(", ")
          : (req.headers.accept ?? "text/event-stream");
        const contentTypeHeader = Array.isArray(req.headers["content-type"])
          ? req.headers["content-type"].join(", ")
          : (req.headers["content-type"] ?? "application/json");
        const upstream = await input.fetchImpl(input.upstreamResponsesUrl, {
          method: "POST",
          headers: {
            accept: acceptHeader,
            authorization: `Bearer ${input.accessToken}`,
            "content-type": contentTypeHeader,
          },
          body: new Uint8Array(body),
        });
        await writeProxyUpstreamResponse(res, upstream);
      } catch {
        writeProxyError(res, 502, "proxy_upstream_failed");
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeHttpServer(server);
    throw new Error("proxy_listener_invalid_address");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/${nonce}/v1`,
    close: () => closeHttpServer(server),
  };
}

function readProxyRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on("data", (chunk) => {
      const buffer = Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maxProxyRequestBodyBytes) {
        req.destroy(new Error("proxy_request_body_too_large"));
        return;
      }
      chunks.push(buffer);
    });
    req.on("error", reject);
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function writeProxyUpstreamResponse(
  res: http.ServerResponse,
  upstream: Response,
): Promise<void> {
  const headers: Record<string, string> = {};
  const contentType = upstream.headers.get("content-type");
  if (contentType) {
    headers["content-type"] = contentType;
  }
  res.writeHead(upstream.status, headers);
  if (!upstream.body) {
    res.end();
    return;
  }
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } finally {
    reader.releaseLock();
  }
}

function writeProxyDeny(res: http.ServerResponse): void {
  writeProxyError(res, 404, "proxy_route_denied");
}

function writeProxyError(
  res: http.ServerResponse,
  status: number,
  code: string,
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: code }));
}

function closeHttpServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function resolveCodexBinary(
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const actionPath = resolveGitHubActionPath(env);

  const bundleRoot = join(
    actionPath,
    "action-dist",
    "codex",
    bundledCodexPlatform,
  );
  const archivePath = join(bundleRoot, bundledCodexArchiveName);
  const manifestPath = join(bundleRoot, "manifest.json");

  let resolvedBundleRoot: string;
  let resolvedArchivePath: string;
  let resolvedManifestPath: string;
  try {
    [resolvedBundleRoot, resolvedArchivePath, resolvedManifestPath] =
      await Promise.all([
        realpath(bundleRoot),
        realpath(archivePath),
        realpath(manifestPath),
      ]);
  } catch (error) {
    throw new Error("codex_bundled_binary_missing", { cause: error });
  }

  if (
    !resolvedArchivePath.startsWith(`${resolvedBundleRoot}/`) ||
    !resolvedManifestPath.startsWith(`${resolvedBundleRoot}/`)
  ) {
    throw new Error("codex_bundled_binary_escape");
  }

  const [archiveLinkStats, manifestLinkStats, archiveStats, manifest] =
    await Promise.all([
      lstat(archivePath),
      lstat(manifestPath),
      stat(resolvedArchivePath),
      readCodexBinaryManifest(resolvedManifestPath),
    ]);
  if (archiveLinkStats.isSymbolicLink() || manifestLinkStats.isSymbolicLink()) {
    throw new Error("codex_bundled_binary_symlink");
  }
  if (!archiveStats.isFile()) {
    throw new Error("codex_bundled_binary_not_file");
  }
  validateCodexBinaryManifest(manifest, archiveStats.size);
  const archiveSha256 = await sha256File(resolvedArchivePath);
  if (archiveSha256 !== manifest.archiveSha256) {
    throw new Error("codex_bundled_archive_hash_mismatch");
  }

  const extractionRoot = await mkdtemp(
    join(env.RUNNER_TEMP ?? tmpdir(), "reviewrouter-codex-bundle-"),
  );
  await runProcess({
    command: "tar",
    args: ["-xzf", resolvedArchivePath, "-C", extractionRoot],
    cwd: extractionRoot,
    env: {
      PATH: env.PATH ?? process.env.PATH ?? "",
    },
    timeoutMs: 60_000,
  });
  const extractedBinaryPath = join(
    extractionRoot,
    manifest.binaryPathInArchive,
  );
  const resolvedExtractionRoot = await realpath(extractionRoot);
  const resolvedBinaryPath = await realpath(extractedBinaryPath);
  if (!resolvedBinaryPath.startsWith(`${resolvedExtractionRoot}/`)) {
    throw new Error("codex_bundled_binary_escape");
  }
  const binaryStats = await stat(resolvedBinaryPath);
  if (!binaryStats.isFile() || binaryStats.size !== manifest.size) {
    throw new Error("codex_bundled_binary_manifest_mismatch");
  }
  const binarySha256 = await sha256File(resolvedBinaryPath);
  if (binarySha256 !== manifest.sha256) {
    throw new Error("codex_bundled_binary_hash_mismatch");
  }
  await chmod(resolvedBinaryPath, 0o755);
  await access(resolvedBinaryPath, fsConstants.X_OK);
  return resolvedBinaryPath;
}

function resolveGitHubActionPath(env: NodeJS.ProcessEnv): string {
  const explicitActionPath = env.GITHUB_ACTION_PATH;
  if (explicitActionPath) {
    return explicitActionPath;
  }

  if (typeof __dirname === "string" && __dirname.endsWith("action-dist")) {
    return join(__dirname, "..");
  }

  throw new Error("missing_github_action_path");
}

async function readCodexBinaryManifest(
  manifestPath: string,
): Promise<CodexBinaryManifest> {
  try {
    return JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as CodexBinaryManifest;
  } catch (error) {
    throw new Error("codex_bundled_binary_manifest_invalid", { cause: error });
  }
}

function validateCodexBinaryManifest(
  manifest: unknown,
  archiveSize: number,
): void {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("codex_bundled_binary_manifest_mismatch");
  }
  const candidate = manifest as Partial<CodexBinaryManifest>;
  if (
    candidate.protocolVersion !== 1 ||
    candidate.packageName !== bundledCodexPackageName ||
    candidate.version !== bundledCodexVersion ||
    candidate.platform !== bundledCodexPlatform ||
    candidate.archive !== bundledCodexArchiveName ||
    candidate.archiveSize !== archiveSize ||
    typeof candidate.archiveSha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(candidate.archiveSha256) ||
    candidate.binaryPathInArchive !== bundledCodexBinaryPathInArchive ||
    candidate.binary !== "codex" ||
    typeof candidate.size !== "number" ||
    candidate.size <= 0 ||
    typeof candidate.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(candidate.sha256)
  ) {
    throw new Error("codex_bundled_binary_manifest_mismatch");
  }
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function getAvailableDiskBytes(path: string): Promise<number> {
  try {
    const stats = await statfs(path);
    return stats.bavail * stats.bsize;
  } catch (error) {
    throw new Error("runner_disk_budget_unavailable", { cause: error });
  }
}

async function writeCodexAuthSnapshot(
  codexHome: string,
  authJson: string,
): Promise<void> {
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  const config = [
    'cli_auth_credentials_store = "file"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    'web_search = "disabled"',
    "disable_response_storage = true",
    "",
    "[history]",
    'persistence = "none"',
    "",
    "[otel]",
    'exporter = "none"',
    'metrics_exporter = "none"',
    'trace_exporter = "none"',
    "log_user_prompt = false",
    "",
    "[shell_environment_policy]",
    'inherit = "none"',
    'include_only = ["PATH", "HOME", "CI", "CODEX_HOME"]',
    "",
  ].join("\n");
  await writeFile(join(codexHome, "config.toml"), config, {
    mode: 0o600,
  });
  await writeFile(join(codexHome, "auth.json"), authJson, { mode: 0o600 });
}

async function runCodexBootstrap(input: {
  readonly inputs: ActionInputs;
  readonly codexBinaryPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly tempHome: string;
  readonly tempCodexHome: string;
}): Promise<void> {
  const emptyCwd = await makeTempDirectory("reviewrouter-empty-");
  try {
    const command = buildCodexCommand({
      codexBinaryPath: input.codexBinaryPath,
      mode: "bootstrap",
      cwd: emptyCwd,
    });
    try {
      await runProcess({
        ...command,
        stdin: "Respond with OK only.",
        env: buildCodexChildEnv(input.env, input.tempHome, input.tempCodexHome),
        timeoutMs: 5 * 60 * 1000,
      });
    } catch (error) {
      throw classifyCodexBootstrapFailure(error);
    }
  } finally {
    await removeTree(emptyCwd);
  }
}

async function safeCheckoutPullRequest(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly workspace: string;
  readonly event: PullRequestEvent;
  readonly checkoutToken: string;
}): Promise<void> {
  const askPass = join(input.workspace, ".reviewrouter-askpass.sh");
  await writeFile(
    askPass,
    [
      "#!/usr/bin/env bash",
      'case "$1" in',
      '*Username*) printf "%s\\n" "x-access-token" ;;',
      '*Password*) printf "%s\\n" "$REVIEWROUTER_CHECKOUT_TOKEN" ;;',
      '*) printf "\\n" ;;',
      "esac",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await chmod(askPass, 0o700);
  const gitEnv = buildSafeCheckoutGitEnv({
    sourceEnv: input.env,
    workspace: input.workspace,
    askPass,
    checkoutToken: input.checkoutToken,
  });
  await runGit(["init", "."], input.workspace, gitEnv);
  await runGit(["config", "--local", "gc.auto", "0"], input.workspace, gitEnv);
  await runGit(
    ["config", "--local", "core.hooksPath", "/dev/null"],
    input.workspace,
    gitEnv,
  );
  await runGit(
    [
      "remote",
      "add",
      "origin",
      `https://github.com/${input.event.repository}.git`,
    ],
    input.workspace,
    gitEnv,
  );
  await runGit(
    [
      "-c",
      "protocol.file.allow=never",
      "-c",
      "protocol.ext.allow=never",
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "--depth=1",
      "origin",
      input.event.baseSha,
      input.event.headSha,
    ],
    input.workspace,
    gitEnv,
  );
  await runGit(
    [
      "-c",
      "protocol.file.allow=never",
      "-c",
      "protocol.ext.allow=never",
      "checkout",
      "--detach",
      input.event.headSha,
    ],
    input.workspace,
    gitEnv,
  );
  await assertCheckoutConfigDoesNotPersistCredentials({
    workspace: input.workspace,
    checkoutToken: input.checkoutToken,
  });
}

function buildSafeCheckoutGitEnv(input: {
  readonly sourceEnv: NodeJS.ProcessEnv;
  readonly workspace: string;
  readonly askPass: string;
  readonly checkoutToken: string;
}): Record<string, string> {
  return {
    ...pruneCodexRotatingChildEnv(input.sourceEnv),
    HOME: input.workspace,
    XDG_CONFIG_HOME: join(input.workspace, ".config"),
    GIT_ASKPASS: input.askPass,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_LFS_SKIP_SMUDGE: "1",
    GCM_INTERACTIVE: "Never",
    GIT_CONFIG_COUNT: "7",
    GIT_CONFIG_KEY_0: "protocol.file.allow",
    GIT_CONFIG_VALUE_0: "never",
    GIT_CONFIG_KEY_1: "protocol.ext.allow",
    GIT_CONFIG_VALUE_1: "never",
    GIT_CONFIG_KEY_2: "protocol.ssh.allow",
    GIT_CONFIG_VALUE_2: "never",
    GIT_CONFIG_KEY_3: "protocol.git.allow",
    GIT_CONFIG_VALUE_3: "never",
    GIT_CONFIG_KEY_4: "credential.helper",
    GIT_CONFIG_VALUE_4: "",
    GIT_CONFIG_KEY_5: "core.hooksPath",
    GIT_CONFIG_VALUE_5: "/dev/null",
    GIT_CONFIG_KEY_6: "advice.detachedHead",
    GIT_CONFIG_VALUE_6: "false",
    REVIEWROUTER_CHECKOUT_TOKEN: input.checkoutToken,
  };
}

async function assertCheckoutConfigDoesNotPersistCredentials(input: {
  readonly workspace: string;
  readonly checkoutToken: string;
}): Promise<void> {
  let gitConfig: string;
  try {
    gitConfig = await readFile(join(input.workspace, ".git", "config"), "utf8");
  } catch (error) {
    throw new Error("checkout_config_missing", { cause: error });
  }
  const normalized = gitConfig.toLowerCase();
  if (
    gitConfig.includes(input.checkoutToken) ||
    normalized.includes("extraheader") ||
    normalized.includes("credential.helper") ||
    normalized.includes("insteadof") ||
    normalized.includes("reviewrouter_checkout_token") ||
    normalized.includes("x-access-token")
  ) {
    throw new Error("checkout_persisted_credentials_detected");
  }
}

async function runFullReviewRouterRuntime(input: {
  readonly inputs: ActionInputs;
  readonly codexBinaryPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly workspace: string;
  readonly tempHome: string;
  readonly tempCodexHome: string;
  readonly event: PullRequestEvent;
  readonly commentToken: string;
  readonly runtimeConfigVersion: number;
  readonly runtimeEnv: Record<string, string>;
}): Promise<void> {
  const actionPath = resolveGitHubActionPath(input.env);
  const runtimePath = join(actionPath, "dist", "index.js");
  await access(runtimePath, fsConstants.R_OK);

  const codexBinDir = await makeTempDirectory("reviewrouter-codex-bin-");
  try {
    await symlink(input.codexBinaryPath, join(codexBinDir, "codex"));
    await runProcess({
      command: process.execPath,
      args: [runtimePath],
      cwd: input.workspace,
      env: buildFullReviewRuntimeEnv({
        sourceEnv: input.env,
        inputs: input.inputs,
        event: input.event,
        tempHome: input.tempHome,
        tempCodexHome: input.tempCodexHome,
        codexBinDir,
        commentToken: input.commentToken,
        runtimeConfigVersion: input.runtimeConfigVersion,
        runtimeEnv: input.runtimeEnv,
      }),
      timeoutMs: 30 * 60 * 1000,
    });
  } catch (error) {
    throw classifyPostWritebackCodexFailure(error);
  } finally {
    await removeTree(codexBinDir);
  }
}

function buildFullReviewRuntimeEnv(input: {
  readonly sourceEnv: NodeJS.ProcessEnv;
  readonly inputs: ActionInputs;
  readonly event: PullRequestEvent;
  readonly tempHome: string;
  readonly tempCodexHome: string;
  readonly codexBinDir: string;
  readonly commentToken: string;
  readonly runtimeConfigVersion: number;
  readonly runtimeEnv: Record<string, string>;
}): Record<string, string> {
  const inherited = pruneCodexRotatingChildEnv(input.sourceEnv);
  const runtimeEnv = normalizeFullReviewRuntimeEnv(input.runtimeEnv);
  const reviewAuthMode =
    runtimeEnv.REVIEW_AUTH_MODE === codexRotatingRuntimeAuthMode
      ? "codex-oauth"
      : (runtimeEnv.REVIEW_AUTH_MODE ?? "codex-oauth");
  return {
    ...inherited,
    ...runtimeEnv,
    HOME: input.tempHome,
    CODEX_HOME: input.tempCodexHome,
    CI: "true",
    PATH: `${input.codexBinDir}:${input.sourceEnv.PATH ?? process.env.PATH ?? ""}`,
    GITHUB_TOKEN: input.commentToken,
    PR_NUMBER: String(input.event.number),
    REVIEW_AUTH_MODE: reviewAuthMode,
    REVIEWROUTER_RUNTIME_CONFIG_MODE: "static",
    REVIEWROUTER_STATIC_CONFIG_FALLBACK: "false",
    REVIEWROUTER_COMMENT_TOKEN_MODE: "github-token",
    REVIEWROUTER_API_URL: input.inputs.apiUrl,
    REVIEWROUTER_CONFIG_VERSION: String(input.runtimeConfigVersion),
  };
}

function normalizeFullReviewRuntimeEnv(
  runtimeEnv: Readonly<Record<string, string>>,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(runtimeEnv)) {
    if (!isSafeFullReviewRuntimeEnvKey(key)) {
      throw new Error(`unsafe_runtime_env_key:${safeEnvKeyLabel(key)}`);
    }
    if (typeof value !== "string") {
      throw new Error(`unsafe_runtime_env_value:${safeEnvKeyLabel(key)}`);
    }
    normalized[key] = value;
  }
  return normalized;
}

function isSafeFullReviewRuntimeEnvKey(key: string): boolean {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
    return false;
  }
  if (key === "TARGET_TOKENS_PER_BATCH") {
    return true;
  }
  return !/(TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|AUTH_JSON)/.test(key);
}

function safeEnvKeyLabel(key: string): string {
  return /^[A-Z_][A-Z0-9_]{0,80}$/.test(key) ? key : "<invalid-env-key>";
}

async function runStaticCodexReview(input: {
  readonly inputs: ActionInputs;
  readonly codexBinaryPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly workspace: string;
  readonly tempHome: string;
  readonly tempCodexHome: string;
  readonly event: PullRequestEvent;
}): Promise<string> {
  const diff = await runCapture({
    command: "git",
    args: [
      "diff",
      "--no-ext-diff",
      "--unified=80",
      input.event.baseSha,
      input.event.headSha,
    ],
    cwd: input.workspace,
    env: buildCodexChildEnv(input.env, input.tempHome, input.tempCodexHome),
    timeoutMs: 60_000,
  });
  const reviewOutputFile = join(input.workspace, ".reviewrouter-review.md");
  const command = buildCodexCommand({
    codexBinaryPath: input.codexBinaryPath,
    mode: "review",
    cwd: input.workspace,
    outputFile: reviewOutputFile,
  });
  try {
    await runProcess({
      ...command,
      stdin: buildReviewPrompt(limitUtf8(diff.stdout, maxDiffBytes)),
      env: buildReviewCodexChildEnv(
        input.env,
        input.tempHome,
        input.tempCodexHome,
      ),
      timeoutMs: 20 * 60 * 1000,
    });
  } catch (error) {
    const partialReview = await readReviewOutputIfPresent(reviewOutputFile);
    if (partialReview.trim().length > 0) {
      return partialReview;
    }
    throw classifyPostWritebackCodexFailure(error);
  }
  return readFile(reviewOutputFile, "utf8");
}

async function readReviewOutputIfPresent(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

export async function postPullRequestComment(input: {
  readonly fetchImpl: FetchLike;
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly marker: string;
  readonly body: string;
}): Promise<void> {
  const commentsUrl = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues/${input.issueNumber}/comments`;
  const commentsResponse = await input.fetchImpl(
    `${commentsUrl}?per_page=100`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${input.token}`,
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  if (!commentsResponse.ok) {
    throw new Error("github_comment_lookup_failed");
  }
  const comments = (await commentsResponse.json()) as unknown;
  if (!Array.isArray(comments)) {
    throw new Error("github_comment_lookup_invalid");
  }
  const existing = comments.find(
    (comment): comment is GitHubIssueCommentResponse =>
      typeof comment === "object" &&
      comment !== null &&
      typeof (comment as GitHubIssueCommentResponse).id === "number" &&
      typeof (comment as GitHubIssueCommentResponse).body === "string" &&
      (comment as GitHubIssueCommentResponse).body!.startsWith(input.marker),
  );
  if (existing) {
    const updateResponse = await input.fetchImpl(
      `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues/comments/${existing.id}`,
      {
        method: "PATCH",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${input.token}`,
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify({ body: input.body }),
      },
    );
    if (!updateResponse.ok) {
      throw new Error("github_comment_update_failed");
    }
    return;
  }

  const createResponse = await input.fetchImpl(commentsUrl, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ body: input.body }),
  });
  if (!createResponse.ok) {
    throw new Error("github_comment_post_failed");
  }
}

export async function deleteStaleCodexRotatingSummaryComments(input: {
  readonly fetchImpl: FetchLike;
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
}): Promise<void> {
  const commentsUrl = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues/${input.issueNumber}/comments`;
  const commentsResponse = await input.fetchImpl(
    `${commentsUrl}?per_page=100`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${input.token}`,
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  if (!commentsResponse.ok) {
    throw new Error("github_stale_comment_lookup_failed");
  }
  const comments = (await commentsResponse.json()) as unknown;
  if (!Array.isArray(comments)) {
    throw new Error("github_stale_comment_lookup_invalid");
  }
  const staleComments = comments.filter(
    (comment): comment is GitHubIssueCommentResponse =>
      typeof comment === "object" &&
      comment !== null &&
      typeof (comment as GitHubIssueCommentResponse).id === "number" &&
      typeof (comment as GitHubIssueCommentResponse).body === "string" &&
      (comment as GitHubIssueCommentResponse).body!.startsWith(
        "<!-- reviewrouter:codex-oauth-rotating",
      ),
  );
  for (const comment of staleComments) {
    const deleteResponse = await input.fetchImpl(
      `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues/comments/${comment.id}`,
      {
        method: "DELETE",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${input.token}`,
          "x-github-api-version": "2022-11-28",
        },
      },
    );
    if (!deleteResponse.ok) {
      throw new Error("github_stale_comment_delete_failed");
    }
  }
}

function buildReviewCommentMarker(headSha: string): string {
  if (!/^[a-f0-9]{40}$/i.test(headSha)) {
    throw new Error("invalid_review_comment_head_sha");
  }
  return `<!-- reviewrouter:codex-oauth-rotating head=${headSha.toLowerCase()} -->`;
}

function buildReviewPrompt(diff: string): string {
  return [
    "You are ReviewRouter running an advisory private-beta Codex OAuth review.",
    "Review only the diff below. Do not run tests, install packages, modify files, browse the web, or use network tools.",
    "Return a concise Markdown PR comment with concrete bugs and risks. If there are no issues, say that no blocking issues were found.",
    "Do not include secrets, tokens, raw auth JSON, or hidden environment values.",
    "",
    "```diff",
    diff,
    "```",
  ].join("\n");
}

function buildCodexChildEnv(
  sourceEnv: NodeJS.ProcessEnv,
  home: string,
  codexHome: string,
): Record<string, string> {
  return {
    ...pruneCodexRotatingChildEnv(sourceEnv),
    HOME: home,
    CODEX_HOME: codexHome,
    CI: "true",
  };
}

function buildReviewCodexChildEnv(
  sourceEnv: NodeJS.ProcessEnv,
  home: string,
  codexHome: string,
): Record<string, string> {
  return {
    PATH: sourceEnv.PATH ?? process.env.PATH ?? "",
    HOME: home,
    CODEX_HOME: codexHome,
    CI: "true",
  };
}

function runGit(
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
): Promise<void> {
  return runProcess({
    command: "git",
    args,
    cwd,
    env,
    timeoutMs: 5 * 60 * 1000,
  });
}

class ProcessExecutionError extends Error {
  constructor(
    message: string,
    readonly output: string,
  ) {
    super(message);
  }
}

function runProcess(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env: Record<string, string>;
  readonly stdin?: string;
  readonly timeoutMs: number;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const outputChunks: Buffer[] = [];
    let outputBytes = 0;
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("process_timeout"));
    }, input.timeoutMs);
    child.stdout.on("data", (chunk) => {
      outputBytes = appendCapturedChunk(
        outputChunks,
        outputBytes,
        Buffer.from(chunk),
      );
    });
    child.stderr.on("data", (chunk) => {
      outputBytes = appendCapturedChunk(
        outputChunks,
        outputBytes,
        Buffer.from(chunk),
      );
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(
          new ProcessExecutionError(
            `process_failed:${input.command}:${code ?? "signal"}`,
            Buffer.concat(outputChunks).toString("utf8"),
          ),
        );
      }
    });
    child.stdin.end(input.stdin ?? "");
  });
}

function appendCapturedChunk(
  chunks: Buffer[],
  currentBytes: number,
  chunk: Buffer,
): number {
  const remaining = maxCapturedProcessOutputBytes - currentBytes;
  if (remaining <= 0) {
    return currentBytes;
  }
  const nextChunk =
    chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
  chunks.push(nextChunk);
  return currentBytes + nextChunk.byteLength;
}

function classifyCodexBootstrapFailure(error: unknown): Error {
  const output = getProcessFailureOutput(error);
  const state = classifyCodexRuntimeFailure(output);
  if (
    state === "needs_reconnect" ||
    state === "quota_limited" ||
    state === "permission_required"
  ) {
    return new Error(state);
  }
  return new Error(
    `unknown_auth_state:${sanitizeProcessFailureOutput(output)}`,
  );
}

function classifyPostWritebackCodexFailure(error: unknown): Error {
  const output = getProcessFailureOutput(error);
  const state = classifyCodexRuntimeFailure(output);
  if (state === "quota_limited") {
    return new Error("quota_limited");
  }
  return new Error(
    `unknown_auth_state:${sanitizeProcessFailureOutput(output)}`,
  );
}

function getProcessFailureOutput(error: unknown): string {
  if (error instanceof ProcessExecutionError) {
    return error.output;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { readonly output?: unknown }).output === "string"
  ) {
    return (error as { readonly output: string }).output;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function sanitizeProcessFailureOutput(output: string): string {
  const sanitized = output
    .replace(
      /\b(refresh_token|access_token|id_token)\b["'\s:=]+[A-Za-z0-9._~+/=-]+/gi,
      "$1: [redacted]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/[A-Za-z0-9._~+/=-]{80,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized ? limitUtf8Tail(sanitized, 1_000) : "empty_process_output";
}

async function removeTree(path: string): Promise<void> {
  await rm(path, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 250,
  });
}

function runCapture(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly timeoutMs: number;
}): Promise<{ readonly stdout: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("process_timeout"));
    }, input.timeoutMs);
    child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.stderr.on("data", () => undefined);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout: Buffer.concat(chunks).toString("utf8") });
      } else {
        reject(
          new Error(`process_failed:${input.command}:${code ?? "signal"}`),
        );
      }
    });
  });
}

async function makeTempDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function buildWritebackIdempotencyKey(
  env: NodeJS.ProcessEnv,
  leaseId: string,
): string {
  const runId = env.GITHUB_RUN_ID || "local";
  const runAttempt = env.GITHUB_RUN_ATTEMPT || "1";
  const digest = createHash("sha256")
    .update(`${leaseId}:${runId}:${runAttempt}`)
    .digest("hex")
    .slice(0, 24);
  return `idem:${runId}:${runAttempt}:${digest}`;
}

function clearActionAuthEnv(env: NodeJS.ProcessEnv): void {
  delete env["INPUT_AUTH-JSON"];
  delete env.INPUT_AUTH_JSON;
  delete env.REVIEWROUTER_CODEX_AUTH_JSON;
}

function clearOidcRequestEnv(env: NodeJS.ProcessEnv): void {
  delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
  delete env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
}

function notice(io: ActionIO, message: string): void {
  io.stdout.write(`::notice::${escapeCommandValue(message)}\n`);
}

function mask(io: ActionIO, value: string): void {
  if (value.length > 0) {
    io.stdout.write(`::add-mask::${escapeCommandValue(value)}\n`);
  }
}

function escapeCommandValue(value: string): string {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

function limitUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  return Buffer.from(value, "utf8")
    .subarray(0, maxBytes - 80)
    .toString("utf8")
    .replace(/\uFFFD+$/u, "")
    .concat("\n\n[ReviewRouter truncated this comment for GitHub limits.]");
}

function limitUtf8Tail(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  return Buffer.from(value, "utf8")
    .subarray(-maxBytes)
    .toString("utf8")
    .replace(/^\uFFFD+/u, "")
    .replace(/^[^\s]+/, "[truncated]");
}

function safeRemoteError(payload: unknown, status: number): string {
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    typeof (payload as { readonly error?: unknown }).error === "object"
  ) {
    const error = (payload as { readonly error: { readonly code?: unknown } })
      .error;
    if (typeof error.code === "string") return error.code;
  }
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    typeof (payload as { readonly error?: unknown }).error === "string"
  ) {
    return (payload as { readonly error: string }).error;
  }
  return `reviewrouter_api_error:${status}`;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid_event_field:${field}`);
  }
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`invalid_event_field:${field}`);
  }
  return value;
}

function requireSha(value: unknown, field: string): string {
  const sha = requireString(value, field);
  if (!/^[a-f0-9]{40}$/i.test(sha)) {
    throw new Error(`invalid_event_field:${field}`);
  }
  return sha;
}

if (
  process.env.REVIEW_ROUTER_RUN_CODEX_ROTATING_ACTION === "1" ||
  process.env.GITHUB_ACTIONS === "true"
) {
  runCodexRotatingGitHubAction().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown_error";
    process.stderr.write(`::error::${escapeCommandValue(message)}\n`);
    process.exitCode = 1;
  });
}
