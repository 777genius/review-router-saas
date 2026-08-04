import type { SeedInvestigationObligation } from "../domain/coverage-contract";
import {
  InvestigationEvidenceRequirementKind,
  parseInvestigationEvidenceRequirement,
} from "../domain/obligation-closure-policy";
import type { InvestigationDigestPort } from "./ports/digest-port";

export class AttestedTurnProposalPreparation {
  constructor(private readonly digest: InvestigationDigestPort) {}

  async prepare(
    proposals: readonly SeedInvestigationObligation[],
  ): Promise<readonly SeedInvestigationObligation[]> {
    for (const proposal of proposals) {
      const requirement = parseInvestigationEvidenceRequirement(
        proposal.canonicalRequirement,
      );
      if (
        requirement.kind !== InvestigationEvidenceRequirementKind.CompleteFile
      ) {
        throw new Error(
          "investigation_obligation_proposal_requirement_invalid",
        );
      }
      if (
        requirement.pathHash !==
        (await this.digest.digestUtf8(requirement.path))
      ) {
        throw new Error("investigation_obligation_proposal_path_hash_mismatch");
      }
    }
    return Object.freeze([...proposals]);
  }
}
