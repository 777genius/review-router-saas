import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { afterEach, expect, it } from "vitest";
import type * as c from "@agent-teams/account-gateway/contracts";
import { GatewayError } from "@agent-teams/account-gateway/http";
import { createRunAccessClient } from "./account-gateway-run-access.js";

const control = "disposable-control-token",
  execution = "disposable-execution-token";
const intent = (): c.Prepare => ({
  operationId: "prepare-1",
  invocationRef: "invocation-1",
  attemptRef: "attempt-1",
  accountRefs: ["account-1", "account-2"],
  subjectRef: "binding-1",
  policyRevision: 7,
  bindingRevision: 9,
  profileId: "profile-1",
  limits: {
    requests: 3,
    requestBytes: 8192,
    outputBytes: 16384,
    tokens: 256,
    concurrency: 2,
  },
  deadline: "2027-01-01T00:00:00.000Z",
});
const wire = () => ({
  operation: {
    operationRef: "prepare-1",
    state: "applied",
    result: {
      kind: "execution",
      executionRef: "execution-1",
      accountRef: "account-2",
      authorizationEpoch: 12,
      deadline: intent().deadline,
      state: "active",
    },
  },
  bearer: execution,
  admission: {
    invocationRef: "invocation-1",
    attemptRef: "attempt-1",
    accountRef: "account-2",
    authorizationEpoch: 12,
    subjectRef: "binding-1",
    policyRevision: 7,
    bindingRevision: 9,
    profileId: "profile-1",
    limits: {
      requests: 3,
      requestBytes: 8192,
      outputBytes: 16384,
      tokens: 256,
      concurrency: 2,
    },
    expiresAt: intent().deadline,
  },
});
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
type Handler = (req: IncomingMessage, res: ServerResponse) => void;
async function peer(handler?: Handler, timeoutMs = 1000) {
  const calls: {
    method: string;
    path: string;
    authorization: string;
    body: unknown;
  }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    calls.push({
      method: req.method ?? "",
      path: req.url ?? "",
      authorization: req.headers.authorization ?? "",
      body: body ? JSON.parse(body) : undefined,
    });
    if (handler) {
      handler(req, res);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.method === "POST" ? wire() : wire().operation));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const config = {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    runControlBearer: control,
    timeoutMs,
  };
  return { calls, config, client: createRunAccessClient(config) };
}
async function unknownFailure(
  task: Promise<unknown>,
  code = "invalid_response",
) {
  const error: unknown = await task.catch((value) => value);
  expect(error).toBeInstanceOf(GatewayError);
  expect(error).toMatchObject({
    code,
    effect: "effect_unknown",
    operationRef: "prepare-1",
  });
  expect(inspect(error)).not.toContain(control);
  expect(inspect(error)).not.toContain(execution);
  expect(JSON.stringify(error)).not.toContain(execution);
}

// Bug made red: capturing caller/config objects across await can change authority;
// returning the private envelope leaks the bearer instead of closing it in the SDK.
it("posts exactly the captured prepare and returns a safe projection plus the working SDK client", async () => {
  const h = await peer();
  const input = intent();
  const pending = h.client.prepare(input);
  input.accountRefs.length = 0;
  input.limits.tokens = 999;
  input.subjectRef = "changed";
  input.deadline = "2028-01-01T00:00:00.000Z";
  input.operationId = "changed";
  h.config.origin = "https://unreachable.invalid";
  h.config.runControlBearer = "changed";
  const prepared = await pending;
  expect(h.calls).toEqual([
    {
      method: "POST",
      path: "/internal/v1/run-access",
      authorization: `Bearer ${control}`,
      body: intent(),
    },
  ]);
  expect(prepared.operation).toEqual(wire().operation);
  expect(prepared.admission).toEqual(wire().admission);
  expect(prepared.executionRef).toBe("execution-1");
  expect(JSON.stringify(prepared)).not.toContain(execution);
  expect(inspect(prepared)).not.toContain(execution);
  expect(inspect(prepared)).not.toContain(control);
  expect(Object.isFrozen(prepared.admission.limits)).toBe(true);
  expect(await prepared.client.operation("prepare-1")).toEqual(
    wire().operation,
  );
  expect(h.calls[1]).toMatchObject({
    method: "GET",
    path: "/v1/operations/prepare-1",
    authorization: `Bearer ${execution}`,
  });
  expect(h.calls.filter((call) => call.method === "POST")).toHaveLength(1);
});

