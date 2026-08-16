import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import type { PrismaClient } from "@prisma/client";
import {
  admitRelayRequest as admitHostedPoolRelayRequest,
  recordSuccessfulProviderResponse as recordHostedPoolSuccessfulProviderResponse,
  recordProviderResponseStarted,
} from "../../application/use-cases/manage-invocation-grant.js";
import { failoverCurrentRelayRequestBeforeEffect } from "../../application/use-cases/failover-current-relay-request.js";
import {
  hostedBindingId,
  invocationGrantId,
  relayRequestId,
} from "../../domain/identifiers.js";
import type { InvocationGrantAuthority } from "../../domain/invocation-grant.js";
import type {
  AuthorizedHostedCodexRelay,
  HostedCodexRelayAuthorizationPort,
  HostedCodexStreamingRelayPort,
} from "../../interface/http/register-hosted-codex-relay-routes.js";
import { PrismaInvocationGrantRepository } from "../prisma/prisma-invocation-grant-repository.js";
import type { HostedCodexSessionRuntime } from "../runtime/hosted-codex-session-runtime.js";

const upstreamResponsesUrl = "https://chatgpt.com/backend-api/codex/responses";

/** Re-resolves every mutable authority fact and atomically admits the request. */
export class PrismaHostedCodexRelayAuthorization implements HostedCodexRelayAuthorizationPort {
  private readonly ledger: PrismaInvocationGrantRepository;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly failoverEnabled = false,
  ) {
    this.ledger = new PrismaInvocationGrantRepository(prisma);
  }

  async authorize(
    input: Parameters<HostedCodexRelayAuthorizationPort["authorize"]>[0],
  ): Promise<AuthorizedHostedCodexRelay> {
    const tokenHash = sha256(input.opaqueGrant);
    const stored = await this.prisma.hostedCodexInvocationGrant.findUnique({
      where: { capabilityTokenHash: tokenHash },
      include: {
        binding: {
          include: {
            pool: true,
            repository: { include: { installation: true } },
          },
        },
        account: true,
      },
    });
    const now = new Date();
    if (
      !stored ||
      stored.status !== "issued" ||
      stored.revokedAt !== null ||
      stored.expiresAt <= now
    )
      throw new Error("hosted_grant_invalid");
    const { binding, account } = stored;
    const accountUsable =
      account.state === "healthy" ||
      (account.state === "cooldown" &&
        account.cooldownUntil !== null &&
        account.cooldownUntil <= now);
    if (
      binding.status !== "active" ||
      binding.revision !== stored.bindingRevision ||
      binding.pool.status !== "active" ||
      binding.pool.authzEpoch !== stored.authzEpoch ||
      binding.repository.archived ||
      !binding.repository.selected ||
      binding.repository.provider !== "github" ||
      binding.repository.githubRepositoryId === null ||
      binding.repository.installation === null ||
      binding.repository.installation.status !== "active" ||
      !["private", "internal"].includes(binding.repository.visibility) ||
      (!accountUsable && !this.failoverEnabled)
    )
      throw new Error("hosted_grant_authority_mismatch");

    const authority: InvocationGrantAuthority = {
      repositoryBindingId: hostedBindingId(stored.repositoryBindingId),
      reviewRequestId: stored.reviewRequestId,
      providerInvocationKey: stored.providerInvocationKey,
      runId: stored.runId,
      runAttempt: stored.runAttempt,
      model: stored.model,
      policyFingerprint: stored.policyFingerprint,
      runtimeConfigVersion: stored.runtimeConfigVersion,
      bindingRevision: Number(stored.bindingRevision),
      authzEpoch: stored.authzEpoch,
    };
    const requestId = relayRequestId(
      sha256(`${stored.id}\0${input.requestOrdinal}\0${input.idempotencyKey}`),
    );
    const admission = await admitHostedPoolRelayRequest(
      {
        grantId: invocationGrantId(stored.id),
        requestId,
        authority,
        ordinal: input.requestOrdinal,
        idempotencyKeyHash: sha256(input.idempotencyKey),
        requestBytes: input.requestBytes,
        now,
      },
      this.ledger,
    );
    if (
      admission.status !== "admitted" &&
      admission.status !== "already_admitted"
    ) {
      throw new Error(`hosted_relay_${admission.status}`);
    }
    if (admission.status === "already_admitted") {
      throw new Error("hosted_relay_replay_unsupported");
    }
    return {
      grantId: stored.id,
      requestId,
      accountId: admission.accountId,
      runId: stored.runId,
      runAttempt: stored.runAttempt,
      model: stored.model,
      accountUsable,
      grantExpiresAtMs: stored.expiresAt.getTime(),
      declaredRequestBytes: input.requestBytes,
      maxRequestBodyBytes: stored.maxRequestBytes,
    };
  }
}

