import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { HostedPoolAccount } from "../domain/account-pool.js";
import {
  hostedAccountId,
  hostedBindingId,
  hostedPoolId,
  invocationGrantId,
  invocationId,
  relayRequestId,
  repositoryId,
  workspaceId,
} from "../domain/identifiers.js";
import {
  admitRelayRequest,
  issueInvocationGrant,
} from "../domain/invocation-grant.js";
import { FetchHostedCodexStreamingRelay } from "../infrastructure/http/prisma-hosted-codex-relay.js";
import type { PrismaInvocationGrantRepository } from "../infrastructure/prisma/prisma-invocation-grant-repository.js";
import {
  PrismaHostedCodexUpstreamEffectLedger,
  type HostedCodexUpstreamEffectLease,
} from "../infrastructure/prisma/prisma-hosted-codex-upstream-effect-ledger.js";
import type { HostedCodexSessionRuntime } from "../infrastructure/runtime/hosted-codex-session-runtime.js";

const now = new Date("2026-09-06T12:00:00.000Z");
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
type Ledger = PrismaInvocationGrantRepository;

// Synthetic ports retain and execute the actual application-supplied domain
// transitions; in particular, failover's required cooldown is never mocked out.
function fixture(
  primaryCode = "quota_limited",
  backupFailure?: "session" | "fetch" | "http429",
) {
  const poolId = hostedPoolId("synthetic-pool");
  const accounts: HostedPoolAccount[] = ["primary", "backup"].map(
    (id, priority) => ({
      id: hostedAccountId(id),
      poolId,
      label: id,
      priority,
      credential: {
        credentialRef: `synthetic-${id}`,
        subjectFingerprint: hash(id),
        authGeneration: 1,
        validatedAt: now,
        expiresAt: null,
      },
      availability: { status: "healthy" },
      healthVersion: 1,
      createdAt: now,
      updatedAt: now,
    }),
  );
  const id = invocationGrantId("synthetic-grant");
  const invocation = invocationId("synthetic-invocation");
  const binding = hostedBindingId("synthetic-binding");
  const requestId = relayRequestId("synthetic-request");
  const expiresAt = new Date(now.getTime() + 60_000);
  const body = JSON.stringify({ input: "synthetic request" });
  let grant = issueInvocationGrant({
    id,
    invocationId: invocation,
    repositoryId: repositoryId("synthetic-repo"),
    workspaceId: workspaceId("synthetic-workspace"),
    poolId,
    accounts,
    authority: {
      repositoryBindingId: binding,
      reviewRequestId: "review",
      providerInvocationKey: "invocation-key",
      runId: "run",
      runAttempt: 1,
      model: "gpt-6-astra",
      policyFingerprint: "synthetic-policy",
      runtimeConfigVersion: 1,
      bindingRevision: 1,
      authzEpoch: 1n,
    },
    runtimeAuthzEpoch: 1n,
    capabilityTokenHash: hash(randomUUID()),
    commentTokenRefreshCapability: {
      tokenHash: hash(randomUUID()),
      grantId: id,
      invocationId: invocation,
      repositoryBindingId: binding,
      expiresAt,
      maxUses: 1,
      useCount: 0,
      revokedAt: null,
    },
    budget: {
      expiresAt,
      maxRequests: 2,
      maxConcurrentRequests: 1,
      maxRequestBytes: 1024,
      maxResponseBytes: 1024,
      maxOutputTokens: 32,
    },
    now,
  });
  const admission = admitRelayRequest({
    grant,
    requestId,
    authority: grant.authority,
    requestBytes: Buffer.byteLength(body),
    now,
  });
  expect(admission.status).toBe("admitted");
  grant = admission.grant;
  const admittedGrant = grant;
  let primary = accounts[0]!;
  const ledger = {
    recordRequestHash: vi
      .fn<Ledger["recordRequestHash"]>()
      .mockResolvedValue(undefined),
    ensureRequestHash: vi
      .fn<Ledger["ensureRequestHash"]>()
      .mockResolvedValue(undefined),
    failover: vi.fn<Ledger["failover"]>(async (input) => {
      expect(input.grantId).toBe(id);
      expect(input.requestId).toBe(requestId);
      expect(input.now).toEqual(now);
      expect(input.effect).toBeUndefined();
      const result = input.transition(grant, primary, accounts[1]!);
      grant = result.grant;
      primary = result.failedAccount;
      return result;
    }),
    markStarted: vi.fn<Ledger["markStarted"]>(async (input) => {
      grant = input.transition(grant);
      return grant;
    }),
    complete: vi.fn<Ledger["complete"]>(async (input) => {
      grant = input.transition(grant);
      return grant;
    }),
    terminalizeUnknown: vi
      .fn<Ledger["terminalizeUnknown"]>()
      .mockResolvedValue(undefined),
  };
  const primaryError = new Error("synthetic primary session failure");
  const backupError = new Error("synthetic backup failure");
  const runtime = {
    ensureFreshSession: vi.fn(async ({ accountId }: { accountId: string }) => {
      if (accountId === "primary") throw primaryError;
      if (backupFailure === "session") throw backupError;
      return {
        accessToken: randomUUID(),
        chatgptAccountId: accountId,
        credentialGeneration: 1,
      };
    }),
    classifyFailure: vi.fn((error: unknown) => ({
      code: error === primaryError ? primaryCode : "quota_limited",
    })),
  };
  const lease: HostedCodexUpstreamEffectLease = {
    attemptId: "synthetic-effect",
    attemptOrdinal: 1,
    ownerToken: randomUUID(),
    fenceEpoch: 1n,
    accountId: "backup",
    credentialGeneration: 1,
  };
  const effects = {
    assertLiveAuthority: vi.fn(async () => {}),
    prepare: vi.fn(async () => lease),
    markDispatching: vi.fn(async () => {}),
    markResponseStarted: vi.fn(async () => {}),
    heartbeat: vi.fn(async () => {}),
    authority: PrismaHostedCodexUpstreamEffectLedger.prototype.authority,
  };
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe("backup");
    expect(
      JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)),
    ).toEqual({
      input: "synthetic request",
      model: "gpt-6-astra",
      store: false,
      max_output_tokens: 32,
    });
    if (backupFailure === "fetch") throw backupError;
    return new Response("synthetic response", {
      status: backupFailure === "http429" ? 429 : 200,
    });
  });
  const relay = new FetchHostedCodexStreamingRelay(
    runtime as unknown as HostedCodexSessionRuntime,
    ledger as unknown as Ledger,
    fetchImpl,
    { failoverEnabled: true, now: () => new Date(now), effects },
  );
  const authorization = {
    grantId: id,
    requestId,
    accountId: "primary",
    workspaceId: grant.workspaceId,
    poolId,
    runId: grant.authority.runId,
    runAttempt: grant.authority.runAttempt,
    model: grant.authority.model,
    accountUsable: true,
    grantExpiresAtMs: expiresAt.getTime(),
    declaredRequestBytes: Buffer.byteLength(body),
    maxRequestBodyBytes: 1024,
    maxResponseBytes: 1024,
    maxOutputTokens: 32,
  };
  return {
    open: () =>
      relay.open({
        authorization,
        body: Readable.from([body]),
        contentType: "application/json",
        accept: "text/event-stream",
        abortSignal: new AbortController().signal,
      }),
    ledger,
    runtime,
    effects,
    fetchImpl,
    primaryError,
    backupError,
    authorization,
    admittedGrant,
    grant: () => grant,
    primary: () => primary,
  };
}

