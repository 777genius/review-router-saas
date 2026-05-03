import type { DependencyHealth } from "../domain/system-health.js";
import type { HealthDependencyPort } from "../application/ports/health-dependency-port.js";

export class StaticHealthDependency implements HealthDependencyPort {
  constructor(private readonly health: DependencyHealth) {}

  async check(): Promise<DependencyHealth> {
    return this.health;
  }
}
