import { describe, expect, it } from "vitest";
import {
  AbandonContextGatewaySession,
  AbandonContextGatewaySessionStatus,
  ContextAttestationPersistenceStatus,
  ContextLeaseAuthorityKind,
  ContextProviderKind,
  GatewaySessionState,
  activateGatewaySession,
  expireGatewaySession,
  openGatewaySession,
  revokeGatewaySession,
  sealGatewaySession,
  type ContextAttestationStorePort,
  type GatewaySession,
  type TrustedGatewaySessionAbandonFacts,
} from "../index";
import { InMemoryContextAttestationStore } from "../testing";

describe("context gateway session abandonment", () => {
  it("revokes an active session and treats a repeated command as idempotent", async () => {
    const store = new InMemoryContextAttestationStore();
    const session = activeSession();
    await store.openSession(session);
    const abandon = useCase(store, session, 2_000);

    await expect(execute(abandon, session)).resolves.toMatchObject({
      status: AbandonContextGatewaySessionStatus.Abandoned,
      session: {
        state: GatewaySessionState.Revoked,
        revokedAtMs: 2_000,
      },
    });
    await expect(execute(abandon, session)).resolves.toMatchObject({
      status: AbandonContextGatewaySessionStatus.Idempotent,
      session: { state: GatewaySessionState.Revoked },
    });
  });

  it.each([
    GatewaySessionState.Opened,
    GatewaySessionState.Active,
    GatewaySessionState.Sealed,
  ])("revokes a nonterminal %s session", async (state) => {
    const store = new InMemoryContextAttestationStore();
    const session = sessionInState(state);
    await store.openSession(session);

    await expect(
      execute(useCase(store, session, 2_000), session),
    ).resolves.toMatchObject({
      status: AbandonContextGatewaySessionStatus.Abandoned,
      session: { state: GatewaySessionState.Revoked },
    });
  });

  it("persists expiration instead of revocation after the deadline", async () => {
    const store = new InMemoryContextAttestationStore();
    const session = activeSession();
    await store.openSession(session);

    await expect(
      execute(useCase(store, session, session.expiresAtMs), session),
    ).resolves.toMatchObject({
      status: AbandonContextGatewaySessionStatus.Expired,
      session: {
        state: GatewaySessionState.Expired,
        revokedAtMs: session.expiresAtMs,
      },
    });
    await expect(store.findSession(session.sessionId)).resolves.toMatchObject({
      state: GatewaySessionState.Expired,
    });
  });

  it.each([GatewaySessionState.Accepted, GatewaySessionState.Rejected])(
    "does not mutate an already-terminal %s session",
    async (state) => {
      const session = Object.freeze({ ...activeSession(), state });
      const store = terminalStore(session);
      await expect(
        execute(useCase(store, session, 2_000), session),
      ).resolves.toEqual({
        status: AbandonContextGatewaySessionStatus.AlreadyTerminal,
        session,
      });
    },
  );

  it("denies an untrusted or stale session binding", async () => {
    const store = new InMemoryContextAttestationStore();
    const session = activeSession();
    await store.openSession(session);
    const facts = abandonFacts(session);
    const abandon = new AbandonContextGatewaySession({
      abandonFacts: {
        resolveAbandonFacts: async () => ({
          ...facts,
          sourceFencingToken: "2",
        }),
      },
      store,
      clock: { nowMs: () => 2_000 },
    });

    await expect(execute(abandon, session)).resolves.toEqual({
      status: AbandonContextGatewaySessionStatus.Denied,
      session: null,
    });
    await expect(store.findSession(session.sessionId)).resolves.toMatchObject({
      state: GatewaySessionState.Active,
    });
  });

  it("reports a persistence race as conflict", async () => {
    const session = activeSession();
    const store = {
      findSession: async () => session,
      abandonSession: async () => ({
        status: ContextAttestationPersistenceStatus.Conflict,
      }),
    } as unknown as ContextAttestationStorePort;

    await expect(
      execute(useCase(store, session, 2_000), session),
    ).resolves.toEqual({
      status: AbandonContextGatewaySessionStatus.Conflict,
      session: null,
    });
  });

  it("rejects a stale persistence snapshot even when its transition is valid", async () => {
    const store = new InMemoryContextAttestationStore();
    const session = activeSession();
    await store.openSession(session);
    const stale = Object.freeze({
      ...session,
      openedAtMs: session.openedAtMs + 1,
      expiresAtMs: session.expiresAtMs + 1,
    });

    await expect(
      store.abandonSession({
        expectedSession: stale,
        terminalSession: revokeGatewaySession(stale, 2_000),
      }),
    ).resolves.toEqual({
      status: ContextAttestationPersistenceStatus.Conflict,
    });
  });

  it("enforces revoke and expire time boundaries in the aggregate", () => {
    const session = activeSession();
    expect(() => revokeGatewaySession(session, session.expiresAtMs)).toThrow(
      "gateway_session_expired",
    );
    expect(() =>
      expireGatewaySession(session, session.expiresAtMs - 1),
    ).toThrow("gateway_session_not_expired");
    expect(expireGatewaySession(session, session.expiresAtMs)).toMatchObject({
      state: GatewaySessionState.Expired,
    });
  });
});

