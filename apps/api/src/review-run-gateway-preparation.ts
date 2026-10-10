import * as c from "@agent-teams/account-gateway/contracts";
import {
  createExecutionClient,
  GatewayError,
  type CallOptions,
  type ExecutionClient,
  type NativeResponse,
} from "@agent-teams/account-gateway/http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  canonicalJson,
  parseReviewRunGatewayExecutionBinding,
  parseReviewRunRuntimeSnapshot,
  reviewRunGatewayOwnedIdentity,
  type ReviewRunAuthorizationQueryPort,
  type ReviewRunGatewayExecutionBinding,
  type ReviewRunGatewayExecutionBindingPort,
  type ReviewRunRuntimeSnapshotPort,
  type VerifiedScmRunIdentity,
} from "@reviewrouter/features-review-run-control";
import type {
  RunAccessConfig,
  PreparedRunAccess,
} from "./account-gateway-run-access";

export type ReviewRunGatewayPreparationResult =
  | { readonly status: "denied" | "conflict" }
  | {
      readonly status: "prepared" | "restored";
      readonly binding: ReviewRunGatewayExecutionBinding;
    };

/** Backend-only composition for ONE already authorized owned run. The caller
 * supplies verified identity, never limits/profile/epoch/operation or credentials.
 * No transport/capability is returned through the safe selected-facts result. */
