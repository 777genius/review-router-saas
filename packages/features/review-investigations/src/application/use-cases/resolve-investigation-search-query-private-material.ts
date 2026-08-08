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
import type { ReviewInvestigation } from "../../domain/review-investigation";
import {
  canonicalSearchQueryPrivateMaterialAssociatedData,
  requirePersistedSearchQueryRequirement,
} from "../investigation-private-material-binding";

export class ResolveInvestigationSearchQueryPrivateMaterial {
  constructor(
    private readonly store: InvestigationPrivateMaterialStorePort,
    private readonly cipher: InvestigationPrivateMaterialCipherPort,
    private readonly digest: InvestigationDigestPort,
    private readonly clock: InvestigationClockPort,
  ) {}

  async execute(input: {
    readonly investigation: ReviewInvestigation;
    readonly obligation: InvestigationObligation;
  }): Promise<string> {
    const requirement = requirePersistedSearchQueryRequirement(
      input.obligation,
    );
    const material = await this.store.findActivePrivateMaterial({
      investigationId: input.investigation.investigationId,
      obligationId: input.obligation.obligationId,
      activeAfter: this.clock.now().toISOString(),
    });
    if (!material) {
      throw new Error("investigation_private_material_unavailable");
    }
    try {
      const associatedDataCanonicalJson =
        canonicalSearchQueryPrivateMaterialAssociatedData({
          investigation: input.investigation,
          obligation: input.obligation,
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
      return payload.query;
    } catch (error) {
      throw new Error("investigation_private_material_invalid", {
        cause: error,
      });
    }
  }
}
