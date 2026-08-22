import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  FinalizedLease,
  LeaseAcquireResult,
  LeaseStorePort,
  IdGeneratorPort,
  SessionArtifact,
  SessionEnvelope,
  SessionStorePort,
  SessionWriteResult,
  WorkspacePort,
  WritebackCommitResult,
} from "@777genius/subscription-runtime/core";
import {
  createSubscriptionRuntime,
  DefaultRedactor,
  NullObservability,
  SystemClock,
} from "@777genius/subscription-runtime/core";
import {
  CodexJsonAgentDriver,
  CodexCliSessionDriver,
  classifyCodexFailure,
  codexAuthJsonFromArtifact,
  sessionArtifactFromCodexAuthJson,
  validateCodexSessionArtifact,
  validateCodexAuthJsonBytes,
} from "@777genius/subscription-runtime/provider-codex";
import { NodeProcessRunner } from "@777genius/subscription-runtime/worker-local";

export type PersistedHostedCodexSession = {
  readonly accountId: string;
  readonly authJsonBytes: Uint8Array;
  readonly generation: number;
  readonly generationHash: string;
  readonly storageVersion: string;
};

export interface HostedCodexSessionPersistencePort {
  read(accountId: string): Promise<PersistedHostedCodexSession | null>;
  compareAndSwap(input: {
    readonly accountId: string;
    readonly expectedGeneration: number;
    readonly nextAuthJsonBytes: Uint8Array;
    readonly nextGenerationHash: string;
    readonly idempotencyKey: string;
    readonly leaseId: string;
  }): Promise<
    | {
        readonly status: "accepted" | "idempotent_replay";
        readonly generation: number;
        readonly generationHash: string;
      }
    | {
        readonly status: "stale_generation";
        readonly currentGeneration: number;
        readonly currentGenerationHash: string;
      }
  >;
}

export interface HostedCodexMutationFencePort {
  acquire(input: {
    readonly accountId: string;
    readonly runId: string;
    readonly attempt: number;
    readonly ttlMs: number;
    readonly restoredGenerationHash: string;
  }): Promise<LeaseAcquireResult>;
  finalize(input: {
    readonly leaseId: string;
    readonly restoredGenerationHash: string;
  }): Promise<FinalizedLease>;
  markWritebackStarted(input: {
    readonly leaseId: string;
    readonly keyId?: string;
  }): Promise<void>;
  markWritebackCommitted(input: {
    readonly leaseId: string;
    readonly nextGenerationHash: string;
    readonly idempotencyKey: string;
  }): Promise<WritebackCommitResult>;
  release(input: {
    readonly leaseId: string;
    readonly reason: string;
  }): Promise<void>;
}

export class HostedCodexSessionStore implements SessionStorePort {
  readonly storeId = "reviewrouter-hosted-codex-envelope-v1";
  readonly custody = "backend-custody" as const;
  readonly capabilities = {
    storeId: this.storeId,
    custody: this.custody,
    supportsRead: true,
    supportsWriteback: true,
    supportsCompareAndSwap: true,
    supportsIdempotency: true,
    supportsDelete: false,
    supportsAuditLog: true,
    supportsMetadataOnlyHealthCheck: true,
    plaintextAvailableToBackend: true,
    maxArtifactBytes: 256_000,
  } as const;

  constructor(
    private readonly persistence: HostedCodexSessionPersistencePort,
  ) {}

  async read(input: {
    readonly providerInstanceId: string;
    readonly expectedProviderId?: string;
  }): Promise<SessionEnvelope | null> {
    const stored = await this.persistence.read(input.providerInstanceId);
    if (!stored) return null;
    try {
      const authJson = Buffer.from(stored.authJsonBytes).toString("utf8");
      const artifact = validatedArtifact(authJson);
      if (
        input.expectedProviderId &&
        input.expectedProviderId !== artifact.providerId
      ) {
        return null;
      }
      return {
        providerInstanceId: stored.accountId,
        providerId: artifact.providerId,
        artifact,
        generation: stored.generation,
        generationHash: stored.generationHash,
        storageVersion: stored.storageVersion,
        custody: this.custody,
        metadata: {},
      };
    } finally {
      stored.authJsonBytes.fill(0);
    }
  }

  async write(input: {
    readonly providerInstanceId: string;
    readonly expectedGeneration: number;
    readonly nextArtifact: SessionArtifact;
    readonly idempotencyKey: string;
    readonly leaseId: string;
  }): Promise<SessionWriteResult> {
    const authJson = codexAuthJsonFromArtifact(input.nextArtifact);
    validatedArtifact(authJson);
    const bytes = Buffer.from(authJson, "utf8");
    const result = await this.persistence.compareAndSwap({
      accountId: input.providerInstanceId,
      expectedGeneration: input.expectedGeneration,
      nextAuthJsonBytes: bytes,
      nextGenerationHash: sha256(bytes),
      idempotencyKey: input.idempotencyKey,
      leaseId: input.leaseId,
    });
    bytes.fill(0);
    if (result.status === "stale_generation") return result;
    return result;
  }
}

