import type { InvestigationClockPort } from "../ports/clock-port";
import type { InvestigationDigestPort } from "../ports/digest-port";
import type {
  InvestigationPrivateMaterialCipherPort,
  InvestigationPrivateMaterialStorePort,
} from "../ports/investigation-private-material-ports";
import {
  canonicalInvestigationSearchQueryPrivateMaterial,
  parseInvestigationSearchQueryPrivateMaterial,
} from "../../domain/investigation-private-material";
import type { InvestigationObligation } from "../../domain/investigation-obligation";
import {
  canonicalInvestigationEvidenceRequirement,
  hydrateInvestigationEvidenceRequirement,
  InvestigationEvidenceRequirementKind,
  obligationEvidenceRequirementVersionV2,
  parseInvestigationEvidenceRequirement,
} from "../../domain/obligation-closure-policy";
import type { ReviewInvestigation } from "../../domain/review-investigation";
import { canonicalSearchQueryPrivateMaterialAssociatedData } from "../investigation-private-material-binding";

export type HydratedInvestigationTurnObligation = Readonly<{
  obligationId: string;
  kind: InvestigationObligation["kind"];
  canonicalSubject: string;
  canonicalRequirement: string;
  riskPriority: number;
  origin: InvestigationObligation["origin"];
}>;

export class HydrateInvestigationTurnObligations {
  constructor(
    private readonly store: InvestigationPrivateMaterialStorePort,
    private readonly cipher: InvestigationPrivateMaterialCipherPort,
    private readonly digest: InvestigationDigestPort,
    private readonly clock: InvestigationClockPort,
  ) {}

  async execute(input: {
    readonly investigation: ReviewInvestigation;
    readonly obligationIds: readonly string[];
  }): Promise<readonly HydratedInvestigationTurnObligation[]> {
    const obligations = new Map(
      input.investigation.obligations.map((obligation) => [
        obligation.obligationId,
        obligation,
      ]),
    );
    const hydrated: HydratedInvestigationTurnObligation[] = [];
    for (const obligationId of input.obligationIds) {
      const obligation = obligations.get(obligationId);
      if (!obligation) {
        throw new Error("investigation_turn_obligation_missing");
      }
      hydrated.push(
        await this.hydrateObligation(input.investigation, obligation),
      );
    }
    return Object.freeze(hydrated);
  }

  private async hydrateObligation(
    investigation: ReviewInvestigation,
    obligation: InvestigationObligation,
  ): Promise<HydratedInvestigationTurnObligation> {
    const requirement = parseInvestigationEvidenceRequirement(
      obligation.canonicalRequirement,
    );
    if (
      requirement.kind !==
        InvestigationEvidenceRequirementKind.CompletePageChain ||
      requirement.requirementVersion !== obligationEvidenceRequirementVersionV2
    ) {
      return briefObligation(obligation, obligation.canonicalRequirement);
    }
    const material = await this.store.findActivePrivateMaterial({
      investigationId: investigation.investigationId,
      obligationId: obligation.obligationId,
      activeAfter: this.clock.now().toISOString(),
    });
    if (!material) {
      throw new Error("investigation_private_material_unavailable");
    }
    try {
      const associatedDataCanonicalJson =
        canonicalSearchQueryPrivateMaterialAssociatedData({
          investigation,
          obligation,
          privateMaterialId: material.privateMaterialId,
          queryHash: requirement.queryHash,
          createdAt: material.createdAt,
          expiresAt: material.expiresAt,
        });
      const plaintext = await this.cipher.decrypt({
        material,
        associatedDataCanonicalJson,
      });
      const payload = parseInvestigationSearchQueryPrivateMaterial(plaintext);
      if (
        canonicalInvestigationSearchQueryPrivateMaterial(payload) !==
          plaintext ||
        payload.queryHash !== requirement.queryHash ||
        (await this.digest.digestUtf8(payload.query)) !== requirement.queryHash
      ) {
        throw new Error("investigation_private_material_query_mismatch");
      }
      return briefObligation(
        obligation,
        canonicalInvestigationEvidenceRequirement(
          hydrateInvestigationEvidenceRequirement(requirement, payload.query),
        ),
      );
    } catch (error) {
      throw new Error("investigation_private_material_invalid", {
        cause: error,
      });
    }
  }
}

function briefObligation(
  obligation: InvestigationObligation,
  canonicalRequirement: string,
): HydratedInvestigationTurnObligation {
  return Object.freeze({
    obligationId: obligation.obligationId,
    kind: obligation.kind,
    canonicalSubject: obligation.canonicalSubject,
    canonicalRequirement,
    riskPriority: obligation.riskPriority,
    origin: obligation.origin,
  });
}
