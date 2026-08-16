import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  admitRelayRequest,
  enrollHostedPoolAccount,
  hostedAccountId,
  hostedBindingId,
  hostedPoolId,
  invocationGrantId,
  invocationId,
  issueInvocationGrant,
  relayRequestId,
  repositoryId,
  workspaceId,
  type CurrentRelayRequestFailover,
  type HostedPoolAccount,
  type InvocationGrant,
} from "../index";
import { FetchHostedCodexStreamingRelay } from "../infrastructure/http/prisma-hosted-codex-relay";

const now = new Date("2026-08-16T12:00:00.000Z");
const requestId = relayRequestId("request-capacity-1");

describe("hosted Codex quota failover", () => {
  it("cools down the failed account and continues the admitted request on its eligible backup", async () => {
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
          transition: (
            grant: InvocationGrant,
            failedAccount: HostedPoolAccount,
            backupAccount: HostedPoolAccount | null,
          ) => CurrentRelayRequestFailover;
        }) => {
          checkpoints.push("capacity_failover");
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
        }),
      ),
      classifyFailure: vi.fn(() => ({ code: "unknown" })),
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("quota", { status: 429 }))
      .mockResolvedValueOnce(
        new Response('data: {"type":"response.completed"}\n\n', {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
    const relay = new FetchHostedCodexStreamingRelay(
      runtime as never,
      ledger as never,
      fetchImpl,
      { failoverEnabled: true, now: () => now },
    );
    const body = Buffer.from('{"input":"review"}');

    const upstream = await relay.open({
      authorization: {
        grantId: grant.id,
        requestId,
        accountId: primary.id,
        runId: grant.authority.runId,
        runAttempt: grant.authority.runAttempt,
        model: grant.authority.model,
        accountUsable: true,
        grantExpiresAtMs: grant.budget.expiresAt.getTime(),
        declaredRequestBytes: body.byteLength,
        maxRequestBodyBytes: grant.budget.maxRequestBytes,
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
    expect(fetchImpl.mock.calls.map((call) => call[1]?.headers)).toEqual([
      expect.objectContaining({ authorization: `Bearer access-${primary.id}` }),
      expect.objectContaining({ authorization: `Bearer access-${backup.id}` }),
    ]);
    expect(failedAccount).toMatchObject({
      id: primary.id,
      availability: {
        status: "cooldown",
        reason: "rate_limited",
        until: new Date("2026-08-16T12:15:00.000Z"),
      },
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
  });
});

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
