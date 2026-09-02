export type HostedCustodyReadiness = Readonly<{
  ready: boolean;
  status: "ok" | "degraded";
  reason:
    | "ready"
    | "initial_reconcile_pending"
    | "reconcile_failed"
    | "reconcile_overdue";
  metrics: Readonly<Record<string, number | boolean | string | null>>;
}>;

export interface HostedCustodyReadinessPort {
  readiness(): HostedCustodyReadiness;
}

export function assertHostedCustodyReady(
  readiness: HostedCustodyReadiness,
): void {
  if (!readiness.ready) {
    throw new Error(`hosted_codex_custody_not_ready:${readiness.reason}`);
  }
}
