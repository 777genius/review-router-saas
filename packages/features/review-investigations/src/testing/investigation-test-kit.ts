import type { InvestigationClockPort } from "../application/ports/clock-port";
import {
  InvestigationExecutionAuthorityVerdict,
  type InvestigationExecutionAuthorityPort,
} from "../application/ports/execution-authority-port";

export class FixedInvestigationClock implements InvestigationClockPort {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class CurrentInvestigationExecutionAuthority implements InvestigationExecutionAuthorityPort {
  verdict = InvestigationExecutionAuthorityVerdict.Current;

  async check(): Promise<InvestigationExecutionAuthorityVerdict> {
    return this.verdict;
  }
}
