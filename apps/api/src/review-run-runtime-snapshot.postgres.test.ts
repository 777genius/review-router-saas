import { describe, expect, it } from "vitest";
import { once } from "node:events";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
} from "node:http";
import Fastify from "fastify";
import type { AddressInfo } from "node:net";
import type * as Gateway from "@agent-teams/account-gateway/contracts";
import { createPrismaClient } from "@reviewrouter/platform-db";
import { PrismaProviderAccountRepository } from "@reviewrouter/features-provider-accounts";
import {
  mapConfigToRuntimeEnv,
  parseReviewConfigurationStrict,
  PrismaReviewConfigurationRepository,
  saveReviewConfiguration,
  safeDefaultReviewConfiguration,
} from "@reviewrouter/features-review-config";
import {
  ManageReviewRunAuthorizations,
  canonicalJson,
  parseReviewRunRuntimeSnapshot,
  ReviewRunAuthorizationState,
  ReviewRunAuthorizationUseCaseStatus,
  ReviewMutationLaneKind,
  ReviewMutationMode,
  type ReviewRunAuthorization,
  type ReviewRunRuntimeSnapshotPort,
} from "@reviewrouter/features-review-run-control";
import { createReviewActionV2E2EHarness } from "../../../scripts/review-action-v2-production-e2e/support/review-action-v2-e2e-harness";
import {
  composeReviewActionV2ProductionRunControl,
  composeReviewActionV2ProductionRoutes,
} from "./review-action-v2-production-composition";
import {
  createReviewRunGatewayRelay,
  registerReviewRunGatewayRelayRoutes,
  type ReviewRunGatewayRelay,
} from "./review-run-gateway-relay";
import { registerReviewRunGatewayCheckoutRoute } from "./review-run-gateway-checkout";
import { createReviewRunGatewayPreparation } from "./review-run-gateway-preparation";
import { PrismaReviewRunGatewayExecutionBinding } from "./prisma-review-run-gateway-execution-binding";
import {
  ProductionReviewRunRuntimeSnapshot,
  reviewRunGatewayPreparationIdentity,
} from "./review-run-runtime-snapshot";

// Pure loopback HTTP; no PostgreSQL, authority admission or provider traffic.
// RED before the fix: the third incomplete upload reaches preParsing rather
// than receiving relay_saturated, despite two occupied ingestion slots.
it("bounds incomplete Responses bodies and recovers ingress slots", async () => {
  let forbiddenWork = 0;
  const unused = async (): Promise<never> => {
    forbiddenWork++;
    throw new Error("ingress_test_must_not_reach_authority_or_gateway");
  };
  const relay = createReviewRunGatewayRelay({
    policy: {
      profiles: [
        {
          profile: {
            profileId: "fixture-profile",
            protocol: "openai-responses",
            modelIds: ["fixture-model"],
            authKinds: ["api_key"],
          },
          outputTokens: 128,
        },
      ],
      ingressBytes: 2048,
      requestTimeoutMs: 2000,
      waitBudgetMs: 0,
      maxWaits: 0,
      maxSessions: 1,
      maxInFlight: 2,
    },
    runAccess: {
      origin: "http://127.0.0.1:1",
      runControlBearer: "unused",
      timeoutMs: 2000,
    },
    authorizations: {
      resolveReviewRunAuthorizationToken: unused,
      expireOrRevokeReviewRunAuthorization: unused,
    },
    queries: { findReviewRunAuthorizationById: unused },
    checkAuthority: unused,
    confirmAuthority: unused,
    snapshots: { capture: unused, isLive: unused },
    bindings: { read: unused, attach: unused },
  });
  const app = Fastify();
  const parsing = new Map<string, (raw: IncomingMessage) => void>();
  app.addHook("preParsing", async (request, _reply, payload) => {
    parsing.get(request.raw.url!)?.(request.raw);
    return payload;
  });
  await registerReviewRunGatewayRelayRoutes(app, relay);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = app.server.address() as AddressInfo;
  const clients: ReturnType<typeof httpRequest>[] = [];
  const upload = (name: string, completeBody?: string) => {
    const path = `/api/action/v2/account-gateway/responses?${name}`;
    const parsed = new Promise<IncomingMessage>((resolve) =>
      parsing.set(path, resolve),
    );
    let client!: ReturnType<typeof httpRequest>;
    const response = new Promise<{ status: number; body: string } | undefined>(
      (resolve) => {
        client = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path,
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(completeBody === undefined
                ? {}
                : { "content-length": Buffer.byteLength(completeBody) }),
            },
          },
          (reply) => {
            let body = "";
            reply.setEncoding("utf8");
            reply.on("data", (chunk: string) => {
              body += chunk;
            });
            reply.on("end", () => resolve({ status: reply.statusCode!, body }));
            reply.on("error", () => resolve(undefined));
          },
        );
        client.on("error", () => resolve(undefined));
      },
    );
    clients.push(client);
    if (completeBody === undefined)
      client.write('{"input":"' + "x".repeat(1024));
    else client.end(completeBody);
    return { client, parsed, response };
  };
  const saturated = async (name: string) => {
    const excess = upload(name);
    const result = await Promise.race([
      excess.response,
      excess.parsed.then(() => "entered_parser"),
    ]);
    expect(result).toEqual({
      status: 503,
      body: JSON.stringify({
        error: { code: "relay_saturated", effect: "not_dispatched" },
      }),
    });
    excess.client.destroy();
  };
  try {
    const first = upload("first");
    const second = upload("second");
    const [firstRaw, secondRaw] = await Promise.all([
      first.parsed,
      second.parsed,
    ]);
    const timedOut = once(secondRaw, "aborted");
    await saturated("excess");
    // Ingestion leaves status and cancellation routes outside its budget.
    for (const url of [
      "/api/action/v2/account-gateway/requests/fixture-request",
      "/api/action/v2/account-gateway/close",
    ]) {
      const response = await app.inject({
        method: url.endsWith("close") ? "POST" : "GET",
        url,
        ...(url.endsWith("close")
          ? {
              headers: { "content-type": "application/json" },
              payload: '{"reason":"cancelled"}',
            }
          : {}),
      });
      expect(response.statusCode).toBe(401);
    }
    const disconnected = once(firstRaw, "aborted");
    first.client.destroy();
    await disconnected;
    const replacement = upload("replacement");
    const replacementRaw = await replacement.parsed;
    await saturated("still-full");
    const replacementDisconnected = once(replacementRaw, "aborted");
    replacement.client.destroy();
    await replacementDisconnected;
    expect((await upload("too-large", "x".repeat(2049)).response)?.status).toBe(
      400,
    );
    // The other slot is still occupied: both parser errors and normal handler
    // errors must release, without double-freeing the remaining reservation.
    expect((await upload("normal-error", "{}").response)?.status).toBe(401);
    await timedOut;
    expect(await second.response).toBeUndefined();
    const recovered = upload("after-timeout");
    const recoveredSecond = upload("after-timeout-second");
    await Promise.all([recovered.parsed, recoveredSecond.parsed]);
    await saturated("full-again");
    expect(forbiddenWork).toBe(0);
    // preClose must terminate incomplete bodies without waiting for their timers.
    await app.close();
    expect(await recovered.response).toBeUndefined();
    expect(await recoveredSecond.response).toBeUndefined();
  } finally {
    for (const client of clients) client.destroy();
    await app.close();
  }
});

const enabled = process.env.RR_C2C_PG_TEST === "1";
function disposableDatabase(): string {
  const raw = process.env.RR_C2C_PG_TEST_URL ?? "";
  const url = new URL(raw);
  if (
    process.env.RR_C2C_MIGRATED_DISPOSABLE_DATABASE !== "1" ||
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !/^rr_gateway_test_c2c_[a-z0-9_]+$/.test(url.pathname.slice(1)) ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "c2c_explicit_migrated_disposable_loopback_database_required",
    );
  }
  return raw;
}

