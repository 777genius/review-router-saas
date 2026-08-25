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
import {
  HostedCodexFailoverOutcomeUnknownError,
  PrismaInvocationGrantRepository,
} from "../prisma/prisma-invocation-grant-repository.js";
import {
  HostedCodexEffectReservationOutcomeUnknownError,
  PrismaHostedCodexUpstreamEffectLedger,
  type HostedCodexUpstreamEffectLease,
} from "../prisma/prisma-hosted-codex-upstream-effect-ledger.js";
import type { HostedCodexSessionRuntime } from "../runtime/hosted-codex-session-runtime.js";
import {
  noHostedCodexCanaryFaultPlan,
  type HostedCodexCanaryFaultPlanPort,
} from "../../application/ports/hosted-codex-canary-fault-plan-port.js";

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
    const requestId = relayRequestId(
      sha256(
        `${stored?.id ?? "missing"}\0${input.requestOrdinal}\0${input.idempotencyKey}`,
      ),
    );
    const resumableNoEffectRequest =
      stored?.status === "exhausted"
        ? await this.prisma.hostedCodexRelayRequest.findFirst({
            where: {
              id: requestId,
              grantId: stored.id,
              status: "failed",
              errorCode: "upstream_dispatch_not_started",
              upstreamAttempts: { some: { state: "failed_no_effect" } },
            },
            select: { id: true },
          })
        : null;
    if (
      !stored ||
      (stored.status !== "issued" && !resumableNoEffectRequest) ||
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
      !accountUsable
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
    if (admission.status === "already_admitted")
      throw new Error("hosted_relay_replay_unsupported");
    return {
      grantId: stored.id,
      requestId,
      accountId: admission.accountId,
      workspaceId: stored.workspaceId,
      poolId: stored.poolId,
      runId: stored.runId,
      runAttempt: stored.runAttempt,
      model: stored.model,
      accountUsable,
      grantExpiresAtMs: stored.expiresAt.getTime(),
      declaredRequestBytes: input.requestBytes,
      maxRequestBodyBytes: stored.maxRequestBytes,
      faultPlanScope: {
        workspaceId: stored.workspaceId,
        githubRepositoryId: binding.repository.githubRepositoryId,
        actionRef: binding.workflowActionRef ?? "",
        repositoryBindingId: binding.id,
        bindingRevision: stored.bindingRevision,
        requestOrdinal: input.requestOrdinal,
      },
    };
  }
}

/** Streams provider output while keeping the provider credential and request policy server-side. */
export class FetchHostedCodexStreamingRelay implements HostedCodexStreamingRelayPort {
  private readonly failoverEnabled: boolean;
  private readonly now: () => Date;
  private readonly heartbeatIntervalMs: number;
  private readonly effects: Pick<
    PrismaHostedCodexUpstreamEffectLedger,
    | "prepare"
    | "markDispatching"
    | "heartbeat"
    | "markResponseStarted"
    | "authority"
  >;

  constructor(
    private readonly runtime: HostedCodexSessionRuntime,
    private readonly ledger: PrismaInvocationGrantRepository,
    private readonly fetchImpl: typeof fetch = fetch,
    options: {
      readonly failoverEnabled: boolean;
      readonly now?: () => Date;
      readonly heartbeatIntervalMs?: number;
      readonly effects?: Pick<
        PrismaHostedCodexUpstreamEffectLedger,
        | "prepare"
        | "markDispatching"
        | "heartbeat"
        | "markResponseStarted"
        | "authority"
      >;
      readonly faultPlans?: HostedCodexCanaryFaultPlanPort;
    } = { failoverEnabled: false },
  ) {
    this.failoverEnabled = options.failoverEnabled;
    this.now = options.now ?? (() => new Date());
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    if (
      !Number.isSafeInteger(this.heartbeatIntervalMs) ||
      this.heartbeatIntervalMs < 5 ||
      this.heartbeatIntervalMs > 10_000
    ) {
      throw new Error("hosted_codex_effect_heartbeat_interval_invalid");
    }
    this.effects =
      options.effects ??
      new PrismaHostedCodexUpstreamEffectLedger(
        // The concrete ledger deliberately shares the same Prisma authority.
        ledger.prismaClient,
        this.now,
      );
    this.faultPlans = options.faultPlans ?? noHostedCodexCanaryFaultPlan;
  }

  private readonly faultPlans: HostedCodexCanaryFaultPlanPort;