// Bug made red: data saturation strands close/readback if the prepared client
// keeps using data ingress, or a changed config/fallback redirects authority.
it("captures protected control routing while prepare and request remain on data", async () => {
  const status = {
    requestRef: "request-1",
    effect: "completed",
    status: "completed",
  };
  const data = await peer((req, res) => {
    res.writeHead(req.url === "/internal/v1/run-access" ? 200 : 202, {
      "content-type": "application/json",
    });
    res.end(
      JSON.stringify(req.url === "/internal/v1/run-access" ? wire() : status),
    );
  });
  const protectedControl = await peer((req, res) => {
    if (req.method === "POST") {
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        req.url?.includes("/requests/") ? status : wire().operation,
      ),
    );
  });
  const settings = {
    ...data.config,
    controlOrigin: protectedControl.config.origin,
  };
  const client = createRunAccessClient(settings);
  settings.controlOrigin = data.config.origin;
  const prepared = await client.prepare(intent());
  expect(
    await prepared.client.request(prepared.executionRef, {
      requestId: "request-1",
      admission: prepared.admission,
      body: new TextEncoder().encode("{}"),
    }),
  ).toMatchObject({ kind: "status", status });
  expect(
    await prepared.client.status(prepared.executionRef, "request-1"),
  ).toEqual(status);
  expect(await prepared.client.operation("prepare-1")).toEqual(
    wire().operation,
  );
  await expect(
    prepared.client.close(prepared.executionRef, {
      operationId: "close-1",
      reason: "cancelled",
    }),
  ).rejects.toMatchObject({
    effect: "effect_unknown",
    operationRef: "close-1",
  });
  expect(
    data.calls.map((call) => [call.method, call.path, call.authorization]),
  ).toEqual([
    ["POST", "/internal/v1/run-access", `Bearer ${control}`],
    ["POST", "/v1/executions/execution-1/requests", `Bearer ${execution}`],
  ]);
  expect(
    protectedControl.calls.map((call) => [
      call.method,
      call.path,
      call.authorization,
    ]),
  ).toEqual([
    [
      "GET",
      "/v1/executions/execution-1/requests/request-1",
      `Bearer ${execution}`,
    ],
    ["GET", "/v1/operations/prepare-1", `Bearer ${execution}`],
    ["POST", "/v1/executions/execution-1/close", `Bearer ${execution}`],
  ]);
  expect(protectedControl.calls[2]?.body).toEqual({
    operationId: "close-1",
    reason: "cancelled",
  });
  expect(JSON.stringify(prepared)).not.toContain(execution);
});

// Bug made red: trusting a valid DTO without binding it to the SAME original
// intent/operation accepts another account, stale epoch, enlarged caps or expiry.
const changes: [string, (value: ReturnType<typeof wire>) => unknown][] = [
  ["extra private envelope key", (value) => ({ ...value, debug: execution })],
  [
    "missing bearer",
    (value) => ({ operation: value.operation, admission: value.admission }),
  ],
  [
    "header injection bearer",
    (value) => ({ ...value, bearer: execution + "\r\nX-Test: yes" }),
  ],
  [
    "operation ID",
    (value) => {
      value.operation.operationRef = "other";
      return value;
    },
  ],
  [
    "pending",
    (value) => ({
      ...value,
      operation: { operationRef: "prepare-1", state: "pending" },
    }),
  ],
  [
    "missing execution result",
    (value) => ({
      ...value,
      operation: { operationRef: "prepare-1", state: "applied" },
    }),
  ],
  [
    "account result kind",
    (value) => ({
      ...value,
      operation: {
        operationRef: "prepare-1",
        state: "applied",
        result: {
          kind: "account",
          accountRef: "account-2",
          metadataRevision: 1,
          authorizationEpoch: 12,
        },
      },
    }),
  ],
  [
    "inactive execution",
    (value) => {
      value.operation.result.state = "fenced";
      return value;
    },
  ],
  [
    "unapproved account",
    (value) => {
      value.operation.result.accountRef = value.admission.accountRef = "other";
      return value;
    },
  ],
  [
    "different account",
    (value) => {
      value.admission.accountRef = "account-1";
      return value;
    },
  ],
  [
    "different epoch",
    (value) => {
      value.admission.authorizationEpoch++;
      return value;
    },
  ],
  [
    "operation deadline",
    (value) => {
      value.operation.result.deadline = "2028-01-01T00:00:00.000Z";
      return value;
    },
  ],
  [
    "admission expiry",
    (value) => {
      value.admission.expiresAt = "2028-01-01T00:00:00.000Z";
      return value;
    },
  ],
  [
    "private issuer",
    (value) => ({
      ...value,
      admission: { ...value.admission, issuerEpoch: "private" },
    }),
  ],
  [
    "private execution reference",
    (value) => ({
      ...value,
      admission: { ...value.admission, executionRef: "private" },
    }),
  ],
];
for (const key of [
  "invocationRef",
  "attemptRef",
  "subjectRef",
  "profileId",
] as const)
  changes.push([
    key,
    (value) => {
      value.admission[key] = "other";
      return value;
    },
  ]);
