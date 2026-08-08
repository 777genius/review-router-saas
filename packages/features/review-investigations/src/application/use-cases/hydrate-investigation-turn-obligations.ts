import type { InvestigationClockPort } from "../ports/clock-port";
import type { InvestigationDigestPort } from "../ports/digest-port";
import type {
  InvestigationPrivateMaterialCipherPort,
  InvestigationPrivateMaterialStorePort,
} from "../ports/investigation-private-material-ports";
import type { InvestigationObligation } from "../../domain/investigation-obligation";
import {
  canonicalInvestigationEvidenceRequirement,
  hydrateInvestigationEvidenceRequirement,
  InvestigationEvidenceRequirementKind,
  obligationEvidenceRequirementVersionV2,
  parseInvestigationEvidenceRequirement,
  requiresInvestigationSearchQueryPrivateMaterial,
} from "../../domain/obligation-closure-policy";
import type { ReviewInvestigation } from "../../domain/review-investigation";
import { ResolveInvestigationSearchQueryPrivateMaterial } from "./resolve-investigation-search-query-private-material";

export type HydratedInvestigationTurnObligation = Readonly<{
  obligationId: string;
  kind: InvestigationObligation["kind"];
  canonicalSubject: string;
  canonicalRequirement: string;
  riskPriority: number;
  origin: InvestigationObligation["origin"];
}>;

export class HydrateInvestigationTurnObligations {
  private readonly resolvePrivateQuery: ResolveInvestigationSearchQueryPrivateMaterial;

  constructor(
    store: InvestigationPrivateMaterialStorePort,
    cipher: InvestigationPrivateMaterialCipherPort,
    digest: InvestigationDigestPort,
    clock: InvestigationClockPort,
  ) {
    this.resolvePrivateQuery =
      new ResolveInvestigationSearchQueryPrivateMaterial(
        store,
        cipher,
        digest,
        clock,
      );
  }

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
    if (!requiresInvestigationSearchQueryPrivateMaterial(requirement)) {
      return briefObligation(obligation, obligation.canonicalRequirement);
    }
    const query = await this.resolveQuery({
      investigation,
      obligation,
      requirement,
    });
    return briefObligation(
      obligation,
      canonicalInvestigationEvidenceRequirement(
        hydrateInvestigationEvidenceRequirement(requirement, query),
      ),
    );
  }

  private async resolveQuery(input: {
    readonly investigation: ReviewInvestigation;
    readonly obligation: InvestigationObligation;
    readonly requirement: ReturnType<
      typeof parseInvestigationEvidenceRequirement
    >;
  }): Promise<string> {
    try {
      return await this.resolvePrivateQuery.execute(input);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "investigation_private_material_unavailable" ||
        input.requirement.kind !==
          InvestigationEvidenceRequirementKind.CompleteRelationContext ||
        input.requirement.requirementVersion !==
          obligationEvidenceRequirementVersionV2
      ) {
        throw error;
      }
      const relationRequirement = input.requirement;
      const source = input.investigation.obligations.find(
        (obligation) =>
          obligation.obligationId === relationRequirement.sourceObligationId,
      );
      if (!source) throw error;
      const sourceRequirement = parseInvestigationEvidenceRequirement(
        source.canonicalRequirement,
      );
      if (
        sourceRequirement.kind !==
          InvestigationEvidenceRequirementKind.CompletePageChain ||
        sourceRequirement.requirementVersion !==
          obligationEvidenceRequirementVersionV2 ||
        sourceRequirement.queryHash !== relationRequirement.queryHash ||
        sourceRequirement.initialOperationInputHash !==
          relationRequirement.initialOperationInputHash
      ) {
        throw error;
      }
      return this.resolvePrivateQuery.execute({
        investigation: input.investigation,
        obligation: source,
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
