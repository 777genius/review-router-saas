import type {
  ReviewInvestigationContract,
  ReviewInvestigationRevision,
  SeedInvestigationObligation,
} from "../../domain/coverage-contract";
import { resolveReviewInvestigationCoverageProfileGeneration } from "../../domain/coverage-contract";
import type { CoverageSeedPolicy } from "../../domain/coverage-policies";
import {
  createInvestigationObligation,
  obligationIdentity,
  satisfyInvestigationObligation,
  type InvestigationEvidenceReceipt,
  type InvestigationObligation,
} from "../../domain/investigation-obligation";
import {
  InvestigationEvidenceRequirementKind,
  canonicalStandardTextSearchOperationInput,
  obligationEvidenceRequirementVersionV2,
  parseInvestigationEvidenceRequirement,
  parseSuppliedInvestigationEvidenceRequirement,
} from "../../domain/obligation-closure-policy";
import type { EncryptedInvestigationPrivateMaterial } from "../../domain/investigation-private-material";
import type { ReviewInvestigation } from "../../domain/review-investigation";
import type { InvestigationDigestPort } from "../ports/digest-port";
import { digestCanonical } from "./investigation-use-case-support";
import type { PrepareInvestigationSearchQueryPrivateMaterial } from "./prepare-investigation-search-query-private-material";

export type PreparedInvestigationSeed = Readonly<{
  obligations: readonly InvestigationObligation[];
  privateQueries: ReadonlyMap<string, string>;
}>;

export async function prepareInvestigationSeed(input: {
  readonly contract: ReviewInvestigationContract;
  readonly revision: ReviewInvestigationRevision;
  readonly stableReviewUnitKey: string;
  readonly seedObligations: readonly SeedInvestigationObligation[];
  readonly initialReceipts: readonly InvestigationEvidenceReceipt[];
  readonly coverageSeedPolicy: CoverageSeedPolicy;
  readonly digest: InvestigationDigestPort;
}): Promise<PreparedInvestigationSeed> {
  if (
    resolveReviewInvestigationCoverageProfileGeneration(input.contract) !==
      null &&
    input.initialReceipts.length > 0
  ) {
    throw new Error("investigation_initial_receipts_unverified");
  }
  const receipts = new Map(
    input.initialReceipts.map((receipt) => [receipt.canonicalSubject, receipt]),
  );
  const privateQueries = await validateCoverageSeedDigestBindings({
    contract: input.contract,
    seeds: input.seedObligations,
    digest: input.digest,
  });
  const policySeeds = input.coverageSeedPolicy.seed({
    contract: input.contract,
    supplied: input.seedObligations,
  });
  const obligations = await Promise.all(
    policySeeds.map(async (seed) => {
      const identity = obligationIdentity({
        coverageContractVersion: input.contract.coverageContractVersion,
        stableReviewUnitKey: input.stableReviewUnitKey,
        kind: seed.kind,
        canonicalSubject: seed.canonicalSubject,
        canonicalRequirement: seed.canonicalRequirement,
      });
      let obligation = createInvestigationObligation({
        obligationId: await digestCanonical(input.digest, { ...identity }),
        identity,
        riskPriority: seed.riskPriority,
        origin: seed.origin,
      });
      const receipt = receipts.get(seed.canonicalSubject);
      if (receipt) {
        obligation = satisfyInvestigationObligation({
          obligation,
          receipt,
          reviewRevisionHash: input.revision.reviewRevisionHash,
          gatewayPolicyVersion: input.contract.gatewayPolicyVersion,
        });
      }
      return obligation;
    }),
  );
  return Object.freeze({
    obligations: Object.freeze(obligations),
    privateQueries,
  });
}

export async function prepareInvestigationSeedPrivateMaterials(input: {
  readonly investigation: ReviewInvestigation;
  readonly privateQueries: ReadonlyMap<string, string>;
  readonly preparer: PrepareInvestigationSearchQueryPrivateMaterial | undefined;
}): Promise<readonly EncryptedInvestigationPrivateMaterial[]> {
  if (
    resolveReviewInvestigationCoverageProfileGeneration(
      input.investigation.contract,
    ) === null
  ) {
    return Object.freeze([]);
  }
  const materials: EncryptedInvestigationPrivateMaterial[] = [];
  const consumedSubjects = new Set<string>();
  for (const obligation of input.investigation.obligations) {
    const requirement = parseInvestigationEvidenceRequirement(
      obligation.canonicalRequirement,
    );
    if (
      requirement.kind !==
        InvestigationEvidenceRequirementKind.CompletePageChain ||
      requirement.requirementVersion !== obligationEvidenceRequirementVersionV2
    ) {
      continue;
    }
    const query = input.privateQueries.get(obligation.canonicalSubject);
    if (!query || !input.preparer) {
      throw new Error("investigation_private_material_required");
    }
    consumedSubjects.add(obligation.canonicalSubject);
    materials.push(
      await input.preparer.execute({
        investigation: input.investigation,
        obligation,
        query,
      }),
    );
  }
  if (consumedSubjects.size !== input.privateQueries.size) {
    throw new Error("investigation_private_material_binding_invalid");
  }
  return Object.freeze(materials);
}

async function validateCoverageSeedDigestBindings(input: {
  readonly contract: ReviewInvestigationContract;
  readonly seeds: readonly SeedInvestigationObligation[];
  readonly digest: InvestigationDigestPort;
}): Promise<ReadonlyMap<string, string>> {
  if (
    resolveReviewInvestigationCoverageProfileGeneration(input.contract) === null
  ) {
    return new Map();
  }
  const privateQueries = new Map<string, string>();
  for (const seed of input.seeds) {
    const requirement = parseSuppliedInvestigationEvidenceRequirement(
      seed.canonicalRequirement,
    );
    if (
      requirement.kind ===
        InvestigationEvidenceRequirementKind.CompleteChangedFile ||
      requirement.kind ===
        InvestigationEvidenceRequirementKind.BinaryArtifactBoundary
    ) {
      if (
        (await input.digest.digestUtf8(requirement.path)) !==
        requirement.pathHash
      ) {
        throw new Error("investigation_coverage_seed_digest_mismatch");
      }
      continue;
    }
    if (
      requirement.kind !==
        InvestigationEvidenceRequirementKind.CompletePageChain ||
      requirement.requirementVersion !== obligationEvidenceRequirementVersionV2
    ) {
      continue;
    }
    const queryHash = await input.digest.digestUtf8(requirement.query);
    const operationInputHash = await input.digest.digestUtf8(
      canonicalStandardTextSearchOperationInput(queryHash),
    );
    if (
      requirement.queryHash !== queryHash ||
      requirement.initialOperationInputHash !== operationInputHash
    ) {
      throw new Error("investigation_coverage_seed_digest_mismatch");
    }
    if (privateQueries.has(seed.canonicalSubject)) {
      throw new Error("investigation_coverage_seed_duplicate");
    }
    privateQueries.set(seed.canonicalSubject, requirement.query);
  }
  return privateQueries;
}
