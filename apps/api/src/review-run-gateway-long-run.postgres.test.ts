import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { decodeJwt } from "jose";
import { describe, expect, it, vi } from "vitest";
import { SystemClock } from "@reviewrouter/shared";
import * as c from "@agent-teams/account-gateway/contracts";
import { PrismaProviderAccountRepository } from "@reviewrouter/features-provider-accounts";
import {
  parseReviewConfigurationStrict,
  PrismaReviewConfigurationRepository,
  saveReviewConfiguration,
  safeDefaultReviewConfiguration,
} from "@reviewrouter/features-review-config";
import {
  canonicalJson,
  ManageReviewRunAuthorizations,
  parseReviewRunRuntimeSnapshot,
  ReviewRunAuthorizationState,
} from "@reviewrouter/features-review-run-control";
import { createReviewActionV2E2EHarness } from "../../../scripts/review-action-v2-production-e2e/support/review-action-v2-e2e-harness";
import {
  composeReviewActionV2ProductionRoutes,
  composeReviewActionV2ProductionRunControl,
} from "./review-action-v2-production-composition";
import { registerReviewRunGatewayRelayRoutes } from "./review-run-gateway-relay";

// Failure defined before adding this case: an otherwise live pinned gateway run
// loses its ORIGINAL signed capability at the ordinary RR TTL. Exercise the
// real production admission/relay + SQL121 attachment, signed synthetic OIDC
// and controlled HTTP. There is no provider inference or product E2E claim.
// Compress SERVER timing and inject the existing SystemClock seam. PG and HTTP
// stay real; the logical clock stays ahead of PG for SQL attachment liveness.
describe.skipIf(process.env.RR_P115_PG_TEST !== "1")(
  "P115 original run capability",
  () => {
    it("reuses one capability after mint/TTL expiry, then denies close, revoke and deadline", async () => {
      const url = new URL(process.env.RR_P115_PG_TEST_URL ?? "");
      if (
        process.env.RR_P115_FRESH_MIGRATED_DATABASE !== "1" ||
        !["postgres:", "postgresql:"].includes(url.protocol) ||
        !["127.0.0.1", "localhost"].includes(url.hostname) ||
        !/^rr_gateway_test_p115_[a-z0-9_]+$/.test(url.pathname.slice(1)) ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error(
          "p115_fresh_migrated_disposable_loopback_database_required",
        );

      const ttlMs = 5_000;
      const lifetimeMs = 18_000;
      const limits = {
        requests: 8,
        concurrency: 1,
        requestBytes: 4096,
        outputBytes: 4096,
        tokens: 128,
      };
      const controlBearer = "disposable-p115-control-token";
      const executionBearer = "disposable-p115-execution-token";
      const preparations: c.Prepare[] = [];
      const executions = new Map<string, c.Admission>();
      const observations: { executionRef: string; admission: c.Admission }[] =
        [];
      const closes: c.Close[] = [];
      // The real production env/capture path must route close independently.
      // Dropping controlOrigin makes the existing close-success assertion fail.
      const controlServer = createServer((request, response) => {
        if (
          request.method !== "POST" ||
          !/^\/v1\/executions\/[^/]+\/close$/.test(request.url ?? "")
        ) {
          response.writeHead(403).end();
          return;
        }
        server.emit("request", request, response);
      });
      const server = createServer((request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const body: unknown = JSON.parse(
            Buffer.concat(chunks).toString("utf8"),
          );
          const json = (status: number, value: unknown) =>
            response
              .writeHead(status, { "content-type": "application/json" })
              .end(JSON.stringify(value));
          if (
            request.method === "POST" &&
            request.url === "/internal/v1/run-access" &&
            request.headers.authorization === `Bearer ${controlBearer}`
          ) {
            const intent = c.prepare.parse(body);
            preparations.push(intent);
            const executionRef = `p115-execution-${preparations.length}`;
            const admission = c.admission.parse({
              invocationRef: intent.invocationRef,
              attemptRef: intent.attemptRef,
              accountRef: intent.accountRefs[0],
              authorizationEpoch: 7,
              subjectRef: intent.subjectRef,
              policyRevision: intent.policyRevision,
              bindingRevision: intent.bindingRevision,
              profileId: intent.profileId,
              limits: intent.limits,
              expiresAt: intent.deadline,
            });
            executions.set(executionRef, admission);
            json(200, {
              operation: {
                operationRef: intent.operationId,
                state: "applied",
                result: {
                  kind: "execution",
                  executionRef,
                  accountRef: admission.accountRef,
                  authorizationEpoch: admission.authorizationEpoch,
                  deadline: intent.deadline,
                  state: "active",
                },
              },
              bearer: executionBearer,
              admission,
            });
            return;
          }
          const match = /^\/v1\/executions\/([^/]+)\/(requests|close)$/.exec(
            request.url ?? "",
          );
          const executionRef = match?.[1];
          const saved = executionRef ? executions.get(executionRef) : undefined;
          if (
            request.method !== "POST" ||
            !saved ||
            !executionRef ||
            request.headers.authorization !== `Bearer ${executionBearer}`
          ) {
            json(403, { error: "fixture_denied" });
            return;
          }
          if (match?.[2] === "close") {
            if (
              request.socket.localPort !==
              (controlServer.address() as AddressInfo).port
            ) {
              json(403, { error: "fixture_control_ingress_required" });
              return;
            }
            const close = c.close.parse(body);
            closes.push(close);
            executions.delete(executionRef);
            json(200, { operationRef: close.operationId, state: "applied" });
            return;
          }
          const admission = c.admission.parse(
            JSON.parse(String(request.headers["x-gateway-admission"])),
          );
          if (
            canonicalJson(admission) !== canonicalJson(saved) ||
            now >= Date.parse(saved.expiresAt)
          ) {
            json(403, { error: "fixture_denied" });
            return;
          }
          observations.push({ executionRef, admission });
          response
            .writeHead(200, {
              "content-type": "text/event-stream",
              "x-gateway-request-ref": String(
                request.headers["x-gateway-request-id"],
              ),
            })
            .end('data: {"type":"response.completed"}\n\n');
        })().catch(() => {
          if (response.headersSent) response.destroy();
          else response.writeHead(500).end();
        });
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      await new Promise<void>((resolve) =>
        controlServer.listen(0, "127.0.0.1", resolve),
      );
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const controlOrigin = `http://127.0.0.1:${(controlServer.address() as AddressInfo).port}`;
      const networkFetch = globalThis.fetch;
      const app = Fastify();
      let harness:
        | Awaited<ReturnType<typeof createReviewActionV2E2EHarness>>
        | undefined;
      // OIDC mint/verification uses wall time; move the existing server clock
      // only once verified admission enters the use case. Keep SQL wall-time
      // expiry guards intact by choosing a bounded future fractional instant.
      const admissionTime = Math.ceil(Date.now() / 1000) * 1000 + 60_750;
      let now = Date.now();
      const clock = vi
        .spyOn(SystemClock.prototype, "now")
        .mockImplementation(() => new Date(now));
      const originalAuthorize =
        ManageReviewRunAuthorizations.prototype.authorizeReviewRun;
      const timing = vi
        .spyOn(ManageReviewRunAuthorizations.prototype, "authorizeReviewRun")
        .mockImplementation(function (
          this: ManageReviewRunAuthorizations,
          input,
        ) {
          now = admissionTime;
          return originalAuthorize.call(this, {
            ...input,
            authorizationTtlMs: ttlMs,
            maxAuthorizationLifetimeMs: lifetimeMs,
          });
        });
      try {
        harness = await createReviewActionV2E2EHarness(url.toString(), {
          oidcLifetimeSeconds: 4,
          environmentOverrides: {
            REVIEW_ROUTER_ACCOUNT_GATEWAY_POLICY: JSON.stringify({
              profiles: [{ profileRef: "mimo-responses-v1", limits }],
            }),
          },
        });
        const { prisma, workspaceId, repositoryConnectionId } = harness;
        // Reject a reused DB before creating this scenario's account/binding.
        expect(await prisma.reviewRunAuthorization.count()).toBe(0);
        const connection = await prisma.providerAccountConnection.create({
          data: {
            ownerWorkspaceId: workspaceId,
            gatewayAccountRef: `${harness.prefix}-account`,
            profileRef: "mimo-responses-v1",
            displayName: "Disposable P115",
            state: "active",
          },
        });
        const accounts = new PrismaProviderAccountRepository(prisma);
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
        await saveReviewConfiguration(
          {
            target,
            expectedVersion: null,
            config: parseReviewConfigurationStrict({
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
            }),
          },
          { configurations },
        );
        const githubFetch = globalThis.fetch;
        globalThis.fetch = (request, init) => {
          const address = new URL(
            request instanceof Request ? request.url : request.toString(),
          );
          return address.origin === origin || address.origin === controlOrigin
            ? networkFetch(request, init)
            : githubFetch(request, init);
        };
        const routes = composeReviewActionV2ProductionRoutes({
          enabled: true,
          prisma,
          runtime: {
            readServerTime: async () => new Date(),
            createRequestId: () => "p115-fixture",
          },
          env: {
            ...harness.env,
            REVIEW_ROUTER_ACCOUNT_GATEWAY_RELAY_ENABLED: "1",
            REVIEW_ROUTER_ACCOUNT_GATEWAY_ORIGIN: origin,
            REVIEW_ROUTER_ACCOUNT_GATEWAY_CONTROL_ORIGIN: controlOrigin,
            REVIEW_ROUTER_ACCOUNT_GATEWAY_RUN_CONTROL_BEARER: controlBearer,
            REVIEW_ROUTER_ACCOUNT_GATEWAY_RELAY_POLICY: JSON.stringify({
              profiles: [
                {
                  profile: {
                    profileId: connection.profileRef,
                    protocol: "openai-responses",
                    modelIds: ["mimo-v2-pro"],
                    authKinds: ["api_key"],
                  },
                  outputTokens: 128,
                },
              ],
              ingressBytes: 4096,
              requestTimeoutMs: 3000,
              waitBudgetMs: 0,
              maxWaits: 0,
              maxSessions: 4,
              maxInFlight: 2,
            }),
          },
        });
        if (!routes.accountGatewayRelay) throw new Error("p115_relay_missing");
        await registerReviewRunGatewayRelayRoutes(
          app,
          routes.accountGatewayRelay,
        );
        const relayOrigin = await app.listen({ host: "127.0.0.1", port: 0 });
        const send = async (
          token: string,
          path = "responses",
          body: unknown = { input: "Disposable fixture" },
        ) => {
          const response = await networkFetch(
            `${relayOrigin}/api/action/v2/account-gateway/${path}`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
              },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(5000),
            },
          );
          const text = await response.text();
          return { status: response.status, text };
        };
        now = Date.now();
        const first = await harness.authorize();
        expect(harness.generatedOidcTokenCount).toBe(1);
        expect((await send(first.authorizationToken)).status).toBe(200);
        const initial = await prisma.reviewRunAuthorization.findUniqueOrThrow({
          where: { authorizationId: first.authorizationId },
        });
        const pin = parseReviewRunRuntimeSnapshot(
          initial.runtimeSnapshotCanonicalJson,
        );
        if (!pin?.gateway?.limits || !first.oidcExpiresAt)
          throw new Error("p115_pin_missing");
        const formerTtl = initial.createdAt.getTime() + ttlMs;
        expect(initial.createdAt.getTime()).toBe(admissionTime);
        expect(initial.createdAt.getMilliseconds()).toBe(750);
        now = formerTtl + 25;
        expect(now).toBeGreaterThan(Date.parse(first.oidcExpiresAt));
        const long = await send(first.authorizationToken);
        // Retain the former-TTL regression with real HTTP SSE.
        expect(long.status).toBe(200);
        expect(long.text).toContain('"response.completed"');
        expect(preparations).toHaveLength(1);
        expect(observations).toHaveLength(2);
        expect(observations[1]).toEqual(observations[0]);
        expect(observations[1]?.admission).toMatchObject({
          invocationRef: pin.gateway.invocationId,
          attemptRef: pin.gateway.attemptId,
          accountRef: connection.gatewayAccountRef,
          expiresAt: pin.deadline,
        });
        // a13 RED: fractional persisted maximum differs from signed exp.
        expect(initial.maxExpiresAt.getTime()).toBe(
          Math.floor((admissionTime + lifetimeMs) / 1000) * 1000,
        );
        expect(initial.maxExpiresAt.getMilliseconds()).toBe(0);
        expect(preparations[0]?.deadline).toBe(pin.deadline);
        expect(initial.expiresAt).toEqual(initial.maxExpiresAt);
        expect(initial.maxExpiresAt.toISOString()).toBe(pin.deadline);
        expect(decodeJwt(first.authorizationToken).exp).toBe(
          initial.maxExpiresAt.getTime() / 1000,
        );
        expect(harness.generatedOidcTokenCount).toBe(1);
        expect(await prisma.reviewRunAuthorizationRenewalReceipt.count()).toBe(
          0,
        );
        const unchanged = await prisma.reviewRunAuthorization.findUniqueOrThrow(
          { where: { authorizationId: first.authorizationId } },
        );
        expect(unchanged.expiresAt).toEqual(initial.expiresAt);
        expect(unchanged.version).toBe(initial.version);
        expect(unchanged.renewedAt).toBeNull();

        now = Date.now();
        const closed = await harness.authorize({ sourceRunAttempt: "2" });
        expect((await send(closed.authorizationToken)).status).toBe(200);
        expect(
          (
            await send(closed.authorizationToken, "close", {
              reason: "completed",
            })
          ).status,
        ).toBe(200);
        const afterClose = observations.length;
        expect((await send(closed.authorizationToken)).status).toBe(401);
        expect(observations).toHaveLength(afterClose);
        expect(closes).toHaveLength(1);

        now = Date.now();
        const revoked = await harness.authorize({ sourceRunAttempt: "3" });
        expect((await send(revoked.authorizationToken)).status).toBe(200);
        const control = composeReviewActionV2ProductionRunControl({
          env: harness.env,
          prisma,
        });
        await control.runControl.authorizations.expireOrRevokeReviewRunAuthorization(
          {
            authorizationId: revoked.authorizationId,
            state: ReviewRunAuthorizationState.Revoked,
          },
        );
        const afterRevoke = observations.length;
        expect((await send(revoked.authorizationToken)).status).toBe(401);
        expect(observations).toHaveLength(afterRevoke);
        // The exact final millisecond stays live with the ORIGINAL capability.
        now = initial.maxExpiresAt.getTime() - 1;
        expect((await send(first.authorizationToken)).status).toBe(200);
        const beforeDeadline = observations.length;
        for (const offset of [0, 1]) {
          now = initial.maxExpiresAt.getTime() + offset;
          expect((await send(first.authorizationToken)).status).toBe(401);
          expect(observations).toHaveLength(beforeDeadline);
        }
        const final = await prisma.reviewRunAuthorization.findUniqueOrThrow({
          where: { authorizationId: first.authorizationId },
        });
        expect(final.version).toBe(initial.version);
        expect(final.expiresAt).toEqual(initial.expiresAt);
        expect(final.maxExpiresAt).toEqual(initial.maxExpiresAt);
        expect(final.runtimeSnapshotCanonicalJson).toBe(
          initial.runtimeSnapshotCanonicalJson,
        );
        expect(final.renewedAt).toBeNull();
        expect(preparations).toHaveLength(3);
        expect(await prisma.reviewRunAuthorizationRenewalReceipt.count()).toBe(
          0,
        );
        expect(
          await prisma.reviewRunAuthorization.count({
            where: { authorizationId: first.authorizationId },
          }),
        ).toBe(1);
        expect(
          await prisma.reviewRunAuthorization.findUniqueOrThrow({
            where: { authorizationId: closed.authorizationId },
          }),
        ).toMatchObject({ state: ReviewRunAuthorizationState.Revoked });
      } finally {
        timing.mockRestore();
        clock.mockRestore();
        try {
          await app.close();
        } finally {
          try {
            if (harness) await harness.close();
          } finally {
            globalThis.fetch = networkFetch;
            server.closeAllConnections();
            controlServer.closeAllConnections();
            await Promise.all(
              [server, controlServer].map(
                (listener) =>
                  new Promise<void>((resolve, reject) =>
                    listener.close((error) =>
                      error ? reject(error) : resolve(),
                    ),
                  ),
              ),
            );
          }
        }
      }
    }, 45_000);
  },
);
