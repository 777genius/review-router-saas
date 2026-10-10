import { Buffer } from "node:buffer";
import { z } from "zod";
import * as c from "@agent-teams/account-gateway/contracts";
import {
  createExecutionClient,
  GatewayError,
} from "@agent-teams/account-gateway/http";
import type {
  CallOptions,
  ExecutionClient,
} from "@agent-teams/account-gateway/http";

/** Private API-backend composition only. Never export through a browser/API DTO. */
export interface RunAccessConfig {
  readonly origin: string;
  readonly controlOrigin?: string;
  readonly runControlBearer: string;
  readonly timeoutMs: number;
}
export interface PreparedRunAccess {
  readonly operation: Readonly<c.Operation>;
  readonly admission: Readonly<Omit<c.Admission, "limits">> & {
    readonly limits: Readonly<c.Admission["limits"]>;
  };
  readonly executionRef: string;
  readonly client: ExecutionClient;
}
// The sole additive wire schema is private; SDK contracts remain authoritative.
const bearer = z
  .string()
  .min(16)
  .max(1024)
  .regex(/^[A-Za-z0-9._~-]+$/);
const envelope = z.strictObject({
  operation: c.preparationOperation,
  bearer,
  admission: c.admission,
});
const maximumBytes = 65_536;

async function boundedJSON(response: Response): Promise<unknown> {
  if (!response.body) throw new Error();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) throw new Error();
      chunks.push(value);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks, size),
      ),
    );
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Accepts only a complete, already server-approved intent; performs no admission policy. */
export function createRunAccessClient(settings: RunAccessConfig) {
  let origin: string,
    controlOrigin: string | undefined,
    token: string,
    timeoutMs: number;
  try {
    if (typeof process === "undefined" || !process.versions?.node)
      throw new Error();
    // Capture configured primitives, never the mutable configuration object or CI/request headers.
    const configuredOrigin = settings.origin,
      configuredControlOrigin = settings.controlOrigin;
    token = bearer.parse(settings.runControlBearer);
    timeoutMs = settings.timeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000)
      throw new Error();
    const captureOrigin = (value: string): string => {
      if (
        typeof value !== "string" ||
        !/^https?:\/\/[^/?#@\\\s]+\/?$/.test(value)
      )
        throw new Error();
      // Reject lexical paths too: URL normalization can erase /../.
      const url = new URL(value);
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/" ||
        (url.protocol !== "https:" &&
          !(
            url.protocol === "http:" &&
            ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
          ))
      )
        throw new Error();
      return url.origin;
    };
    origin = captureOrigin(configuredOrigin);
    controlOrigin =
      configuredControlOrigin === undefined
        ? undefined
        : captureOrigin(configuredControlOrigin);
  } catch {
    throw new GatewayError("invalid_input", "not_dispatched");
  }

  async function prepare(
    raw: c.Prepare,
    options: CallOptions = {},
  ): Promise<PreparedRunAccess> {
    let operationId: string | undefined;
    let input: c.Prepare;
    let signal: AbortSignal | undefined;
    let body: string;
    try {
      operationId = c.reference.parse(raw.operationId);
      // SDK parsing copies primitive fields and nested containers before the first await.
      input = c.prepare.parse(raw);
      Object.freeze(input.accountRefs);
      Object.freeze(input.limits);
      Object.freeze(input);
      body = JSON.stringify(input);
      signal = options.signal;
      if (signal !== undefined && !(signal instanceof AbortSignal))
        throw new Error();
    } catch {
      throw new GatewayError("invalid_input", "not_dispatched", operationId);
    }
    if (signal?.aborted)
      throw new GatewayError("cancelled", "not_dispatched", operationId);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    let received = false;
    try {
      const response = await fetch(new URL("/internal/v1/run-access", origin), {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body,
      });
      received = true;
      if (
        response.status !== 200 ||
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
          response.headers.get("content-type") ?? "",
        )
      )
        throw new Error();
      const wire = envelope.parse(await boundedJSON(response));
      const operation = wire.operation;
      if (
        operation.operationRef !== input.operationId ||
        operation.state !== "applied" ||
        operation.result?.kind !== "execution" ||
        operation.result.state !== "active"
      )
        throw new Error();
      const result = operation.result;
      const admission = wire.admission;
      if (
        !input.accountRefs.includes(result.accountRef) ||
        admission.accountRef !== result.accountRef ||
        admission.authorizationEpoch !== result.authorizationEpoch ||
        result.deadline !== input.deadline ||
        admission.expiresAt !== input.deadline ||
        (
          [
            "invocationRef",
            "attemptRef",
            "subjectRef",
            "policyRevision",
            "bindingRevision",
            "profileId",
          ] as const
        ).some((key) => admission[key] !== input[key]) ||
        (Object.keys(input.limits) as (keyof c.Prepare["limits"])[]).some(
          (key) => admission.limits[key] !== input.limits[key],
        )
      )
        throw new Error();
      const dataClient = createExecutionClient({
        role: "execution",
        origin,
        token: wire.bearer,
        timeoutMs,
        responseBytes: maximumBytes,
        bufferBytes: maximumBytes,
      });
      const controlClient =
        controlOrigin === undefined
          ? dataClient
          : createExecutionClient({
              role: "execution",
              origin: controlOrigin,
              token: wire.bearer,
              timeoutMs,
              responseBytes: maximumBytes,
              bufferBytes: maximumBytes,
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
      Object.freeze(result);
      Object.freeze(operation);
      Object.freeze(admission.limits);
      Object.freeze(admission);
      return Object.freeze({
        operation,
        admission,
        executionRef: result.executionRef,
        client,
      });
    } catch {
      // No response body, transport cause, credentials or server diagnostics escape this boundary.
      // Caller owns same-operation recovery. Never retry, replace IDs, or infer non-entry here.
      throw new GatewayError(
        controller.signal.aborted
          ? "cancelled"
          : received
            ? "invalid_response"
            : "transport",
        "effect_unknown",
        operationId,
      );
    } finally {
      controller.abort();
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  return Object.freeze({ prepare });
}