export class HostedCodexMutationFenceLeaseStore implements LeaseStorePort {
  readonly leaseStoreId = "reviewrouter-hosted-codex-mutation-fence-v1";
  readonly capabilities = {
    leaseStoreId: this.leaseStoreId,
    supportsTtl: true,
    supportsFinalize: true,
    supportsWritebackCommit: true,
  } as const;

  constructor(private readonly fences: HostedCodexMutationFencePort) {}

  acquire(input: Parameters<LeaseStorePort["acquire"]>[0]) {
    return this.fences.acquire({
      accountId: input.providerInstanceId,
      ...input,
    });
  }
  finalize(input: Parameters<LeaseStorePort["finalize"]>[0]) {
    return this.fences.finalize(input);
  }
  markWritebackStarted(
    input: Parameters<LeaseStorePort["markWritebackStarted"]>[0],
  ) {
    return this.fences.markWritebackStarted(input);
  }
  markWritebackCommitted(
    input: Parameters<LeaseStorePort["markWritebackCommitted"]>[0],
  ) {
    return this.fences.markWritebackCommitted(input);
  }
  release(input: { readonly leaseId: string; readonly reason: string }) {
    return this.fences.release(input);
  }
}

export class HostedCodexSessionRuntime {
  readonly sessionDriver: CodexCliSessionDriver;
  private readonly runtime: ReturnType<typeof createSubscriptionRuntime>;

  constructor(input: {
    readonly sessionStore: HostedCodexSessionStore;
    readonly leaseStore: HostedCodexMutationFenceLeaseStore;
    readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
  }) {
    const codexBinaryPath = resolveHostedCodexBinaryPath();
    const sourceEnv = input.sourceEnv ?? {
      PATH: process.env.PATH,
      LANG: process.env.LANG,
      TMPDIR: process.env.TMPDIR,
    };
    this.sessionDriver = new CodexCliSessionDriver({
      codexBinaryPath,
      sourceEnv,
      refreshMode: "lazy-refresh",
    });
    const agentDriver = new CodexJsonAgentDriver({
      codexBinaryPath,
      sourceEnv,
    });
    const redactor = new DefaultRedactor();
    const runner = new NodeProcessRunner();
    this.runtime = createSubscriptionRuntime({
      policy: {
        custodyMode: "backend-custody",
        requireNoBackendPlaintext: false,
        requireWritebackBeforeTask: true,
        requireCompareAndSwap: true,
        allowInteractiveSetupInRuntime: false,
        allowedProviderIds: [this.sessionDriver.providerId],
        allowedAgentIds: [agentDriver.agentId],
        allowedStoreIds: [input.sessionStore.storeId],
        allowedRunnerIds: [runner.runnerId],
      },
      sessionDriver: this.sessionDriver,
      agentDriver,
      sessionStore: input.sessionStore,
      leaseStore: input.leaseStore,
      runner,
      workspace: new HostedCodexRefreshWorkspace(),
      redactor,
      observability: new NullObservability(),
      clock: new SystemClock(),
      idGenerator: new CryptoSubscriptionRuntimeIdGenerator(),
    });
  }

  validateAuthJsonBytes(authJsonBytes: Uint8Array): SessionArtifact {
    return validatedArtifact(Buffer.from(authJsonBytes).toString("utf8"));
  }

  classifyFailure(error: unknown) {
    return classifyCodexFailure(error);
  }

