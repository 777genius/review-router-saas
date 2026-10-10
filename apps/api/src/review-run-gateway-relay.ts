import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import * as c from "@agent-teams/account-gateway/contracts";
import { GatewayError } from "@agent-teams/account-gateway/http";
import type { NativeResponse } from "@agent-teams/account-gateway/http";
import {
  canonicalJson,
  parseReviewRunRuntimeSnapshot,
  reviewRunGatewayOwnedIdentity,
  ReviewRunAuthorizationState,
  type ManageReviewRunAuthorizations,
  type ReviewRunAuthorization,
  type ReviewRunAuthorizationQueryPort,
  type ReviewRunGatewayExecutionBindingPort,
  type ReviewRunRuntimeSnapshotPort,
} from "@reviewrouter/features-review-run-control";
import { parseReviewConfigurationStrict } from "@reviewrouter/features-review-config/review-configuration";
import type { RunAccessConfig } from "./account-gateway-run-access";
import { createReviewRunGatewayPreparation } from "./review-run-gateway-preparation";

export type ReviewRunGatewayRelayPolicy = {
  readonly profiles: readonly {
    readonly profile: z.infer<typeof c.profile>;
    readonly outputTokens: number;
  }[];
  readonly ingressBytes: number;
  readonly requestTimeoutMs: number;
  readonly waitBudgetMs: number;
  readonly maxWaits: number;
  readonly maxSessions: number;
  readonly maxInFlight: number;
};

// Explicit server configuration; numbers are bounds, not qualification receipts.
const relayPolicy: z.ZodType<ReviewRunGatewayRelayPolicy> = z.strictObject({
  profiles: z
    .array(
      z.strictObject({
        profile: c.profile,
        outputTokens: c.limits.shape.tokens,
      }),
    )
    .min(1)
    .max(128),
  ingressBytes: z.number().int().min(1).max(16_777_216),
  requestTimeoutMs: z.number().int().min(1).max(3_600_000),
  waitBudgetMs: z.number().int().min(0).max(3_600_000),
  maxWaits: z.number().int().min(0).max(128),
  maxSessions: z.number().int().min(1).max(10_000),
  maxInFlight: z.number().int().min(1).max(10_000),
});
export function readReviewRunGatewayRelayPolicy(raw: string) {
  try {
    if (Buffer.byteLength(raw) > 4096) throw new Error();
    return Object.freeze(relayPolicy.parse(JSON.parse(raw)));
  } catch {
    throw new Error("review_run_gateway_relay_policy_invalid");
  }
}
class RelayFailure extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    readonly effect: c.RequestStatus["effect"] = "not_dispatched",
    readonly requestRef?: string,
  ) {
    super(code);
  }
}
type RelayDiagnostic = {
  stage:
    | "resolve"
    | "prepare"
    | "request"
    | "post_request_authority"
    | "stream_reader"
    | "stream_wrap"
    | "http_headers";
  bodyLocked: boolean;
};
type Preparation = ReturnType<typeof createReviewRunGatewayPreparation>;
type Session = {
  readonly preparation: Preparation;
  readonly canonical: string;
  readonly identity: string;
  readonly deadline: number;
  readonly aborts: Set<AbortController>;
  readonly timer: ReturnType<typeof setTimeout>;
  closed: boolean;
  closeReason?: c.Close["reason"];
};

/** Backend process memory contains capabilities only. SQL remains the sole run
 * authority/selected facts. Absence NEVER replays inference or auto-recovers. */
