import type {
  InvocationGrantId,
  RelayRequestId,
} from "../../domain/identifiers";
import {
  failoverCurrentRelayRequest,
  type ArProviderFailureClassification,
  type CurrentRelayRequestFailover,
  type ProviderEffectFence,
} from "../../domain/invocation-grant";
import type { CurrentRelayRequestFailoverPort } from "../ports/current-relay-request-failover-port";

export function failoverCurrentRelayRequestBeforeEffect(
  input: {
    readonly grantId: InvocationGrantId;
    readonly requestId: RelayRequestId;
    readonly failure: ArProviderFailureClassification;
    readonly effectFence: ProviderEffectFence;
    readonly cooldownUntil: Date | null;
    readonly now: Date;
    readonly effect?: Parameters<CurrentRelayRequestFailoverPort["failover"]>[0]["effect"];
  },
  failovers: CurrentRelayRequestFailoverPort,
): Promise<CurrentRelayRequestFailover> {
  return failovers.failover({
    grantId: input.grantId,
    requestId: input.requestId,
    now: input.now,
    ...(input.effect ? { effect: input.effect } : {}),
    transition: (grant, failedAccount, backupAccount) =>
      failoverCurrentRelayRequest({
        grant,
        requestId: input.requestId,
        failedAccount,
        backupAccount,
        failure: input.failure,
        effectFence: input.effectFence,
        cooldownUntil: input.cooldownUntil,
        now: input.now,
      }),
  });
}
