import type { DependencyHealth } from "../../domain/system-health.js";

export interface HealthDependencyPort {
  check(): Promise<DependencyHealth>;
}