export function createReviewRunGatewayRelay(input: {
  readonly policy: ReviewRunGatewayRelayPolicy;
  readonly runAccess: RunAccessConfig;
  readonly authorizations: Pick<
    ManageReviewRunAuthorizations,
    | "resolveReviewRunAuthorizationToken"
    | "expireOrRevokeReviewRunAuthorization"
  >;
  readonly queries: ReviewRunAuthorizationQueryPort;
  // Async SCM preflight; final protected local authority follows the binding read.
  readonly checkAuthority: (
    authorization: ReviewRunAuthorization,
  ) => Promise<boolean>;
  readonly confirmAuthority: (
    token: string,
    authorization: ReviewRunAuthorization,
  ) => Promise<boolean>;
  readonly snapshots: ReviewRunRuntimeSnapshotPort;
  readonly bindings: ReviewRunGatewayExecutionBindingPort;
}) {
  const policy = Object.freeze(relayPolicy.parse(input.policy));
  if (
    new Set(policy.profiles.map((entry) => entry.profile.profileId)).size !==
    policy.profiles.length
  )
    throw new Error("review_run_gateway_relay_policy_invalid");
  for (const entry of policy.profiles) {
    Object.freeze(entry.profile.modelIds);
    Object.freeze(entry.profile.authKinds);
    Object.freeze(entry.profile);
    Object.freeze(entry);
  }
  Object.freeze(policy.profiles);
  const sessions = new Map<string, Session>();
  let inFlight = 0;
  let cleanupInFlight = 0;
  let closeAuthorityInFlight = 0;
  const closing = new Map<string, ReturnType<typeof cleanup>>();
  let stopping = false;
  function reserve() {
    if (stopping || inFlight >= policy.maxInFlight)
      throw new RelayFailure("relay_saturated", 503);
    inFlight++;
    let finished = false;
    return () => {
      if (!finished) {
        finished = true;
        inFlight--;
      }
    };
  }
  async function bounded<T>(work: () => Promise<T>) {
    const finish = reserve();
    try {
      return await work();
    } finally {
      finish();
    }
  }
  async function resolve(token: string) {
    const result =
      await input.authorizations.resolveReviewRunAuthorizationToken({ token });
    if (result.status !== "valid")
      throw new RelayFailure("authorization_denied", 401);
    const auth = result.authorization;
    if (!(await input.checkAuthority(auth)))
      throw new RelayFailure("authorization_denied", 401);
    const canonical = auth.runtimeSnapshotCanonicalJson;
    if (
      !canonical ||
      !parseReviewRunRuntimeSnapshot(canonical)?.gateway?.limits
    )
      throw new RelayFailure("gateway_unavailable", 403);
    // SCM/release/safety awaits must not leave an earlier binding check in force.
    const owned = await input.bindings.read({
      authorizationId: auth.authorizationId,
      identity: reviewRunGatewayOwnedIdentity(auth),
      runtimeSnapshotCanonicalJson: canonical,
    });
    if (owned.status !== "live")
      throw new RelayFailure("authorization_denied", 401);
    // Confirm current mutation/release/safety AND auth/deadline only after all
    // SCM/binding awaits. The local protected read does not lock a network call.
    if (!(await input.confirmAuthority(token, auth)))
      throw new RelayFailure("authorization_denied", 401);
    return auth;
  }
  async function check(
    token: string,
    auth: ReviewRunAuthorization,
    session: Session,
  ) {
    const current = await resolve(token);
    if (
      session.closed ||
      stopping ||
      current.authorizationId !== auth.authorizationId ||
      current.runtimeSnapshotCanonicalJson !== session.canonical ||
      canonicalJson(reviewRunGatewayOwnedIdentity(current)) !==
        session.identity ||
      Date.now() >= session.deadline
    )
      throw new RelayFailure("authorization_denied", 401);
  }
  function sessionFor(auth: ReviewRunAuthorization) {
    const canonical = auth.runtimeSnapshotCanonicalJson;
    const snapshot = parseReviewRunRuntimeSnapshot(canonical);
    if (
      !canonical ||
      !snapshot?.gateway?.limits ||
      auth.maxExpiresAt.toISOString() !== snapshot.deadline
    )
      throw new RelayFailure("gateway_unavailable", 403);
    const identity = canonicalJson(reviewRunGatewayOwnedIdentity(auth));
    let session = sessions.get(auth.authorizationId);
    if (session) {
      if (
        session.canonical !== canonical ||
        session.identity !== identity ||
        session.closed
      )
        throw new RelayFailure("authorization_denied", 401);
      return session;
    }
    if (stopping || sessions.size >= policy.maxSessions)
      throw new RelayFailure("relay_saturated", 503);
    const deadline = Date.parse(snapshot.deadline);
    if (Date.now() >= deadline)
      throw new RelayFailure("authorization_denied", 401);
    session = {
      canonical,
      identity,
      deadline,
      closed: false,
      aborts: new Set(),
      preparation: createReviewRunGatewayPreparation({
        authorizationId: auth.authorizationId,
        identity: auth,
        runAccess: input.runAccess,
        authorizations: input.queries,
        snapshots: input.snapshots,
        bindings: input.bindings,
      }),
      timer: setTimeout(
        () => {
          void closeRun(auth.authorizationId, "deadline").catch(() => {});
        },
        Math.min(deadline - Date.now(), 2_147_483_647),
      ),
    };
    session.timer.unref();
    sessions.set(auth.authorizationId, session);
    return session;
  }
  function closeRun(authorizationId: string, reason: c.Close["reason"]) {
    const session = sessions.get(authorizationId);
    if (session) {
      session.closed = true;
      session.closeReason ??= reason;
      reason = session.closeReason;
      clearTimeout(session.timer);
      for (const controller of session.aborts) controller.abort();
    }
    const pending = closing.get(authorizationId);
    if (pending) return pending;
    const work = cleanup(authorizationId, reason, session).finally(() => {
      closing.delete(authorizationId);
    });
    closing.set(authorizationId, work);
    return work;
  }
  async function cleanup(
    authorizationId: string,
    reason: c.Close["reason"],
    session?: Session,
  ) {
    // Existing RR lifecycle commits local denial first. Failure is never "closed".
    await input.authorizations.expireOrRevokeReviewRunAuthorization({
      authorizationId,
      state:
        reason === "deadline"
          ? ReviewRunAuthorizationState.Expired
          : ReviewRunAuthorizationState.Revoked,
    });
    const row =
      await input.queries.findReviewRunAuthorizationById(authorizationId);
    if (row?.state === "active")
      throw new RelayFailure("close_pending", 409, "effect_unknown");
    if (!session) return { state: "unknown" as const };
    // Durable local denial above never waits for a response slot. Remote cleanup
    // has its own bound; saturation retains the denied session for trusted retry.
    if (cleanupInFlight >= policy.maxInFlight)
      throw new RelayFailure("close_pending", 409, "effect_unknown");
    cleanupInFlight++;
    try {
      const operation = await session.preparation.close(reason, {
        signal: AbortSignal.timeout(policy.requestTimeoutMs),
      });
      // Retain unresolved evidence/capability for explicit same-close readback.
      if (operation.state === "applied") sessions.delete(authorizationId);
      return operation;
    } finally {
      cleanupInFlight--;
    }
  }
  async function responses(
    token: string,
    raw: Uint8Array,
    controller: AbortController,
    diagnostic?: RelayDiagnostic,
  ): Promise<NativeResponse> {
    if (raw.byteLength > policy.ingressBytes)
      throw new RelayFailure("invalid_request", 400);
    const bytes = new Uint8Array(raw); // Capture caller-owned bytes before any await.
    const finish = reserve();
    try {
      const auth = await resolve(token);
      const session = sessionFor(auth);
      const snapshot = parseReviewRunRuntimeSnapshot(session.canonical)!;
      const gateway = snapshot.gateway!;
      const configuration = parseReviewConfigurationStrict(
        JSON.parse(snapshot.configurationCanonicalJson),
      );
      const provider = configuration.providers[gateway.providerIndex];
      if (provider?.authMode !== "codex_account_gateway" || !gateway.limits)
        throw new RelayFailure("gateway_unavailable", 403);
      const qualified = policy.profiles.filter(
        (entry) => entry.profile.profileId === gateway.profileRef,
      );
      if (
        qualified.length !== 1 ||
        qualified[0]!.profile.protocol !== "openai-responses" ||
        !qualified[0]!.profile.modelIds.includes(provider.model) ||
        gateway.limits.tokens > qualified[0]!.outputTokens
      )
        throw new RelayFailure("gateway_unavailable", 403);
      if (gateway.limits.outputBytes > 1_048_576)
        throw new RelayFailure("gateway_unavailable", 403);
      const body = responsesBytes(
        bytes,
        provider.model,
        gateway.limits.tokens,
        Math.min(policy.ingressBytes, gateway.limits.requestBytes),
        qualified[0]!.outputTokens,
      );
      const remaining = Math.min(
        policy.requestTimeoutMs,
        session.deadline - Date.now(),
      );
      if (remaining <= 0) throw new RelayFailure("authorization_denied", 401);
      const requestDeadline = Date.now() + remaining;
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(remaining),
      ]);
      session.aborts.add(controller);
      const fresh = () => check(token, auth, session);
      try {
        if (!session.preparation.hasSession()) {
          if (session.preparation.needsRecovery())
            throw new RelayFailure(
              "same_operation_recovery_required",
              409,
              "effect_unknown",
            );
          if (diagnostic) diagnostic.stage = "prepare";
          const prepared = await session.preparation.prepare();
          await fresh();
          if (prepared.status === "denied" || prepared.status === "conflict")
            throw new RelayFailure("preparation_denied", 409);
          if (!session.preparation.hasSession())
            throw new RelayFailure(
              "same_operation_recovery_required",
              409,
              "effect_unknown",
            );
        }
        const waitUntil = Math.min(
          Date.now() + policy.waitBudgetMs,
          requestDeadline,
          session.deadline,
        );
        let waits = 0;
        for (;;) {
          let response: NativeResponse;
          let limited: c.SafeError | undefined;
          const requestRef = `rr-request-${randomUUID()}`;
          try {
            if (diagnostic) diagnostic.stage = "request";
            response = await session.preparation.request(
              requestRef,
              body,
              { signal },
              fresh,
            );
            if (response.kind === "stream") {
              try {
                if (diagnostic) diagnostic.stage = "post_request_authority";
                await fresh();
              } catch {
                await response.cancel().catch(() => {});
                throw new RelayFailure(
                  "authorization_denied",
                  401,
                  "effect_unknown",
                  requestRef,
                );
              }
              const upstream = response;
              if (diagnostic) {
                diagnostic.stage = "stream_reader";
                try {
                  diagnostic.bodyLocked = upstream.body.locked === true;
                } catch {
                  /* Observation only. */
                }
              }
              const reader = upstream.body.getReader();
              const abortStream = () => {
                dispose();
                void upstream.cancel().catch(() => {});
              };
              const dispose = () => {
                signal.removeEventListener("abort", abortStream);
                session.aborts.delete(controller);
                finish();
              };
              signal.addEventListener("abort", abortStream, { once: true });
              if (signal.aborted) {
                abortStream();
                throw new GatewayError(
                  "cancelled",
                  "effect_unknown",
                  undefined,
                  requestRef,
                );
              }
              if (diagnostic) diagnostic.stage = "stream_wrap";
              return {
                ...upstream,
                body: new ReadableStream<Uint8Array>(
                  {
                    async pull(stream) {
                      try {
                        const chunk = await reader.read();
                        await fresh();
                        // SDK cancellation can resolve read() with done=true. That
                        // is transport teardown, not successful terminal delivery.
                        if (signal.aborted)
                          throw new GatewayError(
                            "cancelled",
                            "effect_unknown",
                            undefined,
                            requestRef,
                          );
                        if (chunk.done) {
                          dispose();
                          stream.close();
                        } else stream.enqueue(chunk.value);
                      } catch {
                        controller.abort();
                        dispose();
                        await upstream.cancel().catch(() => {});
                        stream.error(
                          new GatewayError(
                            "transport",
                            "effect_unknown",
                            undefined,
                            requestRef,
                          ),
                        );
                      }
                    },
                    async cancel() {
                      controller.abort();
                      dispose();
                      await upstream.cancel();
                    },
                  },
                  { highWaterMark: 0 },
                ),
                cancel: async () => {
                  controller.abort();
                  dispose();
                  await upstream.cancel();
                },
              };
            }
            try {
              if (diagnostic) diagnostic.stage = "post_request_authority";
              await fresh();
            } catch {
              throw new RelayFailure(
                "authorization_denied",
                401,
                response.status.effect,
                requestRef,
              );
            }
            if (response.status.status === "failed")
              limited = response.status.error;
            if (
              !localLimited(limited) ||
              response.status.effect !== "not_dispatched"
            ) {
              session.aborts.delete(controller);
              finish();
              return response;
            }
          } catch (error) {
            if (
              !(error instanceof GatewayError) ||
              error.code !== "safe_error" ||
              !localLimited(error.diagnostic)
            )
              throw error;
            limited = error.diagnostic;
          }
          // Only a fixed-origin LOCAL admission_limited + not_dispatched attestation.
          // Never upstream_failure/429, partial stream, pending status or ambiguity.
          await fresh();
          if (signal.aborted)
            throw new RelayFailure(
              "admission_limited",
              429,
              "not_dispatched",
              requestRef,
            );
          const milliseconds = Math.max(
            1,
            limited?.retry.kind === "after" ? limited.retry.milliseconds : 1,
          );
          if (
            waits++ >= policy.maxWaits ||
            Date.now() + milliseconds >= waitUntil
          )
            throw new RelayFailure(
              "admission_limited",
              429,
              "not_dispatched",
              requestRef,
            );
          try {
            await delay(milliseconds, undefined, { signal });
          } catch {
            throw new RelayFailure(
              "admission_limited",
              429,
              "not_dispatched",
              requestRef,
            );
          }
          await fresh(); // A new ref is confined to this SAME invocation/attempt.
        }
      } catch (error) {
        session.aborts.delete(controller);
        throw error;
      }
    } catch (error) {
      finish();
      throw error;
    }
  }
  return Object.freeze({
    policy,
    responses,
    closeRun,
    recoverSameOperation: (token: string) =>
      bounded(async () => {
        const auth = await resolve(token);
        const session = sessionFor(auth);
        const result = await session.preparation.recoverSameOperation();
        await check(token, auth, session);
        return result;
      }),
    status: (token: string, requestRef: string) =>
      bounded(async () => {
        const auth = await resolve(token);
        const session = sessionFor(auth);
        if (!session.preparation.hasSession())
          throw new RelayFailure(
            "same_operation_recovery_required",
            409,
            "effect_unknown",
            requestRef,
          );
        return await session.preparation.status(
          requestRef,
          { signal: AbortSignal.timeout(policy.requestTimeoutMs) },
          () => check(token, auth, session),
        );
      }),
    close: async (token: string, reason: c.Close["reason"]) => {
      // Cancellation remains available while Responses is occupied, but its
      // authority preflight must not create unbounded SCM/database work.
      if (closeAuthorityInFlight >= policy.maxInFlight)
        throw new RelayFailure("relay_saturated", 503);
      closeAuthorityInFlight++;
      try {
        const auth = await resolve(token);
        return await closeRun(auth.authorizationId, reason);
      } finally {
        closeAuthorityInFlight--;
      }
    },
    shutdown: async () => {
      stopping = true;
      for (const id of [...sessions.keys()])
        await closeRun(id, "cancelled").catch(() => {});
    },
  });
}
function localLimited(error: c.SafeError | undefined) {
  return (
    error?.code === "admission_limited" &&
    error.effect === "not_dispatched" &&
    error.retry.kind === "after"
  );
}
export type ReviewRunGatewayRelay = ReturnType<
  typeof createReviewRunGatewayRelay