for (const key of ["policyRevision", "bindingRevision"] as const)
  changes.push([
    key,
    (value) => {
      value.admission[key]++;
      return value;
    },
  ]);
for (const key of [
  "requests",
  "requestBytes",
  "outputBytes",
  "tokens",
  "concurrency",
] as const)
  changes.push([
    key,
    (value) => {
      value.admission.limits[key]++;
      return value;
    },
  ]);
it.each(changes)(
  "denies mismatched %s without replay or credential diagnostics",
  async (_name, change) => {
    const h = await peer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(change(wire())));
    });
    await unknownFailure(h.client.prepare(intent()));
    expect(h.calls).toHaveLength(1);
  },
);

// Bug made red: automatic redirects forward server authority; unbounded reads
// or permissive status/MIME acceptance turn attacker responses into run access.
it.each([
  "redirect",
  "wrong-status",
  "wrong-type",
  "invalid-json",
  "invalid-utf8",
  "oversize",
] as const)("denies %s at the private envelope boundary", async (mode) => {
  const h = await peer((_req, res) => {
    res.writeHead(
      mode === "redirect" ? 307 : mode === "wrong-status" ? 201 : 200,
      {
        "content-type":
          mode === "wrong-type" ? "text/plain" : "application/json",
        location: "/credential-sink",
      },
    );
    res.end(
      mode === "oversize"
        ? " ".repeat(65_537)
        : mode === "invalid-json"
          ? execution
          : mode === "invalid-utf8"
            ? Buffer.from([0xff])
            : JSON.stringify(wire()),
    );
  });
  await unknownFailure(h.client.prepare(intent()));
  expect(h.calls).toHaveLength(1);
});

// Bug made red: normalized /../, URL credentials or invalid local input can
// dispatch despite preflight failure, or cancellation can lose the operation ID.
it("rejects preflight and already aborted intents without any HTTP dispatch", async () => {
  const h = await peer();
  const controller = new AbortController();
  controller.abort();
  await expect(
    h.client.prepare(intent(), { signal: controller.signal }),
  ).rejects.toMatchObject({
    code: "cancelled",
    effect: "not_dispatched",
    operationRef: "prepare-1",
  });
  await expect(
    h.client.prepare({
      ...intent(),
      limits: { ...intent().limits, tokens: 0 },
    }),
  ).rejects.toMatchObject({
    code: "invalid_input",
    effect: "not_dispatched",
    operationRef: "prepare-1",
  });
  for (const origin of [
    h.config.origin + "/..",
    h.config.origin + "?x=1",
    h.config.origin + "#x",
    h.config.origin.replace("://", `://${control}@`),
    "http://example.invalid",
  ]) {
    expect(() => createRunAccessClient({ ...h.config, origin })).toThrow(
      GatewayError,
    );
    expect(() =>
      createRunAccessClient({ ...h.config, controlOrigin: origin }),
    ).toThrow(GatewayError);
  }
  for (const timeoutMs of [0, Infinity, NaN, 1.5])
    expect(() => createRunAccessClient({ ...h.config, timeoutMs })).toThrow(
      GatewayError,
    );
  expect(h.calls).toHaveLength(0);
});

// Bug made red: a dropped ACK, post-dispatch abort or stalled response is
// reported as safe-to-retry, silently replayed, or stripped of its stable ID.
it.each(["lost-ack", "abort", "timeout"] as const)(
  "preserves unknown once after %s",
  async (mode) => {
    const controller = new AbortController();
    const h = await peer((req, res) => {
      if (mode === "lost-ack") {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
      if (mode === "abort") controller.abort();
    }, 100);
    await unknownFailure(
      h.client.prepare(intent(), { signal: controller.signal }),
      mode === "lost-ack" ? "transport" : "cancelled",
    );
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.body).toEqual(intent());
  },
);
