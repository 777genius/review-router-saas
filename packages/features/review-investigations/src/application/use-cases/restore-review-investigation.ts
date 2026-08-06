import type { ReviewInvestigation } from "../../domain/review-investigation";
import type { InvestigationDigestPort } from "../ports/digest-port";
import type { InvestigationStorePort } from "../ports/investigation-store-port";
import {
  toInvestigationReadModel,
  type ReviewInvestigationReadModel,
} from "../investigation-read-model";
import { requireValidDossierDigest } from "./investigation-use-case-support";
import type { ReconcileExpiredActiveTurn } from "./reconcile-expired-active-turn";

export class RestoreReviewInvestigation {
  constructor(
    private readonly store: InvestigationStorePort,
    private readonly digest: InvestigationDigestPort,
    private readonly expiredTurns?: Pick<ReconcileExpiredActiveTurn, "execute">,
  ) {}

  async execute(
    investigationId: string,
  ): Promise<ReviewInvestigationReadModel> {
    const investigation = await this.require(investigationId);
    await requireValidDossierDigest(this.digest, investigation);
    return toInvestigationReadModel(investigation);
  }

  async snapshot(investigationId: string): Promise<ReviewInvestigation> {
    const investigation = await this.require(investigationId);
    await requireValidDossierDigest(this.digest, investigation);
    return investigation;
  }

  private async require(investigationId: string): Promise<ReviewInvestigation> {
    const stored = await this.store.findById(investigationId);
    if (stored === null) throw new Error("investigation_missing");
    await requireValidDossierDigest(this.digest, stored);
    return this.expiredTurns
      ? this.expiredTurns.execute(investigationId)
      : stored;
  }
}
