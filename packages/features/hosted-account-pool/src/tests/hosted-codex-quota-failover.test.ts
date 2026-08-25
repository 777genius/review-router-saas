import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  hostedAccountId,
  hostedBindingId,
  hostedPoolId,
  invocationGrantId,
  invocationId,
  relayRequestId,
  repositoryId,
  workspaceId,
} from "../domain/identifiers";
import {
  enrollHostedPoolAccount,
  type HostedPoolAccount,
} from "../domain/account-pool";
import type {
  CurrentRelayRequestFailover,
  InvocationGrant,
} from "../domain/invocation-grant";
import {
  admitRelayRequest,
  issueInvocationGrant,
} from "../domain/invocation-grant";
import { FetchHostedCodexStreamingRelay } from "../infrastructure/http/prisma-hosted-codex-relay";
import {
  HostedCodexCredentialGenerationChangedError,
  HostedCodexEffectReservationDeferredError,
  type HostedCodexUpstreamEffectLease,
} from "../infrastructure/prisma/prisma-hosted-codex-upstream-effect-ledger";

const now = new Date("2026-08-16T12:00:00.000Z");
const requestId = relayRequestId("request-capacity-1");

describe("hosted Codex quota failover", () => {
  it.each([
    { upstreamStatus: 429, expectedReason: "rate_limited" },
    { upstreamStatus: 401, expectedReason: "credential_invalid" },
  ])(
    "switches once on classified $upstreamStatus before response start",
    async ({ upstreamStatus, expectedReason }) => {
      const primary = account("primary", 0);
      const backup = account("backup", 1);
      let grant = admittedGrant(primary, backup);
      let failedAccount: HostedPoolAccount | null = null;
      const checkpoints: string[] = [];
      const requestHashes: string[] = [];

      const ledger = {
        recordRequestHash: vi.fn(async (input: { requestHash: string }) => {
          checkpoints.push("request_hash");
          requestHashes.push(input.requestHash);
        }),
        failover: vi.fn(
          async (input: {
            effect?: {
              sourceState: string;
              terminalState: string;
            };
            transition: (
              grant: InvocationGrant,
              failedAccount: HostedPoolAccount,
              backupAccount: HostedPoolAccount | null,
            ) => CurrentRelayRequestFailover;
          }) => {
            checkpoints.push("capacity_failover");
            expect(input.effect).toMatchObject({
              sourceState: "response_started",
              terminalState: "failed_classified",
            });
            expect(grant.inFlightRequestIds).toEqual([requestId]);
            const result = input.transition(grant, primary, backup);
            if (result.status === "switched") {
              grant = result.grant;
              failedAccount = result.failedAccount;
            }
            return result;
          },
        ),
        markStarted: vi.fn(
          async (input: {
            transition: (grant: InvocationGrant) => InvocationGrant;
          }) => {
            checkpoints.push("response_started");
            expect(grant.activeAccountId).toBe(backup.id);
            expect(grant.inFlightRequestIds).toEqual([requestId]);
            grant = input.transition(grant);
            return grant;
          },
        ),
        complete: vi.fn(
          async (input: {
            transition: (grant: InvocationGrant) => InvocationGrant;
          }) => {
            checkpoints.push("request_completed");
            grant = input.transition(grant);
            return grant;
          },
        ),
      };
      const runtime = {
        ensureFreshSession: vi.fn(
          async ({ accountId }: { accountId: string }) => ({
            accessToken: `access-${accountId}`,
            chatgptAccountId: `chatgpt-${accountId}`,
            credentialGeneration: 1,
          }),
        ),
        classifyFailure: vi.fn(() => ({ code: "unknown" })),
      };
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response("classified", { status: upstreamStatus }),
        )
        .mockResolvedValueOnce(
          new Response('data: {"type":"response.completed"}\n\n', {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        );
      let effectOrdinal = 0;
      const effects = {
        assertLiveAuthority: vi.fn(async () => undefined),
        prepare: vi.fn(async ({ accountId }: { accountId: string }) => {
          effectOrdinal += 1;
          return {
            attemptId: `attempt-${effectOrdinal}`,
            attemptOrdinal: effectOrdinal,
            ownerToken: `owner-${effectOrdinal}`,
            fenceEpoch: BigInt(effectOrdinal),
            accountId,
            credentialGeneration: 1,
          };
        }),
        markDispatching: vi.fn(async () => undefined),
        heartbeat: vi.fn(async () => undefined),
        markResponseStarted: vi.fn(async () => undefined),
        authority: vi.fn((lease: HostedCodexUpstreamEffectLease) => ({
          attemptId: lease.attemptId,
          ownerIdHash: createHash("sha256")
            .update(lease.attemptId)
            .digest("hex"),
          fenceEpoch: lease.fenceEpoch,
        })),
      };
      const faultPlans = {
        consume: vi.fn(
          async (_scope: { attemptOrdinal: number; injectionPoint: string }) =>
            null,
        ),
      };
      const relay = new FetchHostedCodexStreamingRelay(
        runtime as never,
        ledger as never,
        fetchImpl,
        { failoverEnabled: true, now: () => now, effects, faultPlans },
      );
      const body = Buffer.from('{"input":"review"}');

      const upstream = await relay.open({
        authorization: {
          grantId: grant.id,
          requestId,
          accountId: primary.id,
          workspaceId: grant.workspaceId,
          poolId: grant.poolId,
          runId: grant.authority.runId,
          runAttempt: grant.authority.runAttempt,
          model: grant.authority.model,
          accountUsable: true,
          grantExpiresAtMs: grant.budget.expiresAt.getTime(),
          declaredRequestBytes: body.byteLength,
          maxRequestBodyBytes: grant.budget.maxRequestBytes,
          maxResponseBytes: grant.budget.maxResponseBytes,
          maxOutputTokens: grant.budget.maxOutputTokens,
          faultPlanScope: faultScope(),
        },
        body: Readable.from([body]),
        contentType: "application/json",
        accept: "text/event-stream",
        abortSignal: new AbortController().signal,
      });
      for await (const chunk of upstream.body) {
        // Draining the disposable stream commits the response checkpoints.
        void chunk;
      }

      expect(upstream.statusCode).toBe(200);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(runtime.ensureFreshSession.mock.calls).toEqual([
        [
          expect.objectContaining({
            accountId: primary.id,
            runId: grant.authority.runId,
            attempt: grant.authority.runAttempt,
          }),
        ],
        [
          expect.objectContaining({
            accountId: backup.id,
            runId: grant.authority.runId,
            attempt: grant.authority.runAttempt,
          }),
        ],
      ]);
      expect(
        faultPlans.consume.mock.calls.map(([scope]) => ({
          attemptOrdinal: scope.attemptOrdinal,
          injectionPoint: scope.injectionPoint,
        })),
      ).toEqual([
        { attemptOrdinal: 1, injectionPoint: "before_provider_fetch" },
        { attemptOrdinal: 2, injectionPoint: "before_provider_fetch" },
        { attemptOrdinal: 2, injectionPoint: "after_response_started" },
      ]);
      expect(fetchImpl.mock.calls.map((call) => call[1]?.headers)).toEqual([
        expect.objectContaining({
          authorization: `Bearer access-${primary.id}`,
        }),
        expect.objectContaining({
          authorization: `Bearer access-${backup.id}`,
        }),
      ]);
      expect(failedAccount).toMatchObject({
        id: primary.id,
        availability:
          expectedReason === "rate_limited"
            ? {
                status: "cooldown",
                reason: expectedReason,
                until: new Date("2026-08-16T12:15:00.000Z"),
              }
            : { status: "quarantined", reason: expectedReason },
      });
      expect(grant).toMatchObject({
        activeAccountId: backup.id,
        failoverCount: 1,
        successfulProviderResponseRecorded: true,
        inFlightRequestIds: [],
      });
      expect(requestHashes).toEqual([sha256(body)]);
      expect(checkpoints).toEqual([
        "request_hash",
        "capacity_failover",
        "response_started",
        "request_completed",
      ]);
      expect(ledger.failover).toHaveBeenCalledTimes(1);
    },
  );

  it("never falls back to ordinary failure when response-start persistence fails after dispatch", async () => {
    const primary = account("post-dispatch", 0);
    const grant = admittedGrant(primary, account("unused-backup", 1));
    const ledger = {
      recordRequestHash: vi.fn(async () => undefined),
      markStarted: vi.fn(async () => {
        throw new Error("response-start-persistence-failed");
      }),
      terminalizeUnknown: vi.fn(async () => undefined),
      complete: vi.fn(async () => grant),
    };
    const effects = effectLedgerFixture();
    const relay = new FetchHostedCodexStreamingRelay(
      runtimeFixture() as never,
      ledger as never,
      vi.fn(
        async () => new Response("accepted", { status: 200 }),
      ) as typeof fetch,
      { failoverEnabled: false, now: () => now, effects },
    );
    const body = Buffer.from('{"input":"review"}');
    await expect(
      relay.open({
        authorization: authorization(grant, primary, body.byteLength),
        body: Readable.from(body),
        contentType: "application/json",
        accept: "text/event-stream",
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow("response-start-persistence-failed");
    expect(ledger.terminalizeUnknown).toHaveBeenCalledTimes(1);
    expect(ledger.complete).not.toHaveBeenCalled();
  });

  it("never generic-completes while an earlier reservation remains unresolved", async () => {
    const primary = account("reservation-deferred", 0);
    const grant = admittedGrant(primary, account("reservation-backup", 1));
    const ledger = {
      recordRequestHash: vi.fn(async () => undefined),
      ensureRequestHash: vi.fn(async () => undefined),
      complete: vi.fn(async () => grant),
    };
    const effects = effectLedgerFixture();
    effects.prepare.mockRejectedValueOnce(
      new HostedCodexEffectReservationDeferredError(),
    );
    const fetchImpl = vi.fn<typeof fetch>();
    const relay = new FetchHostedCodexStreamingRelay(
      runtimeFixture() as never,
      ledger as never,
      fetchImpl,
      { failoverEnabled: false, now: () => now, effects },
    );
    const body = Buffer.from('{"input":"review"}');
    await expect(
      relay.open({
        authorization: authorization(grant, primary, body.byteLength),
        body: Readable.from(body),
        contentType: "application/json",
        accept: "text/event-stream",
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow("hosted_codex_effect_reservation_deferred");
    expect(ledger.complete).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    { label: "absent", clientValue: undefined, expected: 1_024 },
    { label: "lower", clientValue: 128, expected: 128 },
    { label: "equal", clientValue: 1_024, expected: 1_024 },
    { label: "higher", clientValue: 8_192, expected: 1_024 },
  ])(
    "clamps $label client max_output_tokens without raising caller spend",
    async ({ clientValue, expected }) => {
      const primary = account(`token-clamp-${expected}`, 0);
      let grant = admittedGrant(primary, account("token-clamp-backup", 1));
      const ledger = {
        recordRequestHash: vi.fn(async () => undefined),
        markStarted: vi.fn(async (input: any) => {
          grant = input.transition(grant);
          return grant;
        }),
        complete: vi.fn(async (input: any) => {
          grant = input.transition(grant);
          return grant;
        }),
        terminalizeUnknown: vi.fn(async () => undefined),
      };
      let capturedProviderBody: Uint8Array | undefined;
      let providerRequest: Record<string, unknown> | undefined;
      const fetchImpl = vi.fn(
        async (_url: string | URL, init?: RequestInit) => {
          capturedProviderBody = init?.body as Uint8Array;
          providerRequest = JSON.parse(
            Buffer.from(capturedProviderBody).toString("utf8"),
          ) as Record<string, unknown>;
          return new Response("complete", { status: 200 });
        },
      ) as unknown as typeof fetch;
      const relay = new FetchHostedCodexStreamingRelay(
        runtimeFixture() as never,
        ledger as never,
        fetchImpl,
        {
          failoverEnabled: true,
          now: () => now,
          effects: effectLedgerFixture(),
        },
      );
      const requestBody: Record<string, unknown> = {
        input: "token clamp",
        model: "caller-model-must-be-overwritten",
        store: true,
      };
      if (clientValue !== undefined) {
        requestBody.max_output_tokens = clientValue;
      }
      const body = Buffer.from(JSON.stringify(requestBody));
      const response = await relay.open({
        authorization: authorization(grant, primary, body.byteLength),
        body: Readable.from(body),
        contentType: "application/json",
        accept: "text/event-stream",
        abortSignal: new AbortController().signal,
      });
      expect(providerRequest).toMatchObject({
        input: "token clamp",
        model: grant.authority.model,
        store: false,
        max_output_tokens: expected,
      });
      expect(capturedProviderBody).toBeDefined();
      expect(capturedProviderBody!.every((byte) => byte === 0)).toBe(true);
      for await (const chunk of response.body) void chunk;
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(ledger.terminalizeUnknown).not.toHaveBeenCalled();
    },
  );

  it.each([0, -1, 1.5, "1024", null, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid client max_output_tokens %s before provider dispatch",
    async (clientValue) => {
      const primary = account("invalid-token-limit", 0);
      let grant = admittedGrant(primary, account("invalid-limit-backup", 1));
      const ledger = {
        recordRequestHash: vi.fn(async () => undefined),
        ensureRequestHash: vi.fn(async () => undefined),
        complete: vi.fn(async (input: any) => {
          grant = input.transition(grant);
          return grant;
        }),
      };
      const effects = effectLedgerFixture();
      const fetchImpl = vi.fn<typeof fetch>();
      const relay = new FetchHostedCodexStreamingRelay(
        runtimeFixture() as never,
        ledger as never,
        fetchImpl,
        { failoverEnabled: true, now: () => now, effects },
      );
      const body = Buffer.from(
        JSON.stringify({
          input: "invalid limit",
          max_output_tokens: clientValue,
        }),
      );
      await expect(
        relay.open({
          authorization: authorization(grant, primary, body.byteLength),
          body: Readable.from(body),
          contentType: "application/json",
          accept: "text/event-stream",
          abortSignal: new AbortController().signal,
        }),
      ).rejects.toThrow("hosted_relay_max_output_tokens_invalid");
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(effects.prepare).not.toHaveBeenCalled();
      expect(ledger.complete).toHaveBeenCalledOnce();
    },
  );

  it("cancels the upstream source and terminalizes without failover at the response byte boundary", async () => {
    const primary = account("response-byte-limit", 0);
    let grant = admittedGrant(primary, account("response-limit-backup", 1));
    let releaseTerminalPersistence!: () => void;
    const terminalPersistence = new Promise<void>((resolve) => {
      releaseTerminalPersistence = resolve;
    });
    const ledger = {
      recordRequestHash: vi.fn(async () => undefined),
      markStarted: vi.fn(async (input: any) => {
        grant = input.transition(grant);
        return grant;
      }),
      failover: vi.fn(),
      complete: vi.fn(),
      terminalizeUnknown: vi.fn(async () => terminalPersistence),
    };
    let pull = 0;
    let cancelled = false;
    const upstreamBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(
          pull++ === 0 ? Buffer.from("1234") : Buffer.from("overflow"),
        );
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(
      async () => new Response(upstreamBody, { status: 200 }),
    ) as unknown as typeof fetch;
    const relay = new FetchHostedCodexStreamingRelay(
      runtimeFixture() as never,
      ledger as never,
      fetchImpl,
      {
        failoverEnabled: true,
        now: () => now,
        effects: effectLedgerFixture(),
      },
    );
    const body = Buffer.from('{"input":"response limit"}');
    const response = await relay.open({
      authorization: {
        ...authorization(grant, primary, body.byteLength),
        maxResponseBytes: 4,
      },
      body: Readable.from(body),
      contentType: "application/json",
      accept: "text/event-stream",
      abortSignal: new AbortController().signal,
    });
    let observed = "";
    const consumeResponse = (async () => {
      for await (const chunk of response.body) observed += chunk.toString();
    })();
    await vi.waitFor(() => expect(cancelled).toBe(true));
    expect(ledger.terminalizeUnknown).toHaveBeenCalledOnce();
    releaseTerminalPersistence();
    await expect(consumeResponse).rejects.toThrow(
      "hosted_codex_provider_response_bytes_exceeded",
    );
    expect(observed).toBe("1234");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(ledger.failover).not.toHaveBeenCalled();
    expect(ledger.complete).not.toHaveBeenCalled();
    expect(ledger.terminalizeUnknown).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "provider_response_bytes_exceeded",
      }),
    );
  });

  it("keeps heartbeating after headers until the response body completes", async () => {
    const primary = account("stream-heartbeat", 0);
    const grant = admittedGrant(primary, account("stream-backup", 1));
    let current = grant;
    const ledger = {
      recordRequestHash: vi.fn(async () => undefined),
      markStarted: vi.fn(
        async (input: {
          transition: (grant: InvocationGrant) => InvocationGrant;
        }) => (current = input.transition(current)),
      ),
      complete: vi.fn(
        async (input: {
          transition: (grant: InvocationGrant) => InvocationGrant;
        }) => (current = input.transition(current)),
      ),
      terminalizeUnknown: vi.fn(async () => undefined),
    };
    const effects = effectLedgerFixture();
    let emitted = false;
    const upstreamBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (emitted) {
          controller.close();
          return;
        }
        emitted = true;
        await new Promise((resolve) => setTimeout(resolve, 35));
        controller.enqueue(Buffer.from("streamed"));
      },
    });
    const relay = new FetchHostedCodexStreamingRelay(
      runtimeFixture() as never,
      ledger as never,
      vi.fn(
        async () => new Response(upstreamBody, { status: 200 }),
      ) as typeof fetch,
      {
        failoverEnabled: false,
        now: () => now,
        heartbeatIntervalMs: 5,
        effects,
      },
    );
    const body = Buffer.from('{"input":"review"}');
    const response = await relay.open({
      authorization: authorization(grant, primary, body.byteLength),
      body: Readable.from(body),
      contentType: "application/json",
      accept: "text/event-stream",
      abortSignal: new AbortController().signal,
    });
    for await (const chunk of response.body) void chunk;
    expect(effects.heartbeat.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(ledger.complete).toHaveBeenCalledTimes(1);
    expect(ledger.terminalizeUnknown).not.toHaveBeenCalled();
  });

  it("terminalizes when successful stream completion cannot be persisted", async () => {
    const primary = account("completion-persistence", 0);
    const grant = admittedGrant(primary, account("completion-backup", 1));
    const ledger = {
      recordRequestHash: vi.fn(async () => undefined),
      markStarted: vi.fn(async () => grant),
      complete: vi.fn(async () => {
        throw new Error("completion-persistence-failed");
      }),
      terminalizeUnknown: vi.fn(async () => undefined),
    };
    const effects = effectLedgerFixture();
    const relay = new FetchHostedCodexStreamingRelay(
      runtimeFixture() as never,
      ledger as never,
      vi.fn(
        async () => new Response("complete", { status: 200 }),
      ) as typeof fetch,
      { failoverEnabled: false, now: () => now, effects },
    );
    const body = Buffer.from('{"input":"review"}');
    const response = await relay.open({
      authorization: authorization(grant, primary, body.byteLength),
      body: Readable.from(body),
      contentType: "application/json",
      accept: "text/event-stream",
      abortSignal: new AbortController().signal,
    });
    let streamError: unknown;
    try {
      for await (const chunk of response.body) void chunk;
    } catch (error) {
      streamError = error;
    }
    expect(streamError).toBeInstanceOf(Error);
    expect(ledger.terminalizeUnknown).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      status: 401,
      fault: "synthetic_unauthorized" as const,
    },
    {
      status: 429,
      fault: "synthetic_rate_limited" as const,
    },
  ])(
    "reserves and closes a synthetic $status attempt before one backup effect",
    async ({ fault }) => {
      const primary = account("fault-primary", 0);
      const backup = account("fault-backup", 1);
      let grant = admittedGrant(primary, backup);
      const ledger = {
        recordRequestHash: vi.fn(async () => undefined),
        failover: vi.fn(async (input: any) => {
          expect(input.effect).toMatchObject({
            sourceState: "prepared",
            terminalState: "failed_no_effect",
          });
          const result = input.transition(grant, primary, backup);
          if (result.status === "switched") grant = result.grant;
          return result;
        }),
        markStarted: vi.fn(async (input: any) => {
          grant = input.transition(grant);
          return grant;
        }),
        complete: vi.fn(async (input: any) => {
          grant = input.transition(grant);
          return grant;
        }),
      };
      const faultPlans = {
        consume: vi.fn().mockResolvedValueOnce(fault).mockResolvedValue(null),
      };
      const fetchImpl = vi.fn(
        async () => new Response("complete", { status: 200 }),
      ) as unknown as typeof fetch;
      const body = Buffer.from('{"input":"review"}');
      const effects = effectLedgerFixture();
      const relay = new FetchHostedCodexStreamingRelay(
        runtimeFixture() as never,
        ledger as never,
        fetchImpl,
        {
          failoverEnabled: true,
          now: () => now,
          effects,
          faultPlans,
        },
      );
      const response = await relay.open({
        authorization: {
          ...authorization(grant, primary, body.byteLength),
          faultPlanScope: faultScope(),
        },
        body: Readable.from(body),
        contentType: "application/json",
        accept: "text/event-stream",
        abortSignal: new AbortController().signal,
      });
      for await (const chunk of response.body) void chunk;
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(ledger.failover).toHaveBeenCalledTimes(1);
      expect(grant.activeAccountId).toBe(backup.id);
      expect(effects.prepare).toHaveBeenCalledTimes(2);
      expect(effects.prepare).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: backup.id }),
      );
      expect(effects.prepare).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: primary.id }),
      );
      expect(faultPlans.consume).toHaveBeenCalledTimes(3);
      expect(effects.prepare.mock.invocationCallOrder[0]).toBeLessThan(
        faultPlans.consume.mock.invocationCallOrder[0]!,
      );
      expect(
        faultPlans.consume.mock.calls.map(([scope]) => scope.attemptOrdinal),
      ).toEqual([1, 2, 2]);
    },
  );

  it("fails closed before backup fetch when a consumed fault remains non-null", async () => {
    const primary = account("replayed-fault-primary", 0);
    const backup = account("replayed-fault-backup", 1);
    let grant = admittedGrant(primary, backup);
    const ledger = {
      recordRequestHash: vi.fn(async () => undefined),
      ensureRequestHash: vi.fn(async () => undefined),
      failover: vi.fn(async (input: any) => {
        const result = input.transition(grant, primary, backup);
        if (result.status === "switched") grant = result.grant;
        return result;
      }),
      complete: vi.fn(async (input: any) => {
        grant = input.transition(grant);
        return grant;
      }),
    };
    const faultPlans = {
      consume: vi.fn(async () => "synthetic_unauthorized" as const),
    };
    const fetchImpl = vi.fn(
      async () => new Response("complete", { status: 200 }),
    ) as unknown as typeof fetch;
    const body = Buffer.from('{"input":"review"}');
    const effects = effectLedgerFixture();
    const relay = new FetchHostedCodexStreamingRelay(
      runtimeFixture() as never,
      ledger as never,
      fetchImpl,
      {
        failoverEnabled: true,
        now: () => now,
        effects,
        faultPlans,
      },
    );

    await expect(
      relay.open({
        authorization: {
          ...authorization(grant, primary, body.byteLength),
          faultPlanScope: faultScope(),
        },
        body: Readable.from(body),
        contentType: "application/json",
        accept: "text/event-stream",
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow("hosted_codex_canary_fault_plan_not_one_shot");
    expect(faultPlans.consume).toHaveBeenCalledTimes(2);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(effects.prepare).toHaveBeenCalledTimes(2);
    expect(ledger.complete).toHaveBeenCalledTimes(1);
  });

  it("drops only after one real dispatch and response-start evidence", async () => {
    const primary = account("drop-primary", 0);
    const grant = admittedGrant(primary, account("drop-backup", 1));
    const checkpoints: string[] = [];
    const ledger = {
      recordRequestHash: vi.fn(async () => undefined),
      markStarted: vi.fn(async () => checkpoints.push("response_started")),
      terminalizeUnknown: vi.fn(async () =>
        checkpoints.push("terminal_unknown"),
      ),
      complete: vi.fn(),
    };
    const faultPlans = {
      consume: vi.fn(async (scope: { injectionPoint: string }) =>
        scope.injectionPoint === "after_response_started"
          ? ("drop_after_response_started" as const)
          : null,
      ),
    };
    const fetchImpl = vi.fn(async () => {
      checkpoints.push("provider_dispatched");
      return new Response("must-not-stream", { status: 200 });
    }) as unknown as typeof fetch;
    const body = Buffer.from('{"input":"review"}');
    const relay = new FetchHostedCodexStreamingRelay(
      runtimeFixture() as never,
      ledger as never,
      fetchImpl,
      {
        failoverEnabled: true,
        now: () => now,
        effects: effectLedgerFixture(),
        faultPlans,
      },
    );
    await expect(
      relay.open({
        authorization: {
          ...authorization(grant, primary, body.byteLength),
          faultPlanScope: faultScope(),
        },
        body: Readable.from(body),
        contentType: "application/json",
        accept: "text/event-stream",
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow("hosted_codex_canary_dropped_response");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(checkpoints).toEqual([
      "provider_dispatched",
      "response_started",
      "terminal_unknown",
    ]);
    expect(ledger.terminalizeUnknown).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "ambiguous_dropped_response",
        effect: expect.objectContaining({ terminalState: "terminal_unknown" }),
      }),
    );
    expect(ledger.complete).not.toHaveBeenCalled();
  });

  it("re-resolves the session when credential generation changes before reservation", async () => {
    const primary = account("generation-race-primary", 0);
    let grant = admittedGrant(primary, account("generation-race-backup", 1));
    const ledger = {
      recordRequestHash: vi.fn(async () => undefined),
      markStarted: vi.fn(async (input: any) => {
        grant = input.transition(grant);
        return grant;
      }),
      complete: vi.fn(async (input: any) => {
        grant = input.transition(grant);
        return grant;
      }),
    };
    const runtime = runtimeFixture();
    runtime.ensureFreshSession
      .mockResolvedValueOnce({
        accessToken: "generation-one-token",
        chatgptAccountId: "unit-account",
        credentialGeneration: 1,
      })
      .mockResolvedValueOnce({
        accessToken: "generation-two-token",
        chatgptAccountId: "unit-account",
        credentialGeneration: 2,
      });
    const effects = effectLedgerFixture();
    effects.prepare
      .mockRejectedValueOnce(new HostedCodexCredentialGenerationChangedError())
      .mockResolvedValueOnce({
        attemptId: "generation-two-attempt",
        attemptOrdinal: 1,
        ownerToken: "generation-two-owner",
        fenceEpoch: 1n,
        accountId: primary.id,
        credentialGeneration: 2,
      });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('data: {"type":"response.completed"}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const body = Buffer.from('{"input":"review"}');
    const relay = new FetchHostedCodexStreamingRelay(
      runtime as never,
      ledger as never,
      fetchImpl,
      { failoverEnabled: true, now: () => now, effects },
    );

    const response = await relay.open({
      authorization: authorization(grant, primary, body.byteLength),
      body: Readable.from(body),
      contentType: "application/json",
      accept: "text/event-stream",
      abortSignal: new AbortController().signal,
    });
    for await (const chunk of response.body) void chunk;

    expect(runtime.ensureFreshSession).toHaveBeenCalledTimes(2);
    expect(
      effects.prepare.mock.calls.map(([input]) => input.credentialGeneration),
    ).toEqual([1, 2]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual(
      expect.objectContaining({ authorization: "Bearer generation-two-token" }),
    );
  });

  it("does not refresh or dispatch after the live runtime gate closes", async () => {
    const primary = account("gate-primary", 0);
    const grant = admittedGrant(primary, account("gate-backup", 1));
    const ledger = {
      recordRequestHash: vi.fn(async () => undefined),
      ensureRequestHash: vi.fn(async () => undefined),
      complete: vi.fn(async () => grant),
    };
    const runtime = runtimeFixture();
    const effects = effectLedgerFixture();
    effects.assertLiveAuthority.mockRejectedValueOnce(
      new Error("hosted_codex_effect_authority_revoked"),
    );
    const fetchMock = vi.fn<typeof fetch>();
    const body = Buffer.from('{"input":"review"}');
    const relay = new FetchHostedCodexStreamingRelay(
      runtime as never,
      ledger as never,
      fetchMock as unknown as typeof fetch,
      { failoverEnabled: true, now: () => now, effects },
    );

    await expect(
      relay.open({
        authorization: authorization(grant, primary, body.byteLength),
        body: Readable.from(body),
        contentType: "application/json",
        accept: "text/event-stream",
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow("hosted_codex_effect_authority_revoked");
    expect(runtime.ensureFreshSession).not.toHaveBeenCalled();
    expect(effects.prepare).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function runtimeFixture() {
  return {
    ensureFreshSession: vi.fn(async () => ({
      accessToken: "unit-access",
      chatgptAccountId: "unit-account",
      credentialGeneration: 1,
    })),
    classifyFailure: vi.fn(() => ({ code: "unknown" })),
  };
}

function effectLedgerFixture() {
  let attemptOrdinal = 0;
  return {
    assertLiveAuthority: vi.fn(async () => undefined),
    prepare: vi.fn(
      async ({
        accountId,
        credentialGeneration,
      }: {
        accountId?: string;
        credentialGeneration: number;
      }) => {
        attemptOrdinal += 1;
        return {
          attemptId: `unit-effect-attempt-${attemptOrdinal}`,
          attemptOrdinal,
          ownerToken: `unit-effect-owner-${attemptOrdinal}`,
          fenceEpoch: BigInt(attemptOrdinal),
          accountId: accountId ?? "post-dispatch",
          credentialGeneration,
        };
      },
    ),
    markDispatching: vi.fn(async () => undefined),
    heartbeat: vi.fn(async () => undefined),
    markResponseStarted: vi.fn(async () => undefined),
    authority: vi.fn((lease: HostedCodexUpstreamEffectLease) => ({
      attemptId: lease.attemptId,
      ownerIdHash: sha256(Buffer.from(lease.ownerToken)),
      fenceEpoch: lease.fenceEpoch,
    })),
  };
}

function authorization(
  grant: InvocationGrant,
  primary: HostedPoolAccount,
  requestBytes: number,
) {
  return {
    grantId: grant.id,
    requestId,
    accountId: primary.id,
    workspaceId: grant.workspaceId,
    poolId: grant.poolId,
    runId: grant.authority.runId,
    runAttempt: grant.authority.runAttempt,
    model: grant.authority.model,
    accountUsable: true,
    grantExpiresAtMs: grant.budget.expiresAt.getTime(),
    declaredRequestBytes: requestBytes,
    maxRequestBodyBytes: grant.budget.maxRequestBytes,
    maxResponseBytes: grant.budget.maxResponseBytes,
    maxOutputTokens: grant.budget.maxOutputTokens,
  };
}

function faultScope() {
  return {
    workspaceId: "workspace-1",
    githubRepositoryId: 123456789n,
    actionRef: `777genius/review-router@${"a".repeat(40)}`,
    repositoryBindingId: "binding-1",
    bindingRevision: 1n,
    requestOrdinal: 1,
  };
}

function admittedGrant(
  primary: HostedPoolAccount,
  backup: HostedPoolAccount,
): InvocationGrant {
  const grant = issueInvocationGrant({
    id: invocationGrantId("grant-capacity-1"),
    invocationId: invocationId("invocation-capacity-1"),
    repositoryId: repositoryId("repository-1"),
    workspaceId: workspaceId("workspace-1"),
    poolId: hostedPoolId("pool-1"),
    accounts: [primary, backup],
    authority: {
      repositoryBindingId: hostedBindingId("binding-1"),
      reviewRequestId: "review-request-1",
      providerInvocationKey: "provider-invocation-1",
      runId: "run-1",
      runAttempt: 1,
      model: "gpt-5.6",
      policyFingerprint: "sha256:policy",
      runtimeConfigVersion: 1,
      bindingRevision: 1,
      authzEpoch: 1n,
    },
    runtimeAuthzEpoch: 1n,
    capabilityTokenHash: "sha256:fixture-capability-token-hash",
    commentTokenRefreshCapability: {
      tokenHash: "sha256:fixture-comment-refresh-hash",
      grantId: invocationGrantId("grant-capacity-1"),
      invocationId: invocationId("invocation-capacity-1"),
      repositoryBindingId: hostedBindingId("binding-1"),
      expiresAt: new Date("2026-08-16T12:30:00.000Z"),
      maxUses: 1,
      useCount: 0,
      revokedAt: null,
    },
    budget: {
      expiresAt: new Date("2026-08-16T13:00:00.000Z"),
      maxRequests: 2,
      maxConcurrentRequests: 1,
      maxRequestBytes: 1024,
      maxResponseBytes: 4096,
      maxOutputTokens: 1024,
    },
    now,
  });
  const admission = admitRelayRequest({
    grant,
    requestId,
    authority: grant.authority,
    requestBytes: 18,
    now,
  });
  if (admission.status !== "admitted") {
    throw new Error(`test_relay_admission_failed:${admission.status}`);
  }
  return admission.grant;
}

function account(id: string, priority: number): HostedPoolAccount {
  return enrollHostedPoolAccount({
    id: hostedAccountId(id),
    poolId: hostedPoolId("pool-1"),
    label: `Account ${id}`,
    priority,
    credential: {
      credentialRef: `ar:credential:${id}:1`,
      subjectFingerprint: `subject-${id}`,
      authGeneration: 1,
      validatedAt: now,
      expiresAt: new Date("2026-08-17T12:00:00.000Z"),
    },
    now,
  });
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