/** Streams provider output while keeping the provider credential and request policy server-side. */
export class FetchHostedCodexStreamingRelay implements HostedCodexStreamingRelayPort {
  private readonly failoverEnabled: boolean;
  private readonly now: () => Date;

  constructor(
    private readonly runtime: HostedCodexSessionRuntime,
    private readonly ledger: PrismaInvocationGrantRepository,
    private readonly fetchImpl: typeof fetch = fetch,
    options: {
      readonly failoverEnabled: boolean;
      readonly now?: () => Date;
    } = { failoverEnabled: false },
  ) {
    this.failoverEnabled = options.failoverEnabled;
    this.now = options.now ?? (() => new Date());
  }

  async open(input: Parameters<HostedCodexStreamingRelayPort["open"]>[0]) {
    try {
      return await this.openAuthorized(input);
    } catch (error) {
      await completeFailedRequest(
        input.authorization,
        this.ledger,
        input.abortSignal.aborted ? "client_disconnected" : "relay_open_failed",
      );
      throw error;
    }
  }

  private async openAuthorized(
    input: Parameters<HostedCodexStreamingRelayPort["open"]>[0],
  ) {
    const rawRequestBody = await readBoundedBody(
      input.body,
      input.authorization.maxRequestBodyBytes,
      input.abortSignal,
    );
    if (
      rawRequestBody.byteLength !== input.authorization.declaredRequestBytes
    ) {
      throw new Error("hosted_relay_content_length_mismatch");
    }
    await this.ledger.recordRequestHash({
      grantId: input.authorization.grantId,
      requestId: input.authorization.requestId,
      requestHash: sha256Bytes(rawRequestBody),
    });
    const requestBody = parseRequestJson(rawRequestBody);
    let accountId = input.authorization.accountId;
    let failedOver = false;
    if (!input.authorization.accountUsable) {
      accountId = await this.switchToBackup(
        input.authorization,
        "needs_reconnect",
        null,
      );
      failedOver = true;
    }
    let upstream: Response;
    while (true) {
      try {
        const session = await this.runtime.ensureFreshSession({
          accountId,
          runId: input.authorization.runId,
          attempt: input.authorization.runAttempt,
          abortSignal: input.abortSignal,
        });
        const remainingMs =
          input.authorization.grantExpiresAtMs - this.now().getTime();
        if (remainingMs <= 0) throw new Error("hosted_grant_expired");
        upstream = await this.fetchImpl(upstreamResponsesUrl, {
          method: "POST",
          redirect: "error",
          headers: {
            authorization: `Bearer ${session.accessToken}`,
            "chatgpt-account-id": session.chatgptAccountId,
            "content-type": "application/json",
            accept: safeAccept(input.accept),
          },
          body: JSON.stringify({
            ...requestBody,
            model: input.authorization.model,
            store: false,
          }),
          signal: AbortSignal.any([
            input.abortSignal,
            AbortSignal.timeout(Math.min(remainingMs, 120_000)),
          ]),
        });
      } catch (error) {
        const failure = mapRuntimeFailure(
          this.runtime.classifyFailure(error).code,
        );
        if (failedOver || failure === null) throw error;
        accountId = await this.switchToBackup(
          input.authorization,
          failure,
          null,
        );
        failedOver = true;
        continue;
      }
      if (!failedOver && (upstream.status === 401 || upstream.status === 429)) {
        await upstream.body?.cancel();
        accountId = await this.switchToBackup(
          input.authorization,
          upstream.status === 429 ? "rate_limited" : "credential_invalid",
          upstream.status === 429
            ? new Date(this.now().getTime() + 15 * 60_000)
            : null,
        );
        failedOver = true;
        continue;
      }
      break;
    }
    if (!upstream.body) throw new Error("hosted_codex_upstream_body_missing");
    if (upstream.ok) {
      await recordProviderResponseStarted(
        {
          grantId: invocationGrantId(input.authorization.grantId),
          requestId: relayRequestId(input.authorization.requestId),
          startedAt: new Date(),
        },
        this.ledger,
      );
    }
    const body = Readable.fromWeb(upstream.body as never).pipe(
      completionTransform(input.authorization, this.ledger, upstream.ok),
    );
    return {
      statusCode: upstream.status,
      headers: safeResponseHeaders(upstream.headers),
      body,
    };
  }

