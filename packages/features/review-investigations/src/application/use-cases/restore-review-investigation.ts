import {
  investigationDossierCanonicalValue,
  type ReviewInvestigation,
} from "../../domain/review-investigation";
import type { InvestigationDigestPort } from "../ports/digest-port";
import type { InvestigationStorePort } from "../ports/investigation-store-port";
import {
  toInvestigationReadModel,
  type ReviewInvestigationReadModel,
} from "../investigation-read-model";
import { digestCanonical } from "./investigation-use-case-support";
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
    if (!(await this.hasValidDossierDigest(investigation))) {
      throw new Error("investigation_dossier_digest_invalid");
    }
    return toInvestigationReadModel(investigation);
  }

  async snapshot(investigationId: string): Promise<ReviewInvestigation> {
    const investigation = await this.require(investigationId);
    if (!(await this.hasValidDossierDigest(investigation))) {
      throw new Error("investigation_dossier_digest_invalid");
    }
    return investigation;
  }

  private async require(investigationId: string): Promise<ReviewInvestigation> {
    const investigation = this.expiredTurns
      ? await this.expiredTurns.execute(investigationId)
      : await this.store.findById(investigationId);
    if (investigation === null) throw new Error("investigation_missing");
    return investigation;
  }

  private async hasValidDossierDigest(
    investigation: ReviewInvestigation,
  ): Promise<boolean> {
    return (
      (await digestCanonical(
        this.digest,
        investigationDossierCanonicalValue(investigation),
      )) === investigation.dossierDigest
    );
  }
}