export function createReviewRunGatewayPreparation(input: {
  readonly authorizationId: string;
  readonly identity: VerifiedScmRunIdentity;
  readonly runAccess: RunAccessConfig;
  readonly authorizations: ReviewRunAuthorizationQueryPort;
  readonly snapshots: ReviewRunRuntimeSnapshotPort;
  readonly bindings: ReviewRunGatewayExecutionBindingPort;
}) {
  const authorizationId = input.authorizationId;
  const identity = reviewRunGatewayOwnedIdentity(input.identity);
  const authorizations = input.authorizations;
  const snapshots = input.snapshots;
  const bindings = input.bindings;
  const prepareAccess = privateRunAccess(input.runAccess);
  let session:
    | {
        readonly client: ExecutionClient;
        readonly admission: c.Admission;
        readonly binding: ReviewRunGatewayExecutionBinding;
        readonly canonical: string;
        attached: boolean;
      }
    | undefined;
  let closed = false;
  let closeReason: c.Close["reason"] | undefined;
  let initialAttempted = false;
  let inFlight = false;
  let pending: Promise<ReviewRunGatewayPreparationResult> | undefined;

  async function run(
    recovery: boolean,
  ): Promise<ReviewRunGatewayPreparationResult> {
    if (inFlight) return { status: "denied" };
    inFlight = true;
    try {
      if (closed) return { status: "denied" };
      const authorization =
        await authorizations.findReviewRunAuthorizationById(authorizationId);
      if (
        !authorization ||
        authorization.state !== "active" ||
        !Object.entries(identity).every(
          ([key, value]) => Reflect.get(authorization, key) === value,
        )
      )
        return { status: "denied" };
      const canonical = authorization.runtimeSnapshotCanonicalJson;
      const snapshot = parseReviewRunRuntimeSnapshot(canonical);
      const original = snapshot?.gateway;
      if (
        !canonical ||
        !snapshot ||
        !original?.limits ||
        authorization.maxExpiresAt.toISOString() !== snapshot.deadline
      )
        return { status: "denied" };
      // The SDK is the authoritative Prepare boundary. Parse/copy the COMPLETE
      // pinned intent before awaiting live authority; never read current policy.
      const intent = c.prepare.parse({
        operationId: original.operationId,
        invocationRef: original.invocationId,
        attemptRef: original.attemptId,
        accountRefs: [original.permittedAccountRef],
        subjectRef: original.policySubject,
        policyRevision: original.policyRevision,
        bindingRevision: original.bindingRevision,
        profileId: original.profileRef,
        limits: { ...original.limits },
        deadline: snapshot.deadline,
      });
      Object.freeze(intent.accountRefs);
      Object.freeze(intent.limits);
      Object.freeze(intent);
      const cutoff = Math.min(
        authorization.expiresAt.getTime(),
        Date.parse(intent.deadline),
      );
      const live = () => Date.now() < cutoff;
      if (!live()) return { status: "denied" };
      const owner = {
        authorizationId,
        identity,
        runtimeSnapshotCanonicalJson: canonical,
      };
      const saved = await bindings.read(owner);
      if (!live() || saved.status !== "live") return { status: "denied" };
      // Ordinary restore is a private SQL read. Reacquiring run access after a
      // lost HTTP/attachment requires the explicit same-operation entry point.
      if (saved.binding && (!recovery || session?.attached))
        return { status: "restored", binding: saved.binding };
      if (!recovery && initialAttempted) return { status: "denied" };
      if (
        !(await snapshots.isLive({ snapshot, identity, now: new Date() })) ||
        !live()
      )
        return { status: "denied" };
      const remaining = cutoff - Date.now();
      if (remaining <= 0) return { status: "denied" };
      initialAttempted = true;
      // One no-retry HTTP call. Unknown/pending/lost responses throw the existing
      // sanitized GatewayError; this function never infers a replacement intent.
      const prepared = await prepareAccess(intent, {
        signal: AbortSignal.timeout(Math.min(remaining, 2_147_483_647)),
      });
      const operation = c.preparationOperation.parse(prepared.operation);
      if (
        operation.state !== "applied" ||
        operation.result?.kind !== "execution" ||
        operation.operationRef !== intent.operationId ||
        operation.result.state !== "active"
      )
        throw new Error("review_run_gateway_result_invalid");
      const selected = operation.result;
      const admission = c.admission.parse(prepared.admission);
      const expectedAdmission = c.admission.parse({
        invocationRef: intent.invocationRef,
        attemptRef: intent.attemptRef,
        accountRef: selected.accountRef,
        authorizationEpoch: selected.authorizationEpoch,
        subjectRef: intent.subjectRef,
        policyRevision: intent.policyRevision,
        bindingRevision: intent.bindingRevision,
        profileId: intent.profileId,
        limits: { ...intent.limits },
        expiresAt: intent.deadline,
      });
      if (
        selected.accountRef !== original.permittedAccountRef ||
        selected.deadline !== intent.deadline ||
        prepared.executionRef !== selected.executionRef ||
        canonicalJson(admission) !== canonicalJson(expectedAdmission)
      )
        throw new Error("review_run_gateway_result_invalid");
      const binding = parseReviewRunGatewayExecutionBinding(
        canonicalJson({
          bindingVersion: 1,
          operationId: intent.operationId,
          executionRef: selected.executionRef,
          accountRef: selected.accountRef,
          authorizationEpoch: selected.authorizationEpoch,
          deadline: intent.deadline,
        }),
      );
      if (
        saved.binding &&
        canonicalJson(saved.binding) !== canonicalJson(binding)
      )
        return { status: "conflict" };
      // Retain the validated capability for exact cleanup even if attachment or
      // authority is lost. It cannot dispatch until the SQL attachment succeeds.
      session = {
        client: prepared.client,
        admission,
        binding,
        canonical,
        attached: false,
      };
      if (!live() || closed) return { status: "denied" };
      // ExecutionClient and the control credential remain inside backend closures;
      // only this safe projection enters SQL. Attachment loss is caller-recovered.
      const attached = await bindings.attach(owner, binding);
      if (!live() || closed) return { status: "denied" };
      if (attached.status === "attached" || attached.status === "restored") {
        session.attached = true;
        return {
          status: attached.status === "attached" ? "prepared" : "restored",
          binding: attached.binding,
        };
      }
      return { status: attached.status };
    } finally {
      inFlight = false;
    }
  }
  async function currentSession() {
    const current = session;
    if (!current?.attached || closed)
      throw new GatewayError("invalid_input", "not_dispatched");
    const saved = await bindings.read({
      authorizationId,
      identity,
      runtimeSnapshotCanonicalJson: current.canonical,
    });
    // The actual locked original-binding check is followed by a current row read.
    const authorization =
      await authorizations.findReviewRunAuthorizationById(authorizationId);
    if (
      closed ||
      session !== current ||
      saved.status !== "live" ||
      !saved.binding ||
      canonicalJson(saved.binding) !== canonicalJson(current.binding) ||
      !authorization ||
      authorization.state !== "active" ||
      authorization.runtimeSnapshotCanonicalJson !== current.canonical ||
      !Object.entries(identity).every(
        ([key, value]) => Reflect.get(authorization, key) === value,
      ) ||
      Date.now() >=
        Math.min(
          authorization.expiresAt.getTime(),
          Date.parse(current.binding.deadline),
        )
    )
      throw new GatewayError("invalid_input", "not_dispatched");
    return current;
  }
  function begin(recovery: boolean) {
    // Repeated calls cannot replace the handle observed by close().
    if (inFlight)
      return Promise.resolve<ReviewRunGatewayPreparationResult>({
        status: "denied",
      });
    pending = run(recovery);
    return pending;
  }
  return Object.freeze({
    prepare: () => begin(false),
    recoverSameOperation: () => begin(true),
    // Private backend capabilities, never part of the preparation result/SQL DTO.
    hasSession: () => session?.attached === true && !closed,
    needsRecovery: () => initialAttempted && !session?.attached,
    request: async (
      requestRef: string,
      bytes: Uint8Array,
      options: CallOptions = {},
      check: () => Promise<void> = async () => {},
    ): Promise<NativeResponse> => {
      const body = new Uint8Array(bytes);
      const requestId = c.reference.parse(requestRef);
      const current = await currentSession();
      await check();
      if (
        closed ||
        session !== current ||
        options.signal?.aborted ||
        Date.now() >= Date.parse(current.binding.deadline)
      )
        throw new GatewayError(
          "cancelled",
          "not_dispatched",
          undefined,
          requestId,
        );
      return current.client.request(
        current.binding.executionRef,
        { requestId, admission: current.admission, body },
        options,
      );
    },
    status: async (
      requestRef: string,
      options: CallOptions = {},
      check: () => Promise<void> = async () => {},
    ) => {
      // Readback is safe after local denial/close as well: exact saved capability,
      // never another permission. The HTTP relay still requires current RR auth.
      const requestId = c.reference.parse(requestRef);
      const current = session;
      if (!current)
        throw new GatewayError(
          "invalid_response",
          "effect_unknown",
          undefined,
          requestId,
        );
      await check();
      const status = await current.client.status(
        current.binding.executionRef,
        requestId,
        options,
      );
      try {
        await check();
      } catch {
        throw new GatewayError(
          "invalid_response",
          "effect_unknown",
          undefined,
          requestId,
        );
      }
      return status;
    },
    close: async (reason: c.Close["reason"], options: CallOptions = {}) => {
      closed = true; // Deny first, including in-flight preparation/dispatch.
      const firstReason = (closeReason ??= reason); // Stable ID retains first intent.
      await pending?.catch(() => {});
      const current = session;
      if (!current) return { state: "unknown" as const };
      return current.client.close(
        current.binding.executionRef,
        {
          operationId: `rr-close-${createHash("sha256").update(current.binding.operationId).digest("hex")}`,
          reason: firstReason,
        },
        options,
      );
    },
  });
}

