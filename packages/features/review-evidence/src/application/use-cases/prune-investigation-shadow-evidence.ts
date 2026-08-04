import type { ClockPort } from "../ports/clock-port";
import type { InvestigationShadowEvidencePrunerPort } from "../ports/investigation-shadow-evidence-ports";
import {
  assertInvestigationShadowEvidenceEpochMilliseconds,
  investigationShadowEvidenceMaxPruneLimit,
} from "../../domain/investigation-shadow-evidence";

export class PruneInvestigationShadowEvidence {
  constructor(
    private readonly dependencies: Readonly<{
      records: InvestigationShadowEvidencePrunerPort;
      clock: ClockPort;
    }>,
  ) {}

  execute(input: { readonly limit: number }): Promise<number> {
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
      throw new Error("investigation_shadow_prune_limit_invalid");
    }
    if (input.limit > investigationShadowEvidenceMaxPruneLimit) {
      throw new Error("investigation_shadow_prune_limit_exceeded");
    }
    const nowMs = this.dependencies.clock.nowMs();
    assertInvestigationShadowEvidenceEpochMilliseconds(
      nowMs,
      "investigation_shadow_prune_now_ms",
    );
    return this.dependencies.records.prune({
      retainUntilOrBeforeMs: nowMs,
      limit: input.limit,
    });
  }
}