  async open(input: Parameters<HostedCodexStreamingRelayPort["open"]>[0]) {
    try {
      return await this.openAuthorized(input);
    } catch (error) {
      if (
        error instanceof UpstreamTerminalUnknownError ||
        error instanceof UpstreamNoEffectError ||
        error instanceof HostedCodexEffectReservationOutcomeUnknownError
      )
        throw error.cause;
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
    const requestHash = sha256Bytes(rawRequestBody);
    let accountId = input.authorization.accountId;
    let failedOver = false;
    let upstream: Response;
    let effectLease: HostedCodexUpstreamEffectLease;
    let streamHeartbeat: EffectHeartbeat | undefined;
    while (true) {
      let session;
      try {
        session = await this.runtime.ensureFreshSession({
          accountId,
          runId: input.authorization.runId,
          attempt: input.authorization.runAttempt,
          abortSignal: input.abortSignal,
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
      const remainingMs =
        input.authorization.grantExpiresAtMs - this.now().getTime();
      if (remainingMs <= 0) throw new Error("hosted_grant_expired");
      effectLease = await this.effects.prepare({
        relayRequestId: input.authorization.requestId,
        grantId: input.authorization.grantId,
        workspaceId: input.authorization.workspaceId,
        poolId: input.authorization.poolId,
        accountId,
        requestHash,
      });
      try {
        const syntheticFault = await this.consumeFault(
          input.authorization,
          "before_provider_fetch",
          effectLease.attemptOrdinal,
        );
        if (failedOver && syntheticFault !== null)
          throw new Error("hosted_codex_canary_fault_plan_not_one_shot");
        if (
          !failedOver &&
          (syntheticFault === "synthetic_unauthorized" ||
            syntheticFault === "synthetic_rate_limited")
        ) {
          const syntheticStatus =
            syntheticFault === "synthetic_rate_limited" ? 429 : 401;
          accountId = await this.switchToBackup(
            input.authorization,
            syntheticStatus === 429 ? "rate_limited" : "credential_invalid",
            syntheticStatus === 429
              ? new Date(this.now().getTime() + 15 * 60_000)
              : null,
            {
              lease: effectLease,
              status: syntheticStatus,
              sourceState: "prepared",
            },
          );
          failedOver = true;
          continue;
        }
        await this.effects.markDispatching(effectLease);
      } catch (error) {
        if (error instanceof HostedCodexFailoverOutcomeUnknownError) {
          throw new UpstreamNoEffectError(error);
        }
        try {
          await completeFailedRequest(
            input.authorization,
            this.ledger,
            "relay_open_failed",
            effectCompletion(
              this.effects,
              effectLease,
              "failed_no_effect",
              "pre-dispatch-failure",
            ),
          );
        } catch (completionError) {
          throw new UpstreamNoEffectError(completionError);
        }
        throw new UpstreamNoEffectError(error);
      }
      let heartbeat = startEffectHeartbeat(
        this.effects,
        effectLease,
        this.heartbeatIntervalMs,
      );
      try {
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
        heartbeat.assertHealthy();
        await heartbeat.stop();
        const providerResponseId = upstream.headers.get("x-request-id");
        if (upstream.ok) {
          await recordProviderResponseStarted(
            {
              grantId: invocationGrantId(input.authorization.grantId),
              requestId: relayRequestId(input.authorization.requestId),
              startedAt: this.now(),
              effect: {
                ...this.effects.authority(effectLease),
                providerResponseIdHash: providerResponseId
                  ? sha256(providerResponseId)
                  : null,
              },
            },
            this.ledger,
          );
          const droppedFault = await this.consumeFault(
            input.authorization,
            "after_response_started",
            effectLease.attemptOrdinal,
          );
          if (droppedFault === "drop_after_response_started") {
            await upstream.body?.cancel();
            await terminalizeUnknownRequest(
              input.authorization,
              this.ledger,
              "ambiguous_dropped_response",
              effectCompletion(
                this.effects,
                effectLease,
                "terminal_unknown",
                "operator-canary-dropped-response",
              ),
              this.now(),
            );
            throw new UpstreamTerminalUnknownError(
              new Error("hosted_codex_canary_dropped_response"),
            );
          }
        } else {
          await this.effects.markResponseStarted(
            effectLease,
            providerResponseId,
          );
        }
        heartbeat.assertHealthy();
        if (
          !failedOver &&
          (upstream.status === 401 || upstream.status === 429)
        ) {
          await upstream.body?.cancel();
          accountId = await this.switchToBackup(
            input.authorization,
            upstream.status === 429 ? "rate_limited" : "credential_invalid",
            upstream.status === 429
              ? new Date(this.now().getTime() + 15 * 60_000)
              : null,
            {
              lease: effectLease,
              status: upstream.status,
              sourceState: "response_started",
            },
          );
          await heartbeat.stop();
          failedOver = true;
          continue;
        }
        heartbeat = startEffectHeartbeat(
          this.effects,
          effectLease,
          this.heartbeatIntervalMs,
        );
        streamHeartbeat = heartbeat;
      } catch (error) {
        await heartbeat.stop();
        if (error instanceof UpstreamTerminalUnknownError) throw error;
        await terminalizeUnknownRequest(
          input.authorization,
          this.ledger,
          "upstream_dispatch_outcome_unknown",
          effectCompletion(
            this.effects,
            effectLease,
            "terminal_unknown",
            "post-dispatch-failure",
          ),
          this.now(),
        );
        throw new UpstreamTerminalUnknownError(error);
      }
      break;
    }
    if (!upstream.body) {
      await streamHeartbeat?.stop();
      await terminalizeUnknownRequest(
        input.authorization,
        this.ledger,
        "upstream_body_missing",
        effectCompletion(
          this.effects,
          effectLease,
          "terminal_unknown",
          "body-missing",
        ),
        this.now(),
      );
      throw new UpstreamTerminalUnknownError(
        new Error("hosted_codex_upstream_body_missing"),
      );
    }
    try {
      const body = Readable.fromWeb(upstream.body as never).pipe(
        completionTransform(
          input.authorization,
          this.ledger,
          this.effects,
          effectLease,
          upstream.ok,
          streamHeartbeat,
          this.now,
        ),
      );
      return {
        statusCode: upstream.status,
        headers: safeResponseHeaders(upstream.headers),
        body,
      };
    } catch (error) {
      await streamHeartbeat?.stop();
      await terminalizeUnknownRequest(
        input.authorization,
        this.ledger,
        "upstream_stream_setup_failed",
        effectCompletion(
          this.effects,
          effectLease,
          "terminal_unknown",
          "stream-setup-failed",
        ),
        this.now(),
      );
      throw new UpstreamTerminalUnknownError(error);
    }
  }

  private async consumeFault(
    authorization: AuthorizedHostedCodexRelay,
    injectionPoint: "before_provider_fetch" | "after_response_started",
    attemptOrdinal: number,
  ) {
    const scope = authorization.faultPlanScope;
    if (!scope) return null;
    return this.faultPlans.consume({
      workspaceId: scope.workspaceId,
      githubRepositoryId: scope.githubRepositoryId,
      runId: authorization.runId,
      runAttempt: authorization.runAttempt,
      actionRef: scope.actionRef,
      repositoryBindingId: scope.repositoryBindingId,
      bindingRevision: scope.bindingRevision,
      requestOrdinal: scope.requestOrdinal,
      attemptOrdinal,
      injectionPoint,
    });
  }

  private async switchToBackup(
    authorization: AuthorizedHostedCodexRelay,
    failure: "rate_limited" | "credential_invalid" | "needs_reconnect",
    cooldownUntil: Date | null,
    classifiedEffect?: {
      readonly lease: HostedCodexUpstreamEffectLease;
      readonly status: number;
      readonly sourceState: "prepared" | "response_started";
    },
  ): Promise<string> {
    if (!this.failoverEnabled)
      throw new Error("hosted_codex_failover_disabled");
    const result = await failoverCurrentRelayRequestBeforeEffect(
      {
        grantId: invocationGrantId(authorization.grantId),
        requestId: relayRequestId(authorization.requestId),
        failure,
        effectFence: classifiedEffect
          ? classifiedEffect.sourceState === "response_started"
            ? "classified_response_before_success"
            : "before_refresh_or_upstream_effect"
          : "before_refresh_or_upstream_effect",
        cooldownUntil,
        now: this.now(),
        ...(classifiedEffect
          ? {
              effect:
                classifiedEffect.sourceState === "prepared"
                  ? {
                      ...this.effects.authority(classifiedEffect.lease),
                      sourceState: "prepared" as const,
                      terminalState: "failed_no_effect" as const,
                      terminalEvidenceHash: sha256(
                        `prepared\u0000${classifiedEffect.status}\u0000${classifiedEffect.lease.attemptId}`,
                      ),
                      errorCode:
                        classifiedEffect.status === 429
                          ? "quota_limited"
                          : "credential_invalid",
                    }
                  : {
                      ...this.effects.authority(classifiedEffect.lease),
                      sourceState: "response_started" as const,
                      terminalState: "failed_classified" as const,
                      terminalEvidenceHash: sha256(
                        `response_started\u0000${classifiedEffect.status}\u0000${classifiedEffect.lease.attemptId}`,
                      ),
                      errorCode:
                        classifiedEffect.status === 429
                          ? "quota_limited"
                          : "credential_invalid",
                    },
            }
          : {}),
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
  effect?: Parameters<PrismaInvocationGrantRepository["complete"]>[0]["effect"],
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
    ...(effect ? { effect } : {}),
    transition: (grant) => ({
      ...grant,
      inFlightRequestIds: grant.inFlightRequestIds.filter(
        (id) => id !== authorization.requestId,
      ),
    }),
  });
}

async function terminalizeUnknownRequest(
  authorization: AuthorizedHostedCodexRelay,
  ledger: PrismaInvocationGrantRepository,
  errorCode: string,
  effect: ReturnType<typeof effectCompletion>,
  completedAt = new Date(),
): Promise<void> {
  try {
    await ledger.terminalizeUnknown({
      grantId: invocationGrantId(authorization.grantId),
      requestId: relayRequestId(authorization.requestId),
      completedAt,
      errorCode,
      effect,
    });
  } catch (error) {
    // Once dispatch began, even a local terminalization write failure must not
    // fall back to the ordinary failed-request path and reopen the capability.
    // The durable dispatching effect remains for the conservative sweeper.
    throw new UpstreamTerminalUnknownError(error);
  }
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
  effects: Pick<PrismaHostedCodexUpstreamEffectLedger, "authority">,
  effectLease: HostedCodexUpstreamEffectLease,
  succeeded: boolean,
  heartbeat: EffectHeartbeat | undefined,
  now: () => Date,
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
      completedAt: now(),
    };
    const completion = (async () => {
      await heartbeat?.stop();
      return success
        ? recordHostedPoolSuccessfulProviderResponse(
            {
              ...common,
              effect: effectCompletion(
                effects,
                effectLease,
                "succeeded",
                "stream-complete",
              ),
            },
            ledger,
          )
        : terminalizeUnknownRequest(
            authorization,
            ledger,
            errorCode ?? "upstream_stream_failed",
            effectCompletion(
              effects,
              effectLease,
              "terminal_unknown",
              errorCode ?? "upstream-stream-failed",
            ),
            now(),
          );
    })();
    completion.then(
      () => callback(propagatedError),
      async (error) => {
        if (success) {
          try {
            await terminalizeUnknownRequest(
              authorization,
              ledger,
              "upstream_completion_persistence_failed",
              effectCompletion(
                effects,
                effectLease,
                "terminal_unknown",
                "completion-persistence-failed",
              ),
              now(),
            );
          } catch (terminalError) {
            callback(asError(terminalError));
            return;
          }
        }
        callback(
          error instanceof Error ? error : new Error("relay_completion_failed"),
        );
      },
    );
  };
  const transform = new Transform({
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
  heartbeat?.onFailure((error) => transform.destroy(asError(error)));
  return transform;
}

type EffectHeartbeat = {
  readonly assertHealthy: () => void;
  readonly onFailure: (handler: (error: unknown) => void) => void;
  readonly stop: () => Promise<void>;
};

function startEffectHeartbeat(
  effects: Pick<PrismaHostedCodexUpstreamEffectLedger, "heartbeat">,
  lease: HostedCodexUpstreamEffectLease,
  intervalMs: number,
): EffectHeartbeat {
  let heartbeatFailure: unknown;
  let failureHandler: ((error: unknown) => void) | undefined;
  let stopped = false;
  let pending = Promise.resolve();
  const timer = setInterval(() => {
    if (stopped) return;
    pending = pending.then(async () => {
      if (stopped) return;
      try {
        await effects.heartbeat(lease);
      } catch (error) {
        if (heartbeatFailure) return;
        heartbeatFailure = error;
        failureHandler?.(error);
      }
    });
  }, intervalMs);
  timer.unref();
  return {
    assertHealthy: () => {
      if (heartbeatFailure) throw heartbeatFailure;
    },
    onFailure: (handler) => {
      failureHandler = handler;
      if (heartbeatFailure) handler(heartbeatFailure);
    },
    stop: async () => {
      if (stopped) return pending;
      stopped = true;
      clearInterval(timer);
      await pending;
    },
  };
}

function asError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("hosted_codex_effect_heartbeat_failed");
}

function effectCompletion(
  effects: Pick<PrismaHostedCodexUpstreamEffectLedger, "authority">,
  lease: HostedCodexUpstreamEffectLease,
  terminalState: "succeeded" | "failed_no_effect" | "terminal_unknown",
  evidence: string,
) {
  return {
    ...effects.authority(lease),
    terminalState,
    terminalEvidenceHash: sha256(
      `${evidence}\u0000${lease.attemptId}\u0000${lease.fenceEpoch.toString()}`,
    ),
  };
}

class UpstreamTerminalUnknownError extends Error {
  constructor(readonly cause: unknown) {
    super("hosted_codex_upstream_terminal_unknown");
  }
}

class UpstreamNoEffectError extends Error {
  constructor(readonly cause: unknown) {
    super("hosted_codex_upstream_no_effect");
  }
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