>;
export async function registerReviewRunGatewayRelayRoutes(
  app: FastifyInstance,
  relay: ReviewRunGatewayRelay,
) {
  const activeIngress = new Set<() => void>();
  let stopping = false;
  await app.register(async (scope) => {
    type Reservation = {
      controller: AbortController;
      working: boolean;
      begin: () => void;
      finish: () => void;
    };
    const reservations = new WeakMap<FastifyRequest, Reservation>();
    // Encapsulation retains raw bytes for duplicate-name/UTF-8 validation.
    scope.removeContentTypeParser("application/json");
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer", bodyLimit: relay.policy.ingressBytes },
      (_request, body, done) => done(null, body),
    );
    scope.addHook("onResponse", async (request) => {
      const reservation = reservations.get(request);
      if (reservation && !reservation.working) reservation.finish();
    });
    scope.setErrorHandler((_error, request, reply) => {
      reservations.get(request)?.finish();
      reply
        .code(400)
        .send({ error: { code: "invalid_request", effect: "not_dispatched" } });
    });
    const base = "/api/action/v2/account-gateway";
    scope.post(
      `${base}/responses`,
      {
        bodyLimit: relay.policy.ingressBytes,
        onRequest: async (request, reply) => {
          // Separate from the existing dispatch/status/recovery budget. At most
          // maxInFlight Responses requests may enter the buffer parser, each
          // limited to ingressBytes and requestTimeoutMs to finish reading.
          // Hold the reservation through handler cleanup as well. These are
          // configured ingestion bounds, not measured process-memory caps.
          if (stopping || activeIngress.size >= relay.policy.maxInFlight)
            return reply
              .code(503)
              .header("connection", "close")
              .send({
                error: { code: "relay_saturated", effect: "not_dispatched" },
              });
          const controller = new AbortController();
          let finished = false;
          const cancel = () => {
            controller.abort();
            if (!reservation.working) reservation.finish();
          };
          const stop = () => {
            controller.abort();
            // Terminate the parser's input, not just the outgoing response.
            request.raw.destroy();
            reply.raw.destroy();
            reservation.finish();
          };
          const bodyTimer = setTimeout(stop, relay.policy.requestTimeoutMs);
          const reservation: Reservation = {
            controller,
            working: false,
            begin: () => {
              reservation.working = true;
              clearTimeout(bodyTimer);
            },
            finish: () => {
              if (finished) return;
              finished = true;
              clearTimeout(bodyTimer);
              request.raw.removeListener("aborted", cancel);
              reply.raw.removeListener("close", cancel);
              activeIngress.delete(stop);
            },
          };
          reservations.set(request, reservation);
          activeIngress.add(stop);
          request.raw.once("aborted", cancel);
          reply.raw.once("close", cancel);
          if (request.raw.aborted || reply.raw.destroyed) cancel();
        },
      },
      async (request, reply) => {
        const reservation = reservations.get(request)!;
        reservation.begin();
        const controller = reservation.controller;
        const abort = () => controller.abort();
        // Preserve the existing dispatch/stream timeout after body ingestion.
        const timer = setTimeout(abort, relay.policy.requestTimeoutMs);
        let upstream: NativeResponse | undefined;
        const diagnostic: RelayDiagnostic = {
          stage: "resolve",
          bodyLocked: false,
        };
        try {
          if (controller.signal.aborted || !Buffer.isBuffer(request.body))
            throw new RelayFailure("invalid_request", 400);
          upstream = await relay.responses(
            authorization(request),
            request.body,
            controller,
            diagnostic,
          );
          if (upstream.kind === "status")
            return reply.code(202).send(upstream.status);
          diagnostic.stage = "http_headers";
          try {
            diagnostic.bodyLocked = upstream.body.locked === true;
          } catch {
            /* Observation only. */
          }
          reply.hijack();
          reply.raw.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
            "x-reviewrouter-request-ref": upstream.requestRef,
          });
          const reader = upstream.body.getReader();
          const source = Readable.from(
            (async function* () {
              try {
                for (;;) {
                  const chunk = await reader.read();
                  if (chunk.done) return;
                  yield chunk.value;
                }
              } finally {
                reader.releaseLock();
              }
            })(),
          );
          await pipeline(source, reply.raw, { signal: controller.signal });
        } catch (error) {
          diagnoseUnknown(
            error,
            "responses",
            reply.raw.headersSent,
            diagnostic,
          );
          if (reply.raw.headersSent) reply.raw.destroy();
          else {
            const failure = safeFailure(error);
            reply.code(failure.statusCode).send({
              error: {
                code: failure.code,
                effect: failure.effect,
                ...(failure.requestRef
                  ? { requestRef: failure.requestRef }
                  : {}),
              },
            });
          }
        } finally {
          controller.abort();
          clearTimeout(timer);
          try {
            if (upstream?.kind === "stream")
              await upstream.cancel().catch(() => {});
          } finally {
            reservation.finish();
          }
        }
      },
    );
    scope.get(`${base}/requests/:requestRef`, async (request, reply) => {
      try {
        const { requestRef } = request.params as { requestRef: string };
        return await relay.status(
          authorization(request),
          c.reference.parse(requestRef),
        );
      } catch (error) {
        diagnoseUnknown(error, "status", reply.raw.headersSent);
        const failure = safeFailure(error);
        return reply.code(failure.statusCode).send({
          error: {
            code: failure.code,
            effect: failure.effect,
          },
        });
      }
    });
    scope.post(`${base}/recover`, async (request, reply) => {
      try {
        return await relay.recoverSameOperation(authorization(request));
      } catch (error) {
        diagnoseUnknown(error, "recover", reply.raw.headersSent);
        const failure = safeFailure(error);
        return reply.code(failure.statusCode).send({
          error: {
            code: failure.code,
            effect: failure.effect,
          },
        });
      }
    });
    scope.post(`${base}/close`, async (request, reply) => {
      try {
        const body = Buffer.isBuffer(request.body)
          ? JSON.parse(request.body.toString("utf8"))
          : null;
        const { reason } = z
          .strictObject({
            reason: z.enum(["completed", "cancelled", "failed"]),
          })
          .parse(body);
        return await relay.close(authorization(request), reason);
      } catch (error) {
        diagnoseUnknown(error, "close", reply.raw.headersSent);
        const failure = safeFailure(error);
        return reply.code(failure.statusCode).send({
          error: {
            code: failure.code,
            effect: failure.effect,
          },
        });
      }
    });
  });
  // Cancel before Fastify waits for held response streams to drain.
  app.addHook("preClose", async () => {
    stopping = true;
    for (const stop of activeIngress) stop();
    await relay.shutdown();
  });
}
function authorization(request: FastifyRequest) {
  const header = request.headers.authorization;
  if (
    !header ||
    header.length > 16_384 ||
    !/^Bearer [A-Za-z0-9._~-]+$/.test(header)
  )
    throw new RelayFailure("authorization_denied", 401);
  return header.slice(7);
}
function safeFailure(error: unknown): RelayFailure {
  if (error instanceof RelayFailure) return error;
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return new RelayFailure("invalid_request", 400);
  if (error instanceof GatewayError)
    return new RelayFailure(
      error.code === "safe_error"
        ? (error.diagnostic?.code ?? "gateway_error")
        : error.code,
      error.diagnostic?.code === "admission_limited" &&
        error.effect === "not_dispatched"
        ? 429
        : error.effect === "not_dispatched"
          ? 400
          : 502,
      error.effect,
      error.requestRef,
    );
  return new RelayFailure("relay_unknown", 502, "effect_unknown");
}
function diagnoseUnknown(
  error: unknown,
  route: "responses" | "status" | "recover" | "close",
  headersSent: boolean,
  diagnostic?: RelayDiagnostic,
) {
  try {
    if (safeFailure(error).code !== "relay_unknown") return;
    console.error({
      event: "review_run_gateway_relay_unknown",
      route,
      ...(diagnostic
        ? { stage: diagnostic.stage, bodyLocked: diagnostic.bodyLocked }
        : {}),
      errorCategory:
        error instanceof TypeError
          ? "TypeError"
          : error instanceof RangeError
            ? "RangeError"
            : error instanceof Error
              ? "Error"
              : "other",
      localGatewayErrorInstance: error instanceof GatewayError,
      gatewayConstructorNameBoolean:
        error instanceof Error && error.constructor.name === "GatewayError",
      headersSent,
    });
  } catch {
    /* Diagnostics cannot replace the original failure or cleanup. */
  }
}