/** The old run-access adapter fixes bufferBytes at 64KiB. This private handshake
 * uses the SAME v1 schemas/envelope, configuring the existing SDK at the saved
 * approved output cap. SDK max is 1MiB: larger policies deny before preparation.
 * No control token or execution bearer leaves these closures. */
function privateRunAccess(config: RunAccessConfig) {
  const token = z
    .string()
    .min(16)
    .max(1024)
    .regex(/^[A-Za-z0-9._~-]+$/)
    .parse(config.runControlBearer);
  const timeoutMs = z
    .number()
    .int()
    .min(1)
    .max(3_600_000)
    .parse(config.timeoutMs);
  const captureOrigin = (value: string): URL => {
    if (
      typeof value !== "string" ||
      !/^https?:\/\/[^/?#@\\\s]+\/?$/.test(value)
    )
      throw new Error("review_run_gateway_config_invalid");
    const origin = new URL(value);
    if (
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      (origin.protocol !== "https:" &&
        !(
          origin.protocol === "http:" &&
          ["127.0.0.1", "[::1]", "localhost"].includes(origin.hostname)
        ))
    )
      throw new Error("review_run_gateway_config_invalid");
    return origin;
  };
  const origin = captureOrigin(config.origin);
  const configuredControlOrigin = config.controlOrigin;
  const controlOrigin =
    configuredControlOrigin === undefined
      ? undefined
      : captureOrigin(configuredControlOrigin).origin;
  const envelope = z.strictObject({
    operation: c.preparationOperation,
    bearer: z
      .string()
      .min(16)
      .max(1024)
      .regex(/^[A-Za-z0-9._~-]+$/),
    admission: c.admission,
  });
  return async (
    intent: c.Prepare,
    options: CallOptions,
  ): Promise<PreparedRunAccess> => {
    if (intent.limits.outputBytes > 1_048_576)
      throw new GatewayError(
        "invalid_input",
        "not_dispatched",
        intent.operationId,
      );
    if (options.signal?.aborted)
      throw new GatewayError("cancelled", "not_dispatched", intent.operationId);
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const raw = await new Promise<unknown>((resolve, reject) => {
        const url = new URL("/internal/v1/run-access", origin);
        const request = (
          url.protocol === "https:" ? httpsRequest : httpRequest
        )(
          url,
          {
            method: "POST",
            agent: false,
            signal,
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              accept: "application/json",
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            let size = 0;
            response.once("close", () => {
              if (!response.complete) reject(new Error());
            });
            response.on("error", reject);
            response.on("aborted", () => reject(new Error()));
            response.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > 65_536) {
                response.destroy();
                reject(new Error());
              } else chunks.push(chunk);
            });
            response.on("end", () => {
              try {
                if (
                  response.statusCode !== 200 ||
                  !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
                    response.headers["content-type"] ?? "",
                  )
                )
                  throw new Error();
                resolve(
                  JSON.parse(
                    new TextDecoder("utf-8", { fatal: true }).decode(
                      Buffer.concat(chunks, size),
                    ),
                  ),
                );
              } catch {
                reject(new Error());
              }
            });
          },
        );
        request.on("error", reject);
        request.end(JSON.stringify(intent));
      });
      const wire = envelope.parse(raw);
      const dataClient = createExecutionClient({
        role: "execution",
        origin: origin.origin,
        token: wire.bearer,
        timeoutMs,
        responseBytes: 65_536,
        bufferBytes: Math.max(1024, intent.limits.outputBytes),
      });
      const controlClient =
        controlOrigin === undefined
          ? dataClient
          : createExecutionClient({
              role: "execution",
              origin: controlOrigin,
              token: wire.bearer,
              timeoutMs,
              responseBytes: 65_536,
              bufferBytes: Math.max(1024, intent.limits.outputBytes),
            });
      const client: ExecutionClient =
        controlOrigin === undefined
          ? dataClient
          : Object.freeze({
              request: dataClient.request,
              status: controlClient.status,
              close: controlClient.close,
              operation: controlClient.operation,
            });
      // The full tuple/selected result is checked by run() before attachment/use.
      return Object.freeze({
        operation: wire.operation,
        admission: wire.admission,
        executionRef:
          wire.operation.state === "applied" &&
          wire.operation.result?.kind === "execution"
            ? wire.operation.result.executionRef
            : "invalid",
        client,
      });
    } catch {
      throw new GatewayError(
        signal.aborted ? "cancelled" : "invalid_response",
        "effect_unknown",
        intent.operationId,
      );
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
}
