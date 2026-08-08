import {
  GatewaySessionState,
  expireGatewaySession,
  revokeGatewaySession,
  type GatewaySession,
} from "../../domain/gateway-session";
import {
  ContextAttestationPersistenceStatus,
  type ContextAttestationClockPort,
  type ContextAttestationStorePort,
  type TrustedGatewaySessionAbandonFacts,
  type TrustedGatewaySessionAbandonFactsPort,
} from "../ports/context-attestation-ports";

export enum AbandonContextGatewaySessionStatus {
  Abandoned = "abandoned",
  Idempotent = "idempotent",
  AlreadyTerminal = "already_terminal",
  Expired = "expired",
  Denied = "denied",
  Conflict = "conflict",
}

export type AbandonContextGatewaySessionResult = Readonly<{
  status: AbandonContextGatewaySessionStatus;
  session: GatewaySession | null;
}>;

export class AbandonContextGatewaySession {
  constructor(
    private readonly dependencies: Readonly<{
      abandonFacts: TrustedGatewaySessionAbandonFactsPort;
      store: ContextAttestationStorePort;
      clock: ContextAttestationClockPort;
    }>,
  ) {}

  async execute(command: {
    readonly sessionId: string;
    readonly capabilityId: string;
  }): Promise<AbandonContextGatewaySessionResult> {
    const [session, facts] = await Promise.all([
      this.dependencies.store.findSession(command.sessionId),
      this.dependencies.abandonFacts.resolveAbandonFacts(command),
    ]);
    if (!session || !facts || !sameAbandonBinding(session, facts)) {
      return result(AbandonContextGatewaySessionStatus.Denied, null);
    }
    const terminalStatus = statusForTerminalSession(session);
    if (terminalStatus) return result(terminalStatus, session);

    const nowMs = this.dependencies.clock.nowMs();
    let terminalSession: GatewaySession;
    try {
      terminalSession =
        nowMs >= session.expiresAtMs
          ? expireGatewaySession(session, nowMs)
          : revokeGatewaySession(session, nowMs);
    } catch {
      return result(AbandonContextGatewaySessionStatus.Denied, null);
    }

    const persisted = await this.dependencies.store.abandonSession({
      expectedSession: session,
      terminalSession,
    });
    if (persisted.status === ContextAttestationPersistenceStatus.Conflict) {
      return result(AbandonContextGatewaySessionStatus.Conflict, null);
    }
    return result(
      statusForPersistedSession(persisted.value, persisted.status),
      persisted.value,
    );
  }
}

function sameAbandonBinding(
  session: GatewaySession,
  facts: TrustedGatewaySessionAbandonFacts,
): boolean {
  return (
    facts.sessionId === session.sessionId &&
    facts.attemptId === session.attemptId &&
    facts.sourceLeaseAuthorityKind === session.sourceLeaseAuthorityKind &&
    facts.sourceLeaseId === session.sourceLeaseId &&
    facts.sourceFencingToken === session.sourceFencingToken
  );
}

function statusForTerminalSession(
  session: GatewaySession,
): AbandonContextGatewaySessionStatus | null {
  switch (session.state) {
    case GatewaySessionState.Accepted:
    case GatewaySessionState.Rejected:
      return AbandonContextGatewaySessionStatus.AlreadyTerminal;
    case GatewaySessionState.Revoked:
      return AbandonContextGatewaySessionStatus.Idempotent;
    case GatewaySessionState.Expired:
      return AbandonContextGatewaySessionStatus.Expired;
    case GatewaySessionState.Opened:
    case GatewaySessionState.Active:
    case GatewaySessionState.Sealed:
      return null;
  }
}

function statusForPersistedSession(
  session: GatewaySession,
  persistenceStatus: ContextAttestationPersistenceStatus,
): AbandonContextGatewaySessionStatus {
  const terminal = statusForTerminalSession(session);
  if (terminal === AbandonContextGatewaySessionStatus.AlreadyTerminal) {
    return terminal;
  }
  if (session.state === GatewaySessionState.Expired) {
    return AbandonContextGatewaySessionStatus.Expired;
  }
  return persistenceStatus === ContextAttestationPersistenceStatus.Idempotent
    ? AbandonContextGatewaySessionStatus.Idempotent
    : AbandonContextGatewaySessionStatus.Abandoned;
}

function result(
  status: AbandonContextGatewaySessionStatus,
  session: GatewaySession | null,
): AbandonContextGatewaySessionResult {
  return Object.freeze({ status, session });
}