/** Decode complete JSON once, retaining user/tool data. Scan BEFORE JSON.parse
 * to reject duplicate decoded keys, critical aliases, deep/unbounded structure. */
function responsesBytes(
  raw: Uint8Array,
  model: string,
  tokens: number,
  maximum: number,
  qualifiedTokens: number,
) {
  try {
    if (raw.byteLength > maximum) throw new Error();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    const critical = new Set([
      "model",
      "stream",
      "store",
      "previous_response_id",
      "service_tier",
      "max_output_tokens",
    ]);
    let at = 0;
    const space = () => {
      while (/[\x20\t\r\n]/.test(text[at] ?? "!")) at++;
    };
    function string(): string {
      const start = at++;
      while (at < text.length) {
        const char = text[at++];
        if (char === "\\") at++;
        else if (char === '"')
          return JSON.parse(text.slice(start, at)) as string;
      }
      throw new Error();
    }
    function value(depth: number): void {
      if (depth > 64) throw new Error();
      space();
      if (text[at] === '"') {
        string();
        return;
      }
      if (text[at] === "{" || text[at] === "[") {
        const object = text[at++] === "{";
        const end = object ? "}" : "]";
        const keys = new Set<string>();
        space();
        if (text[at] === end) {
          at++;
          return;
        }
        for (;;) {
          if (object) {
            space();
            if (text[at] !== '"') throw new Error();
            const key = string();
            const normalized = key.normalize("NFKC").toLowerCase();
            if (
              keys.has(key) ||
              (depth === 0 && critical.has(normalized) && normalized !== key)
            )
              throw new Error();
            keys.add(key);
            space();
            if (text[at++] !== ":") throw new Error();
          }
          value(depth + 1);
          space();
          if (text[at] === end) {
            at++;
            return;
          }
          if (text[at++] !== ",") throw new Error();
        }
      }
      const match =
        /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
          text.slice(at),
        );
      if (!match) throw new Error();
      at += match[0].length;
    }
    value(0);
    space();
    if (at !== text.length) throw new Error();
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error();
    const payload = body as Record<string, unknown>;
    if (
      (payload.model !== undefined && payload.model !== model) ||
      (payload.stream !== undefined && payload.stream !== true) ||
      (payload.store !== undefined && payload.store !== false) ||
      (payload.service_tier !== undefined &&
        payload.service_tier !== "default") ||
      "previous_response_id" in payload
    )
      throw new Error();
    const cap = payload.max_output_tokens;
    if (
      cap !== undefined &&
      (typeof cap !== "number" ||
        !Number.isSafeInteger(cap) ||
        cap < 1 ||
        cap > qualifiedTokens)
    )
      throw new Error();
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        ...payload,
        model,
        stream: true,
        store: false,
        service_tier: "default",
        max_output_tokens:
          typeof cap === "number" ? Math.min(cap, tokens) : tokens,
      }),
    );
    if (bytes.byteLength > maximum) throw new Error();
    return bytes;
  } catch {
    throw new RelayFailure("invalid_request", 400);
  }
}
