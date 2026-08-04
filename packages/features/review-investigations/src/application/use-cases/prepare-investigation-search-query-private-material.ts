import type { InvestigationDigestPort } from "../ports/digest-port";
import type { InvestigationPrivateMaterialCipherPort } from "../ports/investigation-private-material-ports";
import {
  assertInvestigationPrivateMaterialTtl,
  canonicalInvestigationSearchQueryPrivateMaterial,
  investigationSearchQueryPrivateMaterialKind,
  investigationSearchQueryPrivateMaterialVersion,
  type EncryptedInvestigationPrivateMaterial,
} from "../../domain/investigation-private-material";
import type { InvestigationObligation } from "../../domain/investigation-obligation";
import type { ReviewInvestigation } from "../../domain/review-investigation";
import {
  canonicalSearchQueryPrivateMaterialAssociatedData,
  canonicalSearchQueryPrivateMaterialIdentity,
  requirePersistedSearchQueryRequirement,
} from "../investigation-private-material-binding";

export class PrepareInvestigationSearchQueryPrivateMaterial {
  constructor(
    private readonly cipher: InvestigationPrivateMaterialCipherPort,
    private readonly digest: InvestigationDigestPort,
    private readonly ttlMs: number,
  ) {
    assertInvestigationPrivateMaterialTtl(ttlMs);
  }

  async execute(input: {
    readonly investigation: ReviewInvestigation;
    readonly obligation: InvestigationObligation;
    readonly query: string;
  }): Promise<EncryptedInvestigationPrivateMaterial> {
    const requirement = requirePersistedSearchQueryRequirement(
      input.obligation,
    );
    const queryHash = await this.digest.digestUtf8(input.query);
    if (queryHash !== requirement.queryHash) {
      throw new Error("investigation_private_material_query_mismatch");
    }
    const privateMaterialHash = await this.digest.digestUtf8(
      canonicalSearchQueryPrivateMaterialIdentity({
        investigation: input.investigation,
        obligation: input.obligation,
        queryHash,
      }),
    );
    const privateMaterialId = `private-${privateMaterialHash.slice(0, 40)}`;
    const createdAt = input.investigation.createdAt;
    const expiresAt = new Date(
      new Date(createdAt).getTime() + this.ttlMs,
    ).toISOString();
    const associatedDataCanonicalJson =
      canonicalSearchQueryPrivateMaterialAssociatedData({
        investigation: input.investigation,
        obligation: input.obligation,
        privateMaterialId,
        queryHash,
        createdAt,
        expiresAt,
      });
    return this.cipher.encrypt({
      privateMaterialId,
      investigationId: input.investigation.investigationId,
      obligationId: input.obligation.obligationId,
      plaintextCanonicalJson: canonicalInvestigationSearchQueryPrivateMaterial({
        materialVersion: investigationSearchQueryPrivateMaterialVersion,
        kind: investigationSearchQueryPrivateMaterialKind,
        query: input.query,
        queryHash,
      }),
      associatedDataCanonicalJson,
      createdAt,
      expiresAt,
    });
  }
}