  async ensureFreshSession(input: {
    readonly accountId: string;
    readonly runId: string;
    readonly attempt: number;
    readonly abortSignal: AbortSignal;
  }): Promise<{
    readonly accessToken: string;
    readonly chatgptAccountId: string;
  }> {
    const refreshInput = {
      providerInstanceId: input.accountId,
      runContext: {
        runId: input.runId,
        attempt: input.attempt,
        abortSignal: input.abortSignal,
      },
    } as const;
    const waitDeadline = Date.now() + 15_000;
    let refresh = await this.runtime.refreshSession(refreshInput);
    while (isConcurrentRefreshResult(refresh) && Date.now() < waitDeadline) {
      await abortableDelay(100, input.abortSignal);
      refresh = await this.runtime.refreshSession(refreshInput);
    }
    if (refresh.status === "blocked") {
      throw new Error(`hosted_codex_refresh_blocked:${refresh.reason}`);
    }
    if (refresh.status === "skipped" && refresh.reason === "stale_generation") {
      throw new Error("hosted_codex_refresh_stale_generation");
    }
    const artifact =
      refresh.status === "ready"
        ? refresh.session.artifact
        : refresh.session?.artifact;
    if (!artifact) throw new Error("hosted_codex_refreshed_session_missing");
    const authJson = codexAuthJsonFromArtifact(artifact);
    const parsed = validateCodexAuthJsonBytes({
      authJsonBytes: authJson,
    }).parsed;
    const accessToken = parsed.tokens.access_token;
    if (!accessToken) throw new Error("hosted_codex_access_token_missing");
    const idToken = parsed.tokens.id_token;
    if (!idToken) throw new Error("hosted_codex_id_token_missing");
    return {
      accessToken,
      chatgptAccountId: extractChatgptAccountId(idToken),
    };
  }
}

function isConcurrentRefreshResult(result: {
  readonly status: string;
  readonly reason?: string;
  readonly safeMessage?: string;
}): boolean {
  return (
    (result.status === "blocked" &&
      result.reason === "permission_required" &&
      result.safeMessage === "Account is refreshing.") ||
    (result.status === "skipped" && result.reason === "stale_generation")
  );
}

function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(done, milliseconds);
    function done() {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", aborted);
      reject(signal.reason);
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

/** Extracts the ChatGPT workspace identity from the validated ID token only. */
export function extractChatgptAccountId(idToken: string): string {
  const parts = idToken.split(".");
  if (parts.length !== 3 || !parts[1]) {
    throw new Error("hosted_codex_id_token_invalid");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("hosted_codex_id_token_invalid");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("hosted_codex_id_token_invalid");
  }
  const claims = payload as Record<string, unknown>;
  const auth = claims["https://api.openai.com/auth"];
  const candidates = [
    claims.chatgpt_account_id,
    claims["https://api.openai.com/auth.chatgpt_account_id"],
    auth && typeof auth === "object" && !Array.isArray(auth)
      ? (auth as Record<string, unknown>).chatgpt_account_id
      : undefined,
  ].filter(
    (value): value is string =>
      typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value),
  );
  const unique = new Set(candidates);
  if (unique.size !== 1) {
    throw new Error(
      unique.size === 0
        ? "hosted_codex_chatgpt_account_id_missing"
        : "hosted_codex_chatgpt_account_id_conflict",
    );
  }
  return candidates[0]!;
}

export class CryptoSubscriptionRuntimeIdGenerator implements IdGeneratorPort {
  leaseId(): string {
    return `hosted-lease-${randomUUID()}`;
  }

  idempotencyKey(input: {
    readonly providerInstanceId: string;
    readonly runId: string;
    readonly attempt: number;
    readonly purpose: "refresh" | "writeback" | "run-task";
  }): string {
    const canonical = [
      "hosted-codex-runtime-v1",
      input.providerInstanceId,
      input.runId,
      String(input.attempt),
      input.purpose,
    ];
    if (canonical.some((value) => !value || value.includes("\u0000"))) {
      throw new Error("hosted_codex_idempotency_input_invalid");
    }
    return createHash("sha256")
      .update(canonical.join("\u0000"), "utf8")
      .digest("hex");
  }

  operationId(prefix: string): string {
    if (!/^[a-z0-9_-]{1,40}$/i.test(prefix)) {
      throw new Error("hosted_codex_operation_prefix_invalid");
    }
    return `${prefix}-${randomUUID()}`;
  }
}

class HostedCodexRefreshWorkspace implements WorkspacePort {
  readonly workspaceId = "reviewrouter-hosted-codex-refresh";
  readonly capabilities = {
    workspaceId: this.workspaceId,
    supportsTempDir: true,
    supportsExistingCheckout: false,
    supportsContainer: false,
  } as const;

  async create() {
    const path = await mkdtemp(join(tmpdir(), "reviewrouter-hosted-codex-"));
    return {
      path,
      dispose: async () => {
        await rm(path, { recursive: true, force: true });
      },
    };
  }
}

export function resolveHostedCodexBinaryPath(): string {
  const require = createRequire(import.meta.url);
  const packageRoot = dirname(require.resolve("@openai/codex/package.json"));
  return join(packageRoot, "bin", "codex.js");
}

function validatedArtifact(authJson: string): SessionArtifact {
  const artifact = sessionArtifactFromCodexAuthJson(authJson);
  const validation = validateCodexSessionArtifact(artifact);
  if (validation.status !== "valid") {
    throw new Error("hosted_codex_auth_json_invalid");
  }
  return artifact;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