// Regressions named before the test: first-admission winner + immutable settings;
// strict stored provider rows cannot be silently deduplicated at admission;
// settings switching to another live binding cannot replace or un-revoke the original;
// settings/binding races fenced at INSERT; original revoke/foreign owner denial;
// a live original-binding read that crosses the original deadline still denies;
// ordinary TTL renewal to version 2 must preserve the version-1 creation event;
// authority reads crossing the token TTL or original maximum must deny;
// negotiation/new-token/new-ID cannot produce another admitted allowance identity.
// Selected-result loss must recover the same intent and attach once, without a bearer in SQL.
// Relay regressions: an ordinary retry could bypass LOCAL-only wait, lost process
// capabilities could automatically reprepare, caller model/duplicate keys could
// override the pin, or the old per-chunk 64KiB bound could reject approved SSE.
// A stream failure must never create another request; cancelled held SSE must
// not become clean EOF when SDK teardown resolves read(done=true).
// Exact close must deny new calls.
// P45: pause during delayed SCM, or epoch advance during a locked binding read,
// must deny before SDK dispatch. Held status/recovery must consume the same slot
// as Responses; excess calls must not reach SCM, run-access or status HTTP.
// Checkout: a read-only issuer result that returns after installation revocation
// must never reach CI, and unknown caller authority fields must not mint.
// This is real RR PostgreSQL + synthetic OIDC/SCM + controlled Gateway HTTP, no inference.
describe.skipIf(!enabled)("C2c actual first-admission runtime pin", () => {
  it("retains one original across competing admissions, settings and revocation", async () => {
    const databaseUrl = disposableDatabase();
    const limits = {
      requests: 2,
      concurrency: 1,
      requestBytes: 4096,
      outputBytes: 196608,
      tokens: 128,
    };
    const networkFetch = globalThis.fetch;
    const gate = () => {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { pending, release };
    };
    let holdScm: (() => Promise<void>) | undefined;
    let scmReads = 0;
    const harness = await createReviewActionV2E2EHarness(databaseUrl, {
      beforeFakeGitHubRead: async () => {
        scmReads++;
        const hold = holdScm;
        holdScm = undefined;
        await hold?.();
      },
      environmentOverrides: {
        REVIEW_ROUTER_ACCOUNT_GATEWAY_POLICY: JSON.stringify({
          profiles: [{ profileRef: "mimo-responses-v1", limits }],
        }),
      },
    });
    const fresh = createPrismaClient({ databaseUrl, poolMax: 4 });
    let closeGateway: (() => Promise<void>) | undefined;
    let closeRelayApp: (() => Promise<void>) | undefined;
    let recheckRuntimeConfig: (() => Promise<void>) | undefined;
    let restoreGatewayFetch: (() => void) | undefined;
    let relay: ReviewRunGatewayRelay | undefined;
    const closes: Gateway.Close[] = [];
    try {
      const { prisma, workspaceId, repositoryConnectionId } = harness;
      const accounts = new PrismaProviderAccountRepository(prisma);
      const connection = await prisma.providerAccountConnection.create({
        data: {
          ownerWorkspaceId: workspaceId,
          gatewayAccountRef: `${harness.prefix}-account`,
          profileRef: "mimo-responses-v1",
          displayName: "Synthetic account",
          state: "active",
        },
      });
      const binding = await accounts.compareAndSetBinding({
        workspaceId,
        connectionId: connection.id,
        expectedRevision: 0,
        state: "active",
      });
      const configurations = new PrismaReviewConfigurationRepository(prisma);
      const target = {
        scope: "repository" as const,
        workspaceId,
        repositoryId: repositoryConnectionId,
      };
      const config = parseReviewConfigurationStrict({
        ...safeDefaultReviewConfiguration,
        providers: [
          {
            kind: "codex",
            authMode: "codex_account_gateway",
            model: "mimo-v2-pro",
            reasoningEffort: "high",
            fastMode: false,
            agenticContext: true,
            gatewayBindingId: binding.id,
            gatewayProfileRef: connection.profileRef,
          },
        ],
      });
      await saveReviewConfiguration(
        { target, config, expectedVersion: null },
        { configurations },
      );
      // The legacy reader deduplicates these rows; first admission must reject
      // them through the shared strict parser before creating any authorization.
      const providerRow =
        await prisma.reviewConfigurationVersionProvider.findFirstOrThrow({
          where: {
            workspaceId,
            configurationVersion: {
              configuration: {
                targetKey: `repo:${repositoryConnectionId}`,
              },
            },
          },
        });
      const duplicate = await prisma.reviewConfigurationVersionProvider.create({
        data: {
          ...providerRow,
          id: `${harness.prefix}-duplicate-provider`,
          order: providerRow.order + 1,
        },
      });
      await expect(harness.authorize()).rejects.toThrow();
      expect(
        await prisma.reviewRunAuthorization.count({
          where: { repositoryConnectionId },
        }),
      ).toBe(0);
      await prisma.reviewConfigurationVersionProvider.delete({
        where: { id: duplicate.id },
      });
      const contenders = await Promise.allSettled([
        harness.authorize(),
        harness.authorize(),
      ]);
      const winner = contenders.find((result) => result.status === "fulfilled");
      if (!winner || winner.status !== "fulfilled")
        throw new Error("c2c_first_admission_failed");
      const first = winner.value;
      const row = await fresh.reviewRunAuthorization.findUniqueOrThrow({
        where: { authorizationId: first.authorizationId },
      });
      const pin = parseReviewRunRuntimeSnapshot(
        row.runtimeSnapshotCanonicalJson,
      )!;
      expect(pin.configurationSource).toBe("repository");
      expect(pin.configurationVersion).toBe(1);
      expect(
        parseReviewConfigurationStrict(
          JSON.parse(pin.configurationCanonicalJson),
        ).providers[0]?.model,
      ).toBe("mimo-v2-pro");
      expect(pin.gateway?.permittedAccountRef).toBe(
        connection.gatewayAccountRef,
      );
      expect(pin.gateway?.bindingRevision).toBe(binding.revision);
      expect(pin.gateway?.policyRevision).toBe(binding.policyRevision);
      expect(pin.gateway?.limits).toEqual(limits);
      expect(
        await prisma.reviewRunAuthorization.count({
          where: {
            repositoryConnectionId,
            sourceRunId: row.sourceRunId,
            sourceRunAttempt: row.sourceRunAttempt,
          },
        }),
      ).toBe(1);
      expect(
        await prisma.outboxEvent.count({
          where: {
            aggregateId: first.authorizationId,
            type: "review.run.authorized",
          },
        }),
      ).toBe(1);
      const creationEvent = await fresh.outboxEvent.findFirstOrThrow({
        where: {
          aggregateId: first.authorizationId,
          type: "review.run.authorized",
        },
      });
      const gatewayProduction = composeReviewActionV2ProductionRunControl({
        env: harness.env,
        prisma,
      });
      const gatewayRun =
        await gatewayProduction.repositories.authorizations.findReviewRunAuthorizationById(
          first.authorizationId,
        );
      if (!gatewayRun || !pin.gateway)
        throw new Error("c2c_gateway_original_missing");
      expect(
        await new ProductionReviewRunRuntimeSnapshot(prisma).capture({
          identity: gatewayRun,
          deadline: gatewayRun.maxExpiresAt,
        }),
      ).toBeNull();
      const attachments = new PrismaReviewRunGatewayExecutionBinding(
        prisma,
        gatewayProduction.runtimeSnapshots,
      );
      const owner = {
        authorizationId: first.authorizationId,
        identity: gatewayRun,
        runtimeSnapshotCanonicalJson: row.runtimeSnapshotCanonicalJson!,
      };
      const intents: Gateway.Prepare[] = [];
      const runControlToken = ["disposable", "control", "token"].join("-");
      const executionBearer = ["disposable", "execution", "token"].join("-");
      const selected = {
        bindingVersion: 1 as const,
        operationId: pin.gateway.operationId,
        executionRef: "c2c-selected-execution",
        accountRef: connection.gatewayAccountRef,
        authorizationEpoch: 55,
        deadline: pin.deadline,
      };
      const requests: {
        requestRef: string;
        admission: Gateway.Admission;
        payload: Record<string, unknown>;
      }[] = [];
      let responses: (
        | "limited"
        | "stream"
        | "upstream429"
        | "partial"
        | "unknown"
        | "held"
      )[] = [];
      const sse = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "x".repeat(150000) })}\n\ndata: {"type":"response.completed"}\n\n`;
      let holdAccess: (() => Promise<void>) | undefined;
      let holdStatus: (() => Promise<void>) | undefined;
      let statusCalls = 0;
      const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const raw = Buffer.concat(chunks).toString();
        if (request.headers.authorization === `Bearer ${executionBearer}`) {
          const requestRef = String(
            request.headers["x-gateway-request-id"] ?? "",
          );
          if (
            request.method === "POST" &&
            request.url === `/v1/executions/${selected.executionRef}/requests`
          ) {
            requests.push({
              requestRef,
              admission: JSON.parse(
                String(request.headers["x-gateway-admission"]),
              ),
              payload: JSON.parse(raw),
            });
            const mode = responses.shift();
            if (mode === "limited" || mode === "upstream429") {
              response
                .writeHead(429, { "content-type": "application/json" })
                .end(
                  JSON.stringify({
                    code:
                      mode === "limited"
                        ? "admission_limited"
                        : "upstream_failure",
                    traceRef: "fixture-trace",
                    requestRef,
                    effect: "not_dispatched",
                    retry: { kind: "after", milliseconds: 1 },
                  }),
                );
            } else if (mode === "unknown") {
              response
                .writeHead(202, { "content-type": "application/json" })
                .end(
                  JSON.stringify({
                    requestRef,
                    effect: "effect_unknown",
                    status: "unknown",
                  }),
                );
            } else if (mode === "held") {
              response.writeHead(200, {
                "content-type": "text/event-stream",
                "x-gateway-request-ref": requestRef,
              });
              response.write('data: {"type":"response.created"}\n\n');
            } else if (mode === "stream" || mode === "partial") {
              response.writeHead(200, {
                "content-type": "text/event-stream",
                "x-gateway-request-ref": requestRef,
              });
              response.end(
                mode === "stream" ? sse : sse + "x".repeat(limits.outputBytes),
              );
            } else response.writeHead(500).end();
            return;
          }
          if (
            request.method === "GET" &&
            request.url?.startsWith(
              `/v1/executions/${selected.executionRef}/requests/`,
            )
          ) {
            statusCalls++;
            await holdStatus?.();
            response.writeHead(200, { "content-type": "application/json" }).end(
              JSON.stringify({
                requestRef: request.url.split("/").at(-1),
                effect: "effect_unknown",
                status: "unknown",
              }),
            );
            return;
          }
          if (
            request.method === "POST" &&
            request.url === `/v1/executions/${selected.executionRef}/close`
          ) {
            const close = JSON.parse(raw) as Gateway.Close;
            closes.push(close);
            response.writeHead(200, { "content-type": "application/json" }).end(
              JSON.stringify({
                operationRef: close.operationId,
                state: "applied",
              }),
            );
            return;
          }
          response.writeHead(403).end();
          return;
        }
        const intent = JSON.parse(raw) as Gateway.Prepare;
        intents.push(intent);
        if (
          request.method !== "POST" ||
          request.url !== "/internal/v1/run-access" ||
          request.headers.authorization !== `Bearer ${runControlToken}`
        ) {
          response.writeHead(403).end();
          return;
        }
        await holdAccess?.();
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            operation: {
              operationRef: intent.operationId,
              state: "applied",
              result: {
                kind: "execution",
                executionRef: selected.executionRef,
                accountRef: selected.accountRef,
                authorizationEpoch: selected.authorizationEpoch,
                deadline: intent.deadline,
                state: "active",
              },
            },
            bearer: executionBearer,
            admission: {
              invocationRef: intent.invocationRef,
              attemptRef: intent.attemptRef,
              accountRef: selected.accountRef,
              authorizationEpoch: selected.authorizationEpoch,
              subjectRef: intent.subjectRef,
              policyRevision: intent.policyRevision,
              bindingRevision: intent.bindingRevision,
              profileId: intent.profileId,
              limits: intent.limits,
              expiresAt: intent.deadline,
            },
          }),
        );
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      closeGateway = async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      };
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const githubFetch = globalThis.fetch;
      let holdCheckoutMint: (() => Promise<void>) | undefined;
      let checkoutMints = 0;
      const checkoutExpiry = new Date(Date.now() + 60 * 60_000).toISOString();
      globalThis.fetch = async (request, init) => {
        const value = new Request(request, init);
        const url = new URL(value.url);
        if (url.origin === origin) return networkFetch(request, init);
        if (
          value.method === "POST" &&
          url.hostname === "api.github.com" &&
          url.pathname === "/app/installations/123456/access_tokens"
        ) {
          const rawBody = await value.clone().text();
          const body = (rawBody ? JSON.parse(rawBody) : {}) as {
            repository_ids?: number[];
            permissions?: Record<string, string>;
          };
          if (
            body.permissions?.contents === "read" &&
            body.permissions.pull_requests === "read" &&
            Object.keys(body.permissions).length === 2
          ) {
            expect(body.repository_ids).toEqual([987654321]);
            checkoutMints++;
            const hold = holdCheckoutMint;
            holdCheckoutMint = undefined;
            await hold?.();
            return Response.json(
              {
                token: "fake-checkout-read-token",
                expires_at: checkoutExpiry,
                permissions: { contents: "read", pull_requests: "read" },
                repository_selection: "selected",
              },
              { status: 201 },
            );
          }
        }
        return githubFetch(request, init);
      };
      restoreGatewayFetch = () => {
        globalThis.fetch = githubFetch;
      };
      {
        let loseAttachment = true;
        const preparation = createReviewRunGatewayPreparation({
          authorizationId: first.authorizationId,
          identity: gatewayRun,
          runAccess: {
            origin,
            runControlBearer: runControlToken,
            timeoutMs: 5000,
          },
          authorizations: gatewayProduction.repositories.authorizations,
          snapshots: gatewayProduction.runtimeSnapshots,
          bindings: {
            read: (value) => attachments.read(value),
            attach: async (value, result) => {
              if (loseAttachment) {
                loseAttachment = false;
                throw new Error("synthetic_attachment_loss");
              }
              const outcomes = await Promise.all([
                attachments.attach(value, result),
                attachments.attach(value, result),
              ]);
              expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
                "attached",
                "restored",
              ]);
              return outcomes.find((outcome) => outcome.status === "attached")!;
            },
          },
        });
        await expect(preparation.prepare()).rejects.toThrow(
          "synthetic_attachment_loss",
        );
        expect(intents).toHaveLength(1);
        expect(await preparation.prepare()).toEqual({ status: "denied" });
        expect(intents).toHaveLength(1);
        expect(await preparation.recoverSameOperation()).toEqual({
          status: "prepared",
          binding: selected,
        });
        expect(intents).toHaveLength(2);
        expect(intents[1]).toEqual(intents[0]);
        expect(intents[0]).toMatchObject({
          operationId: pin.gateway.operationId,
          limits,
          deadline: pin.deadline,
          accountRefs: [connection.gatewayAccountRef],
        });
        expect(await preparation.prepare()).toEqual({
          status: "restored",
          binding: selected,
        });
        expect(intents).toHaveLength(2);
        expect(
          await attachments.attach(owner, {
            ...selected,
            executionRef: "other-execution",
          }),
        ).toEqual({ status: "conflict" });
        const saved = await prisma.reviewRunAuthorization.findUniqueOrThrow({
          where: { authorizationId: first.authorizationId },
        });
        expect(saved.gatewayExecutionCanonicalJson).toBe(
          canonicalJson(selected),
        );
        expect(saved.gatewayExecutionCanonicalJson).not.toContain(
          executionBearer,
        );
        expect(JSON.stringify(creationEvent)).not.toContain(executionBearer);
        await expect(
          prisma.$executeRaw`UPDATE "ReviewRunAuthorization" SET "gatewayExecutionCanonicalJson" = NULL WHERE "authorizationId" = ${first.authorizationId}`,
        ).rejects.toThrow("review_run_gateway_execution_immutable");
        await expect(
          prisma.$executeRaw`UPDATE "ReviewRunAuthorization" SET "gatewayExecutionCanonicalJson" = ${canonicalJson({ ...selected, bearer: executionBearer })} WHERE "authorizationId" = ${first.authorizationId}`,
        ).rejects.toThrow();

        // Same nearest boundary: production RR authority + real PG + raw HTTP
        // fixture. No transport/client mocks or alternate authority stores.
        const productionRoutes = composeReviewActionV2ProductionRoutes({
          enabled: true,
          prisma,
          runtime: {
            readServerTime: async () => new Date(),
            createRequestId: () => "relay-fixture",
          },
          env: {
            ...harness.env,
            REVIEW_ROUTER_ACCOUNT_GATEWAY_RELAY_ENABLED: "1",
            REVIEW_ROUTER_ACCOUNT_GATEWAY_ORIGIN: origin,
            REVIEW_ROUTER_ACCOUNT_GATEWAY_RUN_CONTROL_BEARER: runControlToken,
            REVIEW_ROUTER_ACCOUNT_GATEWAY_RELAY_POLICY: JSON.stringify({
              profiles: [
                {
                  profile: {
                    profileId: connection.profileRef,
                    protocol: "openai-responses",
                    modelIds: ["mimo-v2-pro"],
                    authKinds: ["api_key"],
                  },
                  outputTokens: 256,
                },
              ],
              ingressBytes: 4096,
              requestTimeoutMs: 5000,
              waitBudgetMs: 1000,
              maxWaits: 1,
              maxSessions: 4,
              maxInFlight: 1,
            }),
          },
        });
        relay = productionRoutes.accountGatewayRelay!;
        const app = Fastify();
        const responsesRetirements = new WeakMap<
          IncomingMessage,
          Promise<void>
        >();
        app.addHook("onRoute", (route) => {
          if (route.url !== "/api/action/v2/account-gateway/responses") return;
          const handler = route.handler;
          route.handler = async function (request, reply) {
            let retired!: () => void;
            responsesRetirements.set(
              request.raw,
              new Promise<void>((resolve) => {
                retired = resolve;
              }),
            );
            try {
              return await handler.call(this, request, reply);
            } finally {
              retired();
            }
          };
        });
        closeRelayApp = () => app.close();
        await registerReviewRunGatewayRelayRoutes(app, relay);
        await registerReviewRunGatewayCheckoutRoute(
          app,
          productionRoutes.accountGatewayCheckout!,
        );
        const headers = {
          authorization: `Bearer ${first.authorizationToken}`,
          "content-type": "application/json",
        };
        // Synthetic IDs from the existing disposable PG/fake GitHub fixture only.
        const checkoutSelectors = {
          providerInstanceId: "codex-rotating:987654321",
          workflowSchemaVersion: 2,
        };
        const checkout = (
          payload: string | Buffer = JSON.stringify(checkoutSelectors),
        ) =>
          app.inject({
            method: "POST",
            url: "/api/action/v2/account-gateway/checkout",
            headers,
            payload,
          });
        for (const selectors of [
          {
            ...checkoutSelectors,
            providerInstanceId: "codex-rotating:987654322",
          },
          { ...checkoutSelectors, workflowSchemaVersion: 1 },
          { ...checkoutSelectors, workflowSchemaVersion: 3 },
        ]) {
          const denied = await checkout(JSON.stringify(selectors));
          expect(checkoutMints).toBe(0);
          expect(denied.statusCode).toBe(401);
          expect(denied.json()).toEqual({
            error: { code: "authorization_denied" },
          });
        }
        for (const payload of [
          "{}",
          JSON.stringify({
            providerInstanceId: checkoutSelectors.providerInstanceId,
          }),
          '{"workflowSchemaVersion":2}',
          JSON.stringify({
            ...checkoutSelectors,
            repository: "fake-foreign/repo",
          }),
          JSON.stringify({
            ...checkoutSelectors,
            providerInstanceId: 987654321,
          }),
          JSON.stringify({ ...checkoutSelectors, workflowSchemaVersion: "2" }),
          JSON.stringify(checkoutSelectors).replace(
            '"providerInstanceId":',
            '"providerInstanceId":"codex-rotating:987654321","providerInstanceId":',
          ),
          JSON.stringify(checkoutSelectors).replace(
            '"workflowSchemaVersion":2',
            '"workflowSchemaVersion":1,"workflowSchemaVersion":2',
          ),
          JSON.stringify(checkoutSelectors).replace(
            '"providerInstanceId":',
            '"providerInstance\\u0049d":"codex-rotating:987654321","providerInstanceId":',
          ),
          Buffer.concat([
            Buffer.from('{"providerInstanceId":"codex-rotating:'),
            Buffer.from([0xff]),
            Buffer.from('987654321","workflowSchemaVersion":2}'),
          ]),
          `${" ".repeat(513)}${JSON.stringify(checkoutSelectors)}`,
        ]) {
          expect((await checkout(payload)).statusCode).toBe(400);
          expect(checkoutMints).toBe(0);
        }
        expect(
          (
            await app.inject({
              method: "POST",
              url: "/api/action/v2/account-gateway/checkout",
              headers: { ...headers, "content-encoding": "gzip" },
              payload: JSON.stringify(checkoutSelectors),
            })
          ).statusCode,
        ).toBe(400);
        expect(checkoutMints).toBe(0);
        const enteredMint = gate();
        const releaseMint = gate();
        holdCheckoutMint = async () => {
          enteredMint.release();
          await releaseMint.pending;
        };
        const heldCheckout = Promise.resolve(checkout());
        const installation = await prisma.gitHubInstallation.findUniqueOrThrow({
          where: { githubInstallationId: 123456n },
        });
        try {
          await Promise.race([
            enteredMint.pending,
            heldCheckout.then((response) => {
              throw new Error(
                `checkout_mint_fixture_not_entered:${response.statusCode}:${response.body}`,
              );
            }),
          ]);
          await prisma.gitHubInstallation.update({
            where: { id: installation.id },
            data: { status: "suspended" },
          });
          releaseMint.release();
          const denied = await heldCheckout;
          expect(denied.statusCode).toBe(401);
          expect(denied.json()).toEqual({
            error: { code: "authorization_denied" },
          });
          expect(denied.body).not.toContain("fake-checkout-read-token");
        } finally {
          releaseMint.release();
          await heldCheckout;
          await prisma.gitHubInstallation.update({
            where: { id: installation.id },
            data: { status: installation.status },
          });
        }
        const readCapability = await checkout();
        expect(readCapability.statusCode).toBe(200);
        expect(readCapability.headers["cache-control"]).toBe("no-store");
        const repository = await prisma.repositoryConnection.findUniqueOrThrow({
          where: { id: repositoryConnectionId },
        });
        expect(readCapability.json()).toEqual({
          protocolVersion: 1,
          repository: repository.fullName,
          headSha: row.headSha,
          token: "fake-checkout-read-token",
          expiresAt: checkoutExpiry,
          permissions: { contents: "read", pullRequests: "read" },
          runtimeConfig: {
            protocolVersion: 1,
            configVersion: 1,
            runtimeEnv: mapConfigToRuntimeEnv(config),
          },
        });
        const admittedRuntimeConfig = readCapability.json().runtimeConfig;
        expect(admittedRuntimeConfig.runtimeEnv).toMatchObject({
          REVIEW_AUTH_MODE: "codex-account-gateway",
          REVIEW_PROVIDERS: "codex/mimo-v2-pro",
          CODEX_MODEL: "mimo-v2-pro",
          CODEX_REASONING_EFFORT: "high",
        });
        for (const privateValue of [
          connection.id,
          connection.gatewayAccountRef,
          binding.id,
          executionBearer,
          runControlToken,
        ])
          expect(readCapability.body).not.toContain(privateValue);
        recheckRuntimeConfig = async () => {
          const retained = await checkout();
          expect(retained.statusCode).toBe(200);
          expect(retained.json().runtimeConfig).toEqual(admittedRuntimeConfig);
        };
        expect(requests).toHaveLength(0);
        const call = async (payload = '{"input":"fixture"}') => {
          const response = await app.inject({
            method: "POST",
            url: "/api/action/v2/account-gateway/responses",
            headers,
            payload,
          });
          // Hijacked completion precedes cleanup; match this exact request.
          const retirement = responsesRetirements.get(response.raw.req);
          if (retirement) await retirement;
          else if (response.statusCode !== 503)
            throw new Error("fixture_responses_retirement_not_observed");
          return response;
        };
        for (const invalid of [
          '{"model":"caller-model","input":"fixture"}',
          '{"store":false,"st\\u006fre":true}',
          '{"ＭＯＤＥＬ":"mimo-v2-pro"}',
        ]) {
          expect((await call(invalid)).statusCode).toBe(400);
        }
        expect(requests).toHaveLength(0);
        expect((await call()).json()).toMatchObject({
          error: {
            code: "same_operation_recovery_required",
            effect: "effect_unknown",
          },
        });
        expect(intents).toHaveLength(2); // Restart absence must be a SQL read only.
        // Old recovery bypasses the budget: a second recovery/status reaches
        // authority/HTTP while the first same-operation run-access is held.
        const accessEntered = gate(),
          accessRelease = gate();
        holdAccess = async () => {
          accessEntered.release();
          await accessRelease.pending;
        };
        const recovery = relay.recoverSameOperation(first.authorizationToken);
        await accessEntered.pending;
        const readsBeforeRecoveryOverflow = scmReads;
        try {
          await expect(
            relay.recoverSameOperation(first.authorizationToken),
          ).rejects.toMatchObject({ code: "relay_saturated" });
          await expect(
            relay.status(first.authorizationToken, "held-status"),
          ).rejects.toMatchObject({ code: "relay_saturated" });
          expect((await call()).statusCode).toBe(503);
          expect(scmReads).toBe(readsBeforeRecoveryOverflow);
          expect(intents).toHaveLength(3);
          expect(statusCalls).toBe(0);
        } finally {
          holdAccess = undefined;
          accessRelease.release();
        }
        expect(await recovery).toMatchObject({
          status: "restored",
          binding: selected,
        });
        expect(intents[2]).toEqual(intents[0]);
        // Old status also bypasses the budget, allowing duplicate readback HTTP.
        const statusEntered = gate(),
          statusRelease = gate();
        holdStatus = async () => {
          statusEntered.release();
          await statusRelease.pending;
        };
        const readback = relay.status(first.authorizationToken, "held-status");
        await statusEntered.pending;
        const readsBeforeStatusOverflow = scmReads;
        try {
          await expect(
            relay.status(first.authorizationToken, "excess-status"),
          ).rejects.toMatchObject({ code: "relay_saturated" });
          await expect(
            relay.recoverSameOperation(first.authorizationToken),
          ).rejects.toMatchObject({ code: "relay_saturated" });
          expect((await call()).statusCode).toBe(503);
          expect(scmReads).toBe(readsBeforeStatusOverflow);
          expect(statusCalls).toBe(1);
          expect(intents).toHaveLength(3);
        } finally {
          holdStatus = undefined;
          statusRelease.release();
        }
        expect(await readback).toMatchObject({
          status: "unknown",
          effect: "effect_unknown",
        });

        // Public close has its own authority budget: Responses saturation must
        // not prevent cancellation, but duplicate close SCM work stays bounded.
        const closeEntered = gate(),
          closeRelease = gate();
        holdScm = async () => {
          closeEntered.release();
          await closeRelease.pending;
          throw new Error("fixture_close_scm_aborted");
        };
        const pendingClose = relay
          .close(first.authorizationToken, "cancelled")
          .catch((error: unknown) => error);
        await closeEntered.pending;
        const readsBeforeCloseOverflow = scmReads;
        try {
          await expect(
            relay.close(first.authorizationToken, "cancelled"),
          ).rejects.toMatchObject({ code: "relay_saturated" });
          expect(scmReads).toBe(readsBeforeCloseOverflow);
        } finally {
          holdScm = undefined;
          closeRelease.release();
        }
        expect(await pendingClose).toMatchObject({
          message: "fixture_close_scm_aborted",
        });

        // The old concurrent authority projection survives both delays while
        // the authorization row stays active and unchanged: it dispatches HTTP.
        const authorityKey = {
          scmRepositoryIdentityId: gatewayRun.scmRepositoryIdentityId,
          laneKind: ReviewMutationLaneKind.HostedReviewRouterApp,
        };
        for (const delayAt of ["scm", "binding"] as const) {
          const authority =
            await gatewayProduction.repositories.mutationAuthorities.findReviewMutationAuthority(
              authorityKey,
            );
          if (!authority) throw new Error("fixture_authority_missing");
          const entered = gate(),
            release = gate();
          let lock: Promise<void> | undefined;
          if (delayAt === "scm") {
            holdScm = async () => {
              entered.release();
              await release.pending;
            };
          } else {
            lock = fresh.$transaction(async (tx) => {
              await tx.$queryRaw`SELECT "id" FROM "ProviderAccountConnection" WHERE "id" = ${connection.id} FOR UPDATE`;
              entered.release();
              await release.pending;
            });
            await entered.pending;
          }
          responses = ["unknown"];
          const denied = Promise.resolve(call());
          try {
            if (delayAt === "scm") await entered.pending;
            else
              await expect
                .poll(async () => {
                  const waiting = await fresh.$queryRaw<
                    readonly { count: bigint }[]
                  >`SELECT count(*) FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event_type = 'Lock'
                  AND query LIKE '%ProviderAccountConnection%FOR UPDATE%'`;
                  return Number(waiting[0]?.count);
                })
                .toBe(1);
            expect(
              await gatewayProduction.repositories.mutationAuthorities.compareAndSetReviewMutationAuthority(
                {
                  expectedVersion: authority.version,
                  authority: {
                    ...authority,
                    version: authority.version + 1,
                    mode:
                      delayAt === "scm"
                        ? ReviewMutationMode.Paused
                        : authority.mode,
                    epoch:
                      delayAt === "binding"
                        ? authority.epoch + 1n
                        : authority.epoch,
                  },
                },
              ),
            ).toMatchObject({ status: "updated" });
          } finally {
            holdScm = undefined;
            release.release();
          }
          await lock;
          expect((await denied).json()).toMatchObject({
            error: { code: "authorization_denied" },
          });
          expect(requests).toHaveLength(0);
          expect(intents).toHaveLength(3);
          expect(
            await fresh.reviewRunAuthorization.findUniqueOrThrow({
              where: { authorizationId: first.authorizationId },
            }),
          ).toMatchObject({ state: "active", version: row.version });
          // Restore only this disposable fixture for the remaining original-pin checks.
          await gatewayProduction.repositories.mutationAuthorities.compareAndSetReviewMutationAuthority(
            {
              expectedVersion: authority.version + 1,
              authority: { ...authority, version: authority.version + 2 },
            },
          );
        }
        responses = ["limited", "stream"];
        const delivered = await call(
          '{"input":"fixture","max_output_tokens":256,"tools":[]}',
        );
        expect(delivered.statusCode).toBe(200);
        expect(delivered.body).toBe(sse);
        expect(requests).toHaveLength(2);
        expect(requests[0]!.requestRef).not.toBe(requests[1]!.requestRef);
        expect(requests[1]!.admission).toEqual(requests[0]!.admission);
        const {
          operationId: _operationId,
          accountRefs: _accounts,
          deadline,
          ...originalAdmission
        } = intents[0]!;
        void _operationId;
        void _accounts;
        expect(requests[1]!.admission).toEqual({
          ...originalAdmission,
          accountRef: selected.accountRef,
          authorizationEpoch: 55,
          expiresAt: deadline,
        });
        expect(requests[1]!.payload).toMatchObject({
          model: "mimo-v2-pro",
          max_output_tokens: 128,
          stream: true,
          store: false,
          service_tier: "default",
          tools: [],
        });
        responses = ["limited", "limited"];
        expect((await call()).json()).toMatchObject({
          error: { code: "admission_limited", effect: "not_dispatched" },
        });
        expect(requests).toHaveLength(4); // Finite wait exhausted.
        responses = ["upstream429"];
        await call();
        expect(requests).toHaveLength(5); // Even retry:after cannot make upstream quota LOCAL.
        responses = ["unknown"];
        expect((await call()).json()).toMatchObject({
          status: "unknown",
          effect: "effect_unknown",
        });
        expect(requests).toHaveLength(6);
        expect(
          await relay.status(first.authorizationToken, requests[5]!.requestRef),
        ).toMatchObject({ status: "unknown", effect: "effect_unknown" });
        responses = ["partial"];
        const partial = await relay.responses(
          first.authorizationToken,
          new TextEncoder().encode('{"input":"fixture"}'),
          new AbortController(),
        );
        if (partial.kind !== "stream")
          throw new Error("fixture_stream_missing");
        await expect(new Response(partial.body).text()).rejects.toMatchObject({
          effect: "effect_unknown",
        });
        expect(requests).toHaveLength(7); // No partial-output retry/re-ID.
        responses = ["held"];
        const cancelled = new AbortController();
        const held = await relay.responses(
          first.authorizationToken,
          new TextEncoder().encode('{"input":"fixture"}'),
          cancelled,
        );
        if (held.kind !== "stream") throw new Error("fixture_stream_missing");
        cancelled.abort();
        await expect(new Response(held.body).text()).rejects.toMatchObject({
          effect: "effect_unknown",
        });
        expect(requests).toHaveLength(8); // Cancel never becomes success or retry.
      }
      const replay = await harness.authorize(); // New verified OIDC nonce, same owned tuple.
      expect(replay.authorizationId).toBe(first.authorizationId);
      const replacement = await prisma.providerAccountConnection.create({
        data: {
          ownerWorkspaceId: workspaceId,
          gatewayAccountRef: `${harness.prefix}-replacement-account`,
          profileRef: connection.profileRef,
          displayName: "Synthetic replacement account",
          state: "active",
        },
      });
      const replacementBinding = await accounts.compareAndSetBinding({
        workspaceId,
        connectionId: replacement.id,
        expectedRevision: 0,
        state: "active",
      });
      const changed = parseReviewConfigurationStrict({
        ...config,
        providers: [
          {
            ...config.providers[0]!,
            model: "mimo-v2-flash",
            reasoningEffort: "low",
            gatewayBindingId: replacementBinding.id,
          },
        ],
      });
      await saveReviewConfiguration(
        { target, config: changed, expectedVersion: 1 },
        { configurations },
      );
      expect(recheckRuntimeConfig).toBeDefined();
      // Checkout keeps original pro/high/version 1 after repository config switches.
      await recheckRuntimeConfig!();
      expect((await harness.authorize()).authorizationId).toBe(
        first.authorizationId,
      );
      const reread = await fresh.reviewRunAuthorization.findUniqueOrThrow({
        where: { authorizationId: first.authorizationId },
      });
      expect(reread.runtimeSnapshotCanonicalJson).toBe(
        row.runtimeSnapshotCanonicalJson,
      );
      expect(reread.version).toBe(row.version);
      // Existing real private use case/repositories; no policy or publication bypass.
      const production = composeReviewActionV2ProductionRunControl({
        env: harness.env,
        prisma,
      });
      const original =
        await production.repositories.authorizations.findReviewRunAuthorizationById(
          first.authorizationId,
        );
      if (!original) throw new Error("c2c_original_missing");
      const input = (authorization: ReviewRunAuthorization) => ({
        verifiedIdentity: authorization,
        producerReleaseId: authorization.producerReleaseId,
        protocolOfferHash: authorization.protocolOfferHash,
        oidcReplayKeyHash: authorization.oidcReplayKeyHash,
        providerVoteLanes: authorization.providerVoteLanes,
        authorizationTtlMs: 60_000,
        maxAuthorizationLifetimeMs: 3_600_000,
      });
      const retained =
        await production.runControl.authorizations.renewReviewRunAuthorization({
          authorizationId: original.authorizationId,
          verifiedIdentity: original,
          renewalReplayKeyHash: "a".repeat(64),
          requestedTtlMs: 1,
        });
      if (!("authorization" in retained)) throw new Error("c2c_renewal_failed");
      expect(retained.status).toBe(
        ReviewRunAuthorizationUseCaseStatus.Restored,
      );
      expect(retained.authorization).toEqual(original);
      // A full gateway run already owns its entire original six-hour maximum.
      const renewed =
        await production.runControl.authorizations.renewReviewRunAuthorization({
          authorizationId: original.authorizationId,
          verifiedIdentity: original,
          renewalReplayKeyHash: "8".repeat(64),
          requestedTtlMs: 2 * 60 * 60_000,
        });
      if (!("authorization" in renewed)) throw new Error("c2c_renewal_failed");
      expect(renewed.status).toBe(ReviewRunAuthorizationUseCaseStatus.Restored);
      expect(renewed.authorization.runtimeSnapshotCanonicalJson).toBe(
        row.runtimeSnapshotCanonicalJson,
      );
      expect(renewed.authorization.maxExpiresAt).toEqual(original.maxExpiresAt);
      expect(original.expiresAt).toEqual(original.maxExpiresAt);
      expect(original.maxExpiresAt.getTime()).toBe(
        Math.floor((original.createdAt.getTime() + 6 * 60 * 60_000) / 1000) *
          1000,
      );
      expect(renewed.authorization).toEqual(original);
      for (const oidcReplayKeyHash of [
        original.oidcReplayKeyHash,
        "7".repeat(64),
      ]) {
        const restored =
          await production.runControl.authorizations.authorizeReviewRun({
            ...input(original),
            oidcReplayKeyHash,
          });
        expect(restored.status).toBe(
          ReviewRunAuthorizationUseCaseStatus.Restored,
        );
        if (!("authorization" in restored))
          throw new Error("c2c_renewed_restore_failed");
        expect(restored.authorization).toEqual(renewed.authorization);
      }
      expect(
        (
          await production.runControl.authorizations.resolveReviewRunAuthorizationToken(
            {
              token: first.authorizationToken,
            },
          )
        ).status,
      ).toBe("valid");
      expect((await harness.authorize()).authorizationId).toBe(
        original.authorizationId,
      );
      expect(
        await fresh.outboxEvent.findUniqueOrThrow({
          where: { idempotencyKey: creationEvent.idempotencyKey },
        }),
      ).toEqual(creationEvent);
      expect(creationEvent.payload).toMatchObject({ authorizationVersion: 1 });
      expect(creationEvent.occurredAt).toEqual(original.createdAt);
      expect(
        await fresh.outboxEvent.count({
          where: {
            aggregateId: original.authorizationId,
            type: "review.run.authorized",
          },
        }),
      ).toBe(1);
      expect(
        (
          await production.runControl.authorizations.authorizeReviewRun({
            ...input(original),
            protocolOfferHash: "f".repeat(64),
            oidcReplayKeyHash: "e".repeat(64),
          })
        ).status,
      ).toBe(ReviewRunAuthorizationUseCaseStatus.Conflict);
      expect(
        (
          await production.runControl.authorizations.authorizeReviewRun({
            ...input(original),
            oidcReplayKeyHash: "d".repeat(64),
            verifiedIdentity: { ...original, headSha: "9".repeat(40) },
          })
        ).status,
      ).toBe(ReviewRunAuthorizationUseCaseStatus.Conflict);
      expect(
        await prisma.reviewRunAuthorization.count({
          where: { repositoryConnectionId },
        }),
      ).toBe(1);
      expect(
        reviewRunGatewayPreparationIdentity({
          ...original,
          sourceRunAttempt: "2",
        }).invocationId,
      ).toBe(pin.gateway?.invocationId);
      expect(
        reviewRunGatewayPreparationIdentity({
          ...original,
          sourceRunAttempt: "2",
        }).attemptId,
      ).not.toBe(pin.gateway?.attemptId);
      // The DB rejects retroactive pinning/replacement, independent of RR call paths.
      await expect(
        prisma.reviewRunAuthorization.update({
          where: { authorizationId: original.authorizationId },
          data: {
            runtimeSnapshotCanonicalJson: canonicalJson({
              ...pin,
              configurationVersion: 99,
            }),
          },
        }),
      ).rejects.toThrow();
      const snapshotSource = new ProductionReviewRunRuntimeSnapshot(prisma, {
        profiles: [{ profileRef: "mimo-responses-v1", limits }],
      });
      const deniedAfterDeadline = await snapshotSource.isLive({
        snapshot: pin,
        identity: original,
        now: new Date(pin.deadline),
      });
      expect(deniedAfterDeadline).toBe(false);
      const foreign = await prisma.workspace.create({
        data: {
          slug: `${harness.prefix}-foreign`,
          name: "Synthetic foreign workspace",
        },
      });
      await expect(
        prisma.providerAccountConnection.update({
          where: { id: connection.id },
          data: { ownerWorkspaceId: foreign.id },
        }),
      ).rejects.toThrow("provider_account_owner_immutable");
      expect(
        await snapshotSource.isLive({
          snapshot: pin,
          identity: { ...original, workspaceId: foreign.id },
          now: production.clock.now(),
        }),
      ).toBe(false);
      expect(
        await prisma.reviewRunAuthorization.count({
          where: { repositoryConnectionId },
        }),
      ).toBe(1);
      expect(
        (
          await prisma.providerAccountConnection.findUniqueOrThrow({
            where: { id: connection.id },
          })
        ).ownerWorkspaceId,
      ).toBe(workspaceId);

      // Actual read/CAS/INSERT race: mutate the already captured config before the
      // existing atomic repository runs. No test-only production hook is added.
      let observedNow = production.clock.now();
      const verifiedRenewedToken = await production.prerequisites.tokens.verify(
        {
          token: renewed.token.token,
          now: observedNow,
        },
      );
      let crossDuringBindingRead = false;
      const runtimePort: ReviewRunRuntimeSnapshotPort = {
        capture: async (captureInput) => {
          const captured = await snapshotSource.capture(captureInput);
          await saveReviewConfiguration(
            { target, config, expectedVersion: 2 },
            { configurations },
          );
          return captured;
        },
        isLive: async (liveInput) => {
          const live = await snapshotSource.isLive(liveInput);
          if (crossDuringBindingRead) {
            expect(live).toBe(true); // The original binding was actually read.
            expect(liveInput.now.getTime()).toBeLessThan(
              verifiedRenewedToken.expiresAt.getTime(),
            );
            observedNow = new Date(liveInput.snapshot.deadline);
          }
          return live;
        },
      };
      const control = new ManageReviewRunAuthorizations({
        runtimeSnapshots: runtimePort,
        clock: { now: () => observedNow },
        digest: production.digest,
        identifiers: { nextId: () => `${harness.prefix}-fenced-admission` },
        identities: production.repositories.repositoryIdentities,
        authorities: production.repositories.mutationAuthorities,
        releases: production.repositories.producerReleases,
        limits: production.repositories.producerReleases,
        slos: production.repositories.producerReleases,
        safetyDecisions: production.runControl.safetyResolver,
        authorizationQueries: production.repositories.authorizations,
        authorizationCommands: production.repositories.authorizations,
        tokens: production.prerequisites.tokens,
      });
      expect(
        (
          await control.authorizeReviewRun({
            ...input(original),
            verifiedIdentity: { ...original, sourceRunAttempt: "3" },
            oidcReplayKeyHash: "c".repeat(64),
          })
        ).status,
      ).toBe(ReviewRunAuthorizationUseCaseStatus.Denied);
      expect(
        await prisma.reviewRunAuthorization.count({
          where: { repositoryConnectionId },
        }),
      ).toBe(1);
      expect(
        (
          await control.resolveReviewRunAuthorizationToken({
            token: renewed.token.token,
          })
        ).status,
      ).toBe("valid");
      // The original gateway capability and pin share the exact deadline.
      crossDuringBindingRead = true;
      expect(
        (
          await control.resolveReviewRunAuthorizationToken({
            token: renewed.token.token,
          })
        ).status,
      ).toBe("expired");
      crossDuringBindingRead = false;
      observedNow = production.clock.now();
      await accounts.compareAndSetBinding({
        workspaceId,
        connectionId: connection.id,
        expectedRevision: binding.revision,
        state: "revoked",
      });
      await expect(harness.authorize()).rejects.toThrow();
      await expect(
        harness.authorize({ sourceRunAttempt: "4" }),
      ).rejects.toThrow();
      // Current configuration now points to a different live account, but replay,
      // renewal and token resolution must still honor the original revocation.
      await saveReviewConfiguration(
        { target, config: changed, expectedVersion: 3 },
        { configurations },
      );
      expect(
        (
          await snapshotSource.capture({
            identity: original,
            deadline: original.maxExpiresAt,
          })
        )?.gateway?.bindingId,
      ).toBe(replacementBinding.id);
      await expect(harness.authorize()).rejects.toThrow();
      expect(
        (
          await production.runControl.authorizations.resolveReviewRunAuthorizationToken(
            {
              token: renewed.token.token,
            },
          )
        ).status,
      ).toBe("revoked");
      expect(
        (
          await production.runControl.authorizations.renewReviewRunAuthorization(
            {
              authorizationId: first.authorizationId,
              verifiedIdentity: original,
              renewalReplayKeyHash: "b".repeat(64),
              requestedTtlMs: 60_000,
            },
          )
        ).status,
      ).toBe(ReviewRunAuthorizationUseCaseStatus.Denied);
      const unchanged = await fresh.reviewRunAuthorization.findUniqueOrThrow({
        where: { authorizationId: first.authorizationId },
      });
      expect(unchanged.runtimeSnapshotCanonicalJson).toBe(
        row.runtimeSnapshotCanonicalJson,
      );
      expect(unchanged.version).toBe(renewed.authorization.version);
      expect(unchanged.expiresAt).toEqual(renewed.authorization.expiresAt);
      expect(unchanged.maxExpiresAt).toEqual(row.maxExpiresAt);
      expect(
        await prisma.reviewRunAuthorization.count({
          where: { repositoryConnectionId },
        }),
      ).toBe(1);
      // A terminal version advance must also validate the original creation,
      // then return the current terminal row rather than recreating admission.
      await production.runControl.authorizations.expireOrRevokeReviewRunAuthorization(
        {
          authorizationId: original.authorizationId,
          state: ReviewRunAuthorizationState.Revoked,
        },
      );
      for (const oidcReplayKeyHash of [
        original.oidcReplayKeyHash,
        "6".repeat(64),
      ]) {
        expect(
          (
            await production.runControl.authorizations.authorizeReviewRun({
              ...input(original),
              oidcReplayKeyHash,
            })
          ).status,
        ).toBe(ReviewRunAuthorizationUseCaseStatus.Revoked);
      }
      const terminal = await fresh.reviewRunAuthorization.findUniqueOrThrow({
        where: { authorizationId: original.authorizationId },
      });
      expect(terminal.version).toBe(renewed.authorization.version + 1);
      expect(terminal.runtimeSnapshotCanonicalJson).toBe(
        row.runtimeSnapshotCanonicalJson,
      );
      expect(terminal.maxExpiresAt).toEqual(row.maxExpiresAt);
      expect(
        await fresh.outboxEvent.findMany({
          where: {
            aggregateId: original.authorizationId,
            type: "review.run.authorized",
          },
        }),
      ).toEqual([creationEvent]);
      expect(
        await relay!.closeRun(original.authorizationId, "completed"),
      ).toMatchObject({ state: "applied" });
      expect(closes).toHaveLength(1);
      expect(closes[0]!.reason).toBe("completed");
      await expect(
        relay!.responses(
          first.authorizationToken,
          new TextEncoder().encode('{"input":"fixture"}'),
          new AbortController(),
        ),
      ).rejects.toMatchObject({ code: "authorization_denied" });
      // Separate ordinary-TTL fixture in this same PG lifecycle case: real
      // configuration capture, admission, renewal, restore and SQL/outbox reads.
      await saveReviewConfiguration(
        { target, config: safeDefaultReviewConfiguration, expectedVersion: 4 },
        { configurations },
      );
      const ordinaryAdmission =
        await production.runControl.authorizations.authorizeReviewRun({
          ...input(original),
          verifiedIdentity: {
            ...original,
            sourceRunId: `${original.sourceRunId}-ordinary`,
          },
          oidcReplayKeyHash: "1".repeat(64),
        });
      if (!("authorization" in ordinaryAdmission))
        throw new Error("c2c_ordinary_admission_failed");
      expect(ordinaryAdmission.status).toBe(
        ReviewRunAuthorizationUseCaseStatus.Authorized,
      );
      const ordinary = ordinaryAdmission.authorization;
      expect(ordinary.expiresAt.getTime()).toBe(
        ordinary.createdAt.getTime() + 60_000,
      );
      expect(ordinary.maxExpiresAt.getTime()).toBe(
        ordinary.createdAt.getTime() + 3_600_000,
      );
      const ordinaryPin = parseReviewRunRuntimeSnapshot(
        ordinary.runtimeSnapshotCanonicalJson,
      )!;
      expect(ordinaryPin.gateway).toBeNull();
      const ordinaryCreation = await fresh.outboxEvent.findFirstOrThrow({
        where: {
          aggregateId: ordinary.authorizationId,
          type: "review.run.authorized",
        },
      });
      const shortToken = await production.prerequisites.tokens.verify({
        token: ordinaryAdmission.token.token,
        now: production.clock.now(),
      });
      observedNow = production.clock.now();
      let crossOrdinaryExpiry = false;
      const ordinaryControl = new ManageReviewRunAuthorizations({
        runtimeSnapshots: {
          capture: (captureInput) => snapshotSource.capture(captureInput),
          isLive: async (liveInput) => {
            const live = await snapshotSource.isLive(liveInput);
            expect(live).toBe(true);
            return live;
          },
        },
        clock: { now: () => observedNow },
        digest: production.digest,
        identifiers: { nextId: () => `${harness.prefix}-ordinary-unused` },
        identities: production.repositories.repositoryIdentities,
        authorities: production.repositories.mutationAuthorities,
        releases: production.repositories.producerReleases,
        limits: production.repositories.producerReleases,
        slos: production.repositories.producerReleases,
        safetyDecisions: production.runControl.safetyResolver,
        authorizationQueries: {
          findReviewRunAuthorizationForAdmission: (admissionInput) =>
            production.repositories.authorizations.findReviewRunAuthorizationForAdmission(
              admissionInput,
            ),
          findReviewRunAuthorizationById: async (authorizationId) => {
            const authorization =
              await production.repositories.authorizations.findReviewRunAuthorizationById(
                authorizationId,
              );
            if (crossOrdinaryExpiry) observedNow = shortToken.expiresAt;
            return authorization;
          },
        },
        authorizationCommands: production.repositories.authorizations,
        tokens: production.prerequisites.tokens,
      });
      expect(
        (
          await ordinaryControl.resolveReviewRunAuthorizationToken({
            token: ordinaryAdmission.token.token,
          })
        ).status,
      ).toBe("valid");
      crossOrdinaryExpiry = true;
      expect(
        (
          await ordinaryControl.resolveReviewRunAuthorizationToken({
            token: ordinaryAdmission.token.token,
          })
        ).status,
      ).toBe("expired");
      crossOrdinaryExpiry = false;
      expect(observedNow).toEqual(shortToken.expiresAt);
      expect(observedNow.getTime()).toBeLessThanOrEqual(
        ordinary.expiresAt.getTime(),
      );
      expect(observedNow.getTime()).toBeLessThan(
        Date.parse(ordinaryPin.deadline),
      );
      observedNow = production.clock.now();
      const ordinaryRenewed =
        await production.runControl.authorizations.renewReviewRunAuthorization({
          authorizationId: ordinary.authorizationId,
          verifiedIdentity: ordinary,
          renewalReplayKeyHash: "2".repeat(64),
          requestedTtlMs: 120_000,
        });
      if (!("authorization" in ordinaryRenewed))
        throw new Error("c2c_ordinary_renewal_failed");
      expect(ordinaryRenewed.status).toBe(
        ReviewRunAuthorizationUseCaseStatus.Renewed,
      );
      expect(ordinaryRenewed.authorization.version).toBe(2);
      expect(ordinaryRenewed.authorization.createdAt).toEqual(
        ordinary.createdAt,
      );
      expect(ordinaryRenewed.authorization.maxExpiresAt).toEqual(
        ordinary.maxExpiresAt,
      );
      expect(ordinaryRenewed.authorization.runtimeSnapshotCanonicalJson).toBe(
        ordinary.runtimeSnapshotCanonicalJson,
      );
      expect(ordinaryRenewed.authorization.expiresAt.getTime()).toBeGreaterThan(
        ordinary.expiresAt.getTime(),
      );
      expect(ordinaryRenewed.authorization.expiresAt.getTime()).toBeLessThan(
        ordinary.maxExpiresAt.getTime(),
      );
      for (const oidcReplayKeyHash of [
        ordinary.oidcReplayKeyHash,
        "3".repeat(64),
      ]) {
        const restored =
          await production.runControl.authorizations.authorizeReviewRun({
            ...input(ordinary),
            oidcReplayKeyHash,
          });
        if (!("authorization" in restored))
          throw new Error("c2c_ordinary_restore_failed");
        expect(restored.status).toBe(
          ReviewRunAuthorizationUseCaseStatus.Restored,
        );
        expect(restored.authorization).toEqual(ordinaryRenewed.authorization);
      }
      expect(
        (
          await production.runControl.authorizations.resolveReviewRunAuthorizationToken(
            {
              token: ordinaryAdmission.token.token,
            },
          )
        ).status,
      ).toBe("claim_drift");
      expect(
        await fresh.outboxEvent.findMany({
          where: {
            aggregateId: ordinary.authorizationId,
            type: "review.run.authorized",
          },
        }),
      ).toEqual([ordinaryCreation]);
      expect(ordinaryCreation.payload).toMatchObject({
        authorizationVersion: 1,
      });
      expect(ordinaryCreation.occurredAt).toEqual(ordinary.createdAt);
    } finally {
      await closeRelayApp?.();
      await closeGateway?.();
      restoreGatewayFetch?.();
      await fresh.$disconnect();
      await harness.close();
    }
  }, 60_000);
});
