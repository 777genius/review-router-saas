export type SystemHealthStatus = "ok" | "degraded";

export type SystemHealth = {
  readonly status: SystemHealthStatus;
  readonly service: "review-router-api";
  readonly checkedAt: Date;
  readonly dependencies: readonly DependencyHealth[];
};

export type DependencyHealth = {
  readonly name: string;
  readonly status: SystemHealthStatus;
};

export function resolveSystemStatus(
  dependencies: readonly DependencyHealth[],
): SystemHealthStatus {
  return dependencies.every((dependency) => dependency.status === "ok")
    ? "ok"
    : "degraded";
}