async function consume(
  response: Awaited<ReturnType<ReturnType<typeof fixture>["open"]>>,
) {
  let text = "";
  for await (const chunk of response.body) text += chunk.toString();
  return text;
}

function expectSingleSwitch(f: ReturnType<typeof fixture>) {
  expect(f.ledger.failover).toHaveBeenCalledTimes(1);
  expect(f.grant()).toMatchObject({
    id: f.admittedGrant.id,
    activeAccountId: "backup",
    backupActivated: true,
    failoverCount: 1,
    admittedRequestIds: f.admittedGrant.admittedRequestIds,
  });
  expect(
    f.runtime.ensureFreshSession.mock.calls.map(([input]) => input.accountId),
  ).toEqual(["primary", "backup"]);
  expect(f.primary().availability).toEqual({
    status: "cooldown",
    reason: "rate_limited",
    until: new Date(now.getTime() + 15 * 60_000),
  });
}

describe("pre-session runtime quota failover", () => {
  it("cools down the primary for 15 minutes and dispatches the same request only on the backup", async () => {
    const f = fixture();
    const response = await f.open();
    expectSingleSwitch(f);
    expect(f.grant().inFlightRequestIds).toEqual(
      f.admittedGrant.inFlightRequestIds,
    );
    expect(f.grant().authority).toEqual(f.admittedGrant.authority);
    expect(f.grant().capabilityTokenHash).toBe(
      f.admittedGrant.capabilityTokenHash,
    );
    expect(f.effects.assertLiveAuthority.mock.calls).toHaveLength(2);
    expect(f.effects.prepare).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        accountId: "backup",
        grantId: f.authorization.grantId,
        relayRequestId: f.authorization.requestId,
      }),
    );
    expect(f.effects.markDispatching).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ accountId: "backup" }),
    );
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(200);
    expect(await consume(response)).toBe("synthetic response");
    expect(f.grant().successfulProviderResponseRecorded).toBe(true);
    expect(f.grant().inFlightRequestIds).toEqual([]);
    expect(f.ledger.complete).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        grantId: f.authorization.grantId,
        requestId: f.authorization.requestId,
        errorCode: null,
      }),
    );
    expect(f.ledger.terminalizeUnknown).not.toHaveBeenCalled();
  });

  it.each(["session", "fetch", "http429"] as const)(
    "does not fail over again after a backup %s failure",
    async (failure) => {
      const f = fixture("quota_limited", failure);
      if (failure === "http429") {
        const response = await f.open();
        expect(response.statusCode).toBe(429);
        await consume(response);
      } else {
        await expect(f.open()).rejects.toBe(f.backupError);
      }
      expectSingleSwitch(f);
      expect(f.fetchImpl).toHaveBeenCalledTimes(failure === "session" ? 0 : 1);
      expect(f.effects.prepare).toHaveBeenCalledTimes(
        failure === "session" ? 0 : 1,
      );
      if (failure !== "session") {
        expect(f.ledger.terminalizeUnknown).toHaveBeenCalledOnce();
        expect(f.ledger.complete).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["provider_session_invalid", "needs_reconnect"])(
    "preserves quarantine without cooldown for %s",
    async (code) => {
      const f = fixture(code);
      await consume(await f.open());
      expect(f.ledger.failover).toHaveBeenCalledOnce();
      expect(f.primary().availability).toEqual({
        status: "quarantined",
        reason:
          code === "provider_session_invalid" ? "credential_invalid" : code,
      });
      expect(f.fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it.each(["unknown", "transient_upstream", "credential_refresh_failed"])(
    "propagates %s without failover or provider effects",
    async (code) => {
      const f = fixture(code);
      await expect(f.open()).rejects.toBe(f.primaryError);
      expect(f.ledger.failover).not.toHaveBeenCalled();
      expect(f.runtime.ensureFreshSession).toHaveBeenCalledOnce();
      expect(f.effects.prepare).not.toHaveBeenCalled();
      expect(f.fetchImpl).not.toHaveBeenCalled();
      expect(f.primary().availability).toEqual({ status: "healthy" });
      expect(f.grant().failoverCount).toBe(0);
      expect(f.ledger.complete).toHaveBeenCalledOnce();
    },
  );
});