  private async switchToBackup(
    authorization: AuthorizedHostedCodexRelay,
    failure: "rate_limited" | "credential_invalid" | "needs_reconnect",
    cooldownUntil: Date | null,
  ): Promise<string> {
    if (!this.failoverEnabled)
      throw new Error("hosted_codex_failover_disabled");
    const result = await failoverCurrentRelayRequestBeforeEffect(
      {
        grantId: invocationGrantId(authorization.grantId),
        requestId: relayRequestId(authorization.requestId),
        failure,
        effectFence: "before_refresh_or_upstream_effect",
        cooldownUntil,
        now: this.now(),
      },
      this.ledger,
    );
    if (result.status !== "switched") {
      throw new Error(`hosted_codex_failover_denied:${result.reason}`);
    }
    return result.grant.activeAccountId;
  }
}

async function completeFailedRequest(
  authorization: AuthorizedHostedCodexRelay,
  ledger: PrismaInvocationGrantRepository,
  errorCode: string,
): Promise<void> {
  await ledger.ensureRequestHash({
    grantId: authorization.grantId,
    requestId: authorization.requestId,
    fallbackRequestHash: sha256(""),
  });
  await ledger.complete({
    grantId: invocationGrantId(authorization.grantId),
    requestId: relayRequestId(authorization.requestId),
    responseBytes: 0,
    responseHash: sha256(""),
    errorCode,
    completedAt: new Date(),
    transition: (grant) => ({
      ...grant,
      inFlightRequestIds: grant.inFlightRequestIds.filter(
        (id) => id !== authorization.requestId,
      ),
    }),
  });
}

function mapRuntimeFailure(
  code: string,
): "rate_limited" | "credential_invalid" | "needs_reconnect" | null {
  if (code === "quota_limited") return "rate_limited";
  if (code === "provider_session_invalid") return "credential_invalid";
  if (code === "needs_reconnect") return "needs_reconnect";
  return null;
}

function safeAccept(value: string | undefined): string {
  if (!value) return "text/event-stream";
  const normalized = value.toLowerCase().split(";", 1)[0]?.trim();
  if (normalized !== "text/event-stream" && normalized !== "application/json") {
    throw new Error("hosted_relay_accept_invalid");
  }
  return normalized;
}

async function readBoundedBody(
  body: Readable,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of body) {
    if (signal.aborted) throw signal.reason;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxBytes)
      throw new Error("hosted_relay_request_bytes_exceeded");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseRequestJson(body: Buffer): Record<string, unknown> {
  const parsed: unknown = JSON.parse(body.toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("hosted_relay_request_invalid");
  }
  return parsed as Record<string, unknown>;
}

function completionTransform(
  authorization: AuthorizedHostedCodexRelay,
  ledger: PrismaInvocationGrantRepository,
  succeeded: boolean,
): Transform {
  const hash = createHash("sha256");
  let bytes = 0;
  let finalized = false;
  const finalize = (
    success: boolean,
    errorCode: string | null,
    callback: (error?: Error | null) => void,
    propagatedError?: Error | null,
  ) => {
    if (finalized) return callback(propagatedError);
    finalized = true;
    const responseHash = hash.digest("hex");
    const common = {
      grantId: invocationGrantId(authorization.grantId),
      requestId: relayRequestId(authorization.requestId),
      responseBytes: bytes,
      responseHash,
      completedAt: new Date(),
    };
    const completion = success
      ? recordHostedPoolSuccessfulProviderResponse(common, ledger)
      : ledger.complete({
          ...common,
          errorCode: errorCode ?? "upstream_stream_failed",
          transition: (grant) => ({
            ...grant,
            inFlightRequestIds: grant.inFlightRequestIds.filter(
              (id) => id !== common.requestId,
            ),
          }),
        });
    completion.then(
      () => callback(propagatedError),
      (error) =>
        callback(
          error instanceof Error ? error : new Error("relay_completion_failed"),
        ),
    );
  };
  return new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      hash.update(buffer);
      callback(null, buffer);
    },
    flush(callback) {
      finalize(succeeded, succeeded ? null : "provider_http_error", callback);
    },
    destroy(error, callback) {
      if (!error || finalized) return callback(error);
      const code = error.message.includes("client_disconnected")
        ? "client_disconnected"
        : "upstream_stream_failed";
      finalize(false, code, callback, error);
    },
  });
}

function safeResponseHeaders(headers: Headers): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const name of [
    "content-type",
    "cache-control",
    "retry-after",
    "x-request-id",
  ]) {
    const value = headers.get(name);
    if (value !== null) safe[name] = value;
  }
  return safe;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
