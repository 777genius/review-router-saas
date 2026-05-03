import type { Clock } from "@reviewrouter/shared";
import {
  resolveSystemStatus,
  type SystemHealth,
} from "../domain/system-health.js";
import type { HealthDependencyPort } from "./ports/health-dependency-port.js";

export type GetSystemHealthDependencies = {
  readonly clock: Clock;
  readonly dependencies?: readonly HealthDependencyPort[];
};

export async function getSystemHealth({
  clock,
  dependencies = [],
}: GetSystemHealthDependencies): Promise<SystemHealth> {
  const checkedDependencies = await Promise.all(
    dependencies.map((dependency) => dependency.check()),
  );

  return {
    service: "review-router-api",
    status: resolveSystemStatus(checkedDependencies),
    checkedAt: clock.now(),
    dependencies: checkedDependencies,
  };
}
