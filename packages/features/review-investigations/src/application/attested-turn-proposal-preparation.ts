import type { SeedInvestigationObligation } from "../domain/coverage-contract";
import { independentCriticRiskPriorityV1 } from "../domain/investigation-critic-policy";
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
    const prepared = await Promise.all(
      proposals.map(async (proposal) => {
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
          throw new Error(
            "investigation_obligation_proposal_path_hash_mismatch",
          );
        }
        return Object.freeze({
          ...proposal,
          riskPriority: Math.max(
            proposal.riskPriority,
            independentCriticRiskPriorityV1,
          ),
        });
      }),
    );
    return Object.freeze(prepared);
  }
}
