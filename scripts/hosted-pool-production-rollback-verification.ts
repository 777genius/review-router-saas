import {
  hostedPoolFlagNames,
  type HostedPoolFlagName,
} from "./hosted-pool-production-control";

/** Independently proves every closure and the final two-service/drain reread. */
export function verifyHostedPoolRollbackEvidence(
  events: readonly Record<string, unknown>[],
) {
  const orderedClosures = [
    ["admission_closed", "REVIEW_ROUTER_ENABLE_HOSTED_CODEX_ADMISSION"],
    ["failover_closed", "REVIEW_ROUTER_ENABLE_HOSTED_CODEX_FAILOVER"],
    ["relay_closed", "REVIEW_ROUTER_ENABLE_HOSTED_CODEX_RELAY"],
    ["custody_closed", "REVIEW_ROUTER_ENABLE_HOSTED_CODEX_CUSTODY"],
    ["pool_closed", "REVIEW_ROUTER_ENABLE_HOSTED_CODEX_POOL"],
  ] as const;
  const faultPlanClosedIndex = events.findIndex(
    (event) => event.phase === "fault_plan_closed",
  );
  if (faultPlanClosedIndex < 0)
    throw new Error(
      "hosted_pool_rollback_evidence_phase_missing:fault_plan_closed",
    );
  let priorIndex = faultPlanClosedIndex;
  for (const [phase, flag] of orderedClosures) {
    const index = events.findIndex(
      (event, candidateIndex) =>
        candidateIndex > priorIndex && event.phase === phase,
    );
    if (index < 0)
      throw new Error(`hosted_pool_rollback_evidence_phase_missing:${phase}`);
    assertTwoServiceFlagReread(events[index]!, flag);
    priorIndex = index;
  }
  const finalIndex = events.findIndex(
    (event, index) =>
      index > priorIndex && event.phase === "rollback_final_reread",
  );
  if (finalIndex < 0)
    throw new Error(
      "hosted_pool_rollback_evidence_phase_missing:rollback_final_reread",
    );
  if (finalIndex !== events.length - 1)
    throw new Error("hosted_pool_rollback_final_reread_not_final");
  const final = events[finalIndex] as
    | {
        flags?: Record<string, Record<HostedPoolFlagName, string>>;
        counts?: {
          inFlight?: number;
          issuedGrants?: number;
          unresolvedRequests?: number;
        };
      }
    | undefined;
  const services = Object.values(final?.flags ?? {});
  if (
    services.length !== 2 ||
    services.some((flags) =>
      hostedPoolFlagNames.some((name) => flags[name] !== "0"),
    )
  )
    throw new Error("hosted_pool_rollback_final_flags_unproven");
  if (
    final?.counts?.inFlight !== 0 ||
    final.counts.issuedGrants !== 0 ||
    final.counts.unresolvedRequests !== 0
  )
    throw new Error("hosted_pool_rollback_final_drain_unproven");
  return Object.freeze({ serviceCount: 2, drainVerified: true });
}

function assertTwoServiceFlagReread(
  event: Record<string, unknown>,
  flag: HostedPoolFlagName,
) {
  const flags = (event as { flags?: Record<string, Record<string, string>> })
    .flags;
  const services = Object.values(flags ?? {});
  if (
    services.length !== 2 ||
    services.some((service) => service[flag] !== "0")
  )
    throw new Error(
      `hosted_pool_rollback_closure_reread_unproven:${String(event.phase)}`,
    );
}
