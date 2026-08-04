import type { InvestigationEmergencyStopQueryPort } from "../../application/ports/operations-ports";
import type { InvestigationRolloutTarget } from "../../domain/investigation-rollout-policy";

export interface InvestigationEmergencyControlSource {
  findApplicable(target: InvestigationRolloutTarget): Promise<
    readonly Readonly<{
      global: boolean;
      stopped: boolean;
    }>[]
  >;
}

export class RunControlInvestigationEmergencyStopQuery implements InvestigationEmergencyStopQueryPort {
  constructor(private readonly controls: InvestigationEmergencyControlSource) {}

  async isEmergencyStopped(
    target: InvestigationRolloutTarget,
  ): Promise<boolean> {
    const controls = await this.controls.findApplicable(target);
    const global = controls.find((control) => control.global);
    if (!global) throw new Error("investigation_emergency_control_missing");
    return controls.some((control) => control.stopped);
  }
}