function useCase(
  store: ContextAttestationStorePort,
  session: GatewaySession,
  nowMs: number,
): AbandonContextGatewaySession {
  return new AbandonContextGatewaySession({
    abandonFacts: {
      resolveAbandonFacts: async () => abandonFacts(session),
    },
    store,
    clock: { nowMs: () => nowMs },
  });
}

function execute(
  useCase: AbandonContextGatewaySession,
  session: GatewaySession,
) {
  return useCase.execute({
    sessionId: session.sessionId,
    capabilityId: "capability-1",
  });
}

function abandonFacts(
  session: GatewaySession,
): TrustedGatewaySessionAbandonFacts {
  return {
    sessionId: session.sessionId,
    attemptId: session.attemptId,
    sourceLeaseAuthorityKind: session.sourceLeaseAuthorityKind,
    sourceLeaseId: session.sourceLeaseId,
    sourceFencingToken: session.sourceFencingToken,
  };
}

function terminalStore(session: GatewaySession): ContextAttestationStorePort {
  return {
    findSession: async () => session,
    abandonSession: async () => {
      throw new Error("terminal_session_must_not_be_mutated");
    },
  } as unknown as ContextAttestationStorePort;
}

function sessionInState(state: GatewaySessionState): GatewaySession {
  const opened = openSession();
  if (state === GatewaySessionState.Opened) return opened;
  const active = activateGatewaySession(opened, 1_001);
  if (state === GatewaySessionState.Active) return active;
  return sealGatewaySession(active, { eventCount: 1, sealedAtMs: 1_002 });
}

function activeSession(): GatewaySession {
  return activateGatewaySession(openSession(), 1_001);
}

function openSession(): GatewaySession {
  return openGatewaySession({
    sessionId: "gateway-session-1",
    scope: {
      workspaceId: "workspace-1",
      repositoryConnectionId: "connection-1",
      scmRepositoryIdentityId: "repository-1",
      pullRequestNumber: 42,
    },
    sourceRevision: {
      baseSha: "a".repeat(40),
      mergeBaseSha: "b".repeat(40),
      headSha: "c".repeat(40),
      reviewRevisionHash: "d".repeat(64),
      checkoutTreeOid: "e".repeat(40),
    },
    sourceExecutionId: "execution-1",
    sourceWorkSlotId: "slot-1",
    attemptId: "attempt-1",
    openingIntentHash: "f".repeat(64),
    sourceLeaseAuthorityKind: ContextLeaseAuthorityKind.InvestigationShadow,
    sourceLeaseId: "lease-1",
    sourceFencingToken: "1",
    providerKind: ContextProviderKind.Codex,
    requestedModel: "gpt-test",
    trustedCapabilityProfile: "context-gateway-v2",
    gatewayBinaryHash: "1".repeat(64),
    gatewayPolicyVersion: "context-gateway-v2",
    producerReleaseId: "release-1",
    selectedProtocolVersion: "review-action-v2",
    confinementProofHash: "2".repeat(64),
    eventChainSeedHash: "3".repeat(64),
    openedAtMs: 1_000,
    expiresAtMs: 10_000,
  });
}
