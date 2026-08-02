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

export class RestoreReviewInvestigation {
  constructor(
    private readonly store: InvestigationStorePort,
    private readonly digest: InvestigationDigestPort,
  ) {}

  async execute(
    investigationId: string,
  ): Promise<ReviewInvestigationReadModel> {
    const investigation = await this.require(investigationId);
    const expected = await digestCanonical(
      this.digest,
      investigationDossierCanonicalValue(investigation),
    );
    if (expected !== investigation.dossierDigest) {
      throw new Error("investigation_dossier_digest_invalid");
    }
    return toInvestigationReadModel(investigation);
  }

  async snapshot(investigationId: string): Promise<ReviewInvestigation> {
    const investigation = await this.require(investigationId);
    const expected = await digestCanonical(
      this.digest,
      investigationDossierCanonicalValue(investigation),
    );
    if (expected !== investigation.dossierDigest) {
      throw new Error("investigation_dossier_digest_invalid");
    }
    return investigation;
  }

  private async require(investigationId: string): Promise<ReviewInvestigation> {
    const investigation = await this.store.findById(investigationId);
    if (investigation === null) throw new Error("investigation_missing");
    return investigation;
  }
}
