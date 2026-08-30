import { describe, expect, it } from "vitest";
import { hostedPoolFlagNames } from "./hosted-pool-production-control";
import { verifyHostedPoolRollbackEvidence } from "./hosted-pool-production-rollback-verification";

describe("hosted pool rollback verification", () => {
  it("requires every closure plus an exact final two-service drain reread", () => {
    const closed = Object.fromEntries(
      hostedPoolFlagNames.map((name) => [name, "0"]),
    );
    const events = [
      "admission_closed",
      "failover_closed",
      "relay_closed",
      "custody_closed",
      "pool_closed",
    ].map((phase) => ({ phase, flags: { api: closed, web: closed } }));
    expect(
      verifyHostedPoolRollbackEvidence([
        { phase: "fault_plan_closed" },
        ...events,
        {
          phase: "rollback_final_reread",
          flags: { api: closed, web: closed },
          counts: { inFlight: 0, issuedGrants: 0, unresolvedRequests: 0 },
        },
      ]),
    ).toEqual({ serviceCount: 2, drainVerified: true });
    expect(() => verifyHostedPoolRollbackEvidence(events)).toThrow(
      "hosted_pool_rollback_evidence_phase_missing:fault_plan_closed",
    );
    expect(() =>
      verifyHostedPoolRollbackEvidence([
        { phase: "fault_plan_closed" },
        events[1]!,
        events[0]!,
        ...events.slice(2),
        {
          phase: "rollback_final_reread",
          flags: { api: closed, web: closed },
          counts: { inFlight: 0, issuedGrants: 0, unresolvedRequests: 0 },
        },
      ]),
    ).toThrow("hosted_pool_rollback_evidence_phase_missing:failover_closed");
  });
});
