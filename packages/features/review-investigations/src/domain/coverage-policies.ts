import {
  assertSupportedReviewInvestigationCoverageProfile,
  reviewInvestigationCoverageProfileV2,
  type ReviewInvestigationContract,
  type SeedInvestigationObligation,
} from "./coverage-contract";
import {
  InvestigationObligationOrigin,
  type InvestigationObligation,
} from "./investigation-obligation";
import {
  InvestigationOperationKind,
  InvestigationOperationRevision,
  type InvestigationPageEvidence,
  type VerifiedInvestigationOperationEvidence,
} from "./investigation-operation-evidence";
import {
  InvestigationEvidenceRequirementKind,
  InvestigationProbeKind,
  canonicalBinaryArtifactBoundarySubject,
  canonicalFileObligationSubject,
  canonicalInvestigationEvidenceRequirement,
  canonicalInventoryObligationSubjectV2,
  canonicalPageObligationSubjectV2,
  canonicalRelationObligationSubjectV2,
  investigationRelationPathMaximumCount,
  obligationEvidenceRequirementVersionV2,
  parseInvestigationEvidenceRequirement,
  parseSuppliedInvestigationEvidenceRequirement,
  toPersistedInvestigationEvidenceRequirement,
  type BinaryArtifactBoundaryRequirement,
  type CompleteChangedFileRequirementV2,
  type SuppliedCompletePageChainRequirementV2,
} from "./obligation-closure-policy";
import { ReviewInvestigationDomainError } from "./canonicalization";
import { InvestigationObligationKind } from "./review-investigation-types";

const maximumDiscoveryClaims = 256;
const maximumDiscoveryReceiptsPerClaim = 256;

export type PolicySeedInvestigationObligation = SeedInvestigationObligation &
  Readonly<{ origin: InvestigationObligationOrigin }>;

export interface CoverageSeedPolicy {
  seed(input: {
    readonly contract: ReviewInvestigationContract;
    readonly supplied: readonly SeedInvestigationObligation[];
  }): readonly PolicySeedInvestigationObligation[];
}

export type PreparedOperationBackedDiscoveryClaim = Readonly<{
  sourceObligationId: string;
  queryHash: string;
  expectedInitialOperationInputHash: string;
  authenticatedPathSetHash: string;
  operations: readonly VerifiedInvestigationOperationEvidence[];
}>;

export interface CoverageExpansionPolicy {
  expand(input: {
    readonly contract: ReviewInvestigationContract;
    readonly currentObligations: readonly InvestigationObligation[];
    readonly discoveryClaims: readonly PreparedOperationBackedDiscoveryClaim[];
  }): readonly PolicySeedInvestigationObligation[];
}

export class VersionedCoverageSeedPolicy implements CoverageSeedPolicy {
  seed(input: {
    readonly contract: ReviewInvestigationContract;
    readonly supplied: readonly SeedInvestigationObligation[];
  }): readonly PolicySeedInvestigationObligation[] {
    if (!isVersionedCoverageContract(input.contract)) {
      return Object.freeze(
        input.supplied.map((item) =>
          Object.freeze({
            ...item,
            origin: InvestigationObligationOrigin.CoverageContract,
          }),
        ),
      );
    }
    assertSupportedReviewInvestigationCoverageProfile(input.contract);
    const inventory: SeedInvestigationObligation[] = [];
    const changedItems: Array<{
      seed: SeedInvestigationObligation;
      requirement: CompleteChangedFileRequirementV2;
    }> = [];
    const boundaryItems: Array<{
      seed: SeedInvestigationObligation;
      requirement: BinaryArtifactBoundaryRequirement;
    }> = [];
    const probeItems: Array<{
      seed: SeedInvestigationObligation;
      requirement: SuppliedCompletePageChainRequirementV2;
    }> = [];
    for (const seed of input.supplied) {
      const requirement = parseSuppliedInvestigationEvidenceRequirement(
        seed.canonicalRequirement,
      );
      switch (requirement.kind) {
        case InvestigationEvidenceRequirementKind.BinaryArtifactBoundary:
          if (
            seed.kind !== InvestigationObligationKind.BinaryArtifact ||
            seed.canonicalSubject !==
              canonicalBinaryArtifactBoundarySubject({
                contentKind: requirement.contentKind,
                objectOid: requirement.objectOid,
                pathHash: requirement.pathHash,
                revision: requirement.revision,
              })
          ) {
            throw invalidSeed();
          }
          boundaryItems.push({ seed, requirement });
          break;
        case InvestigationEvidenceRequirementKind.CompleteInventory:
          if (
            requirement.requirementVersion !==
              obligationEvidenceRequirementVersionV2 ||
            seed.kind !== InvestigationObligationKind.InventoryWitness ||
            seed.canonicalSubject !==
              canonicalInventoryObligationSubjectV2(requirement)
          ) {
            throw invalidSeed();
          }
          inventory.push(seed);
          break;
        case InvestigationEvidenceRequirementKind.CompleteChangedFile:
          if (
            requirement.requirementVersion !==
              obligationEvidenceRequirementVersionV2 ||
            seed.kind !== InvestigationObligationKind.ChangedContent ||
            seed.canonicalSubject !==
              canonicalFileObligationSubject({
                pathHash: requirement.pathHash,
                revision: requirement.revision,
              })
          ) {
            throw invalidSeed();
          }
          changedItems.push({ seed, requirement });
          break;
        case InvestigationEvidenceRequirementKind.CompletePageChain:
          if (
            requirement.requirementVersion !==
              obligationEvidenceRequirementVersionV2 ||
            !isApprovedProbeSource(seed.kind, requirement.probeKind) ||
            requirement.searchPolicyVersion !==
              input.contract.searchPolicyVersion ||
            seed.canonicalSubject !==
              canonicalPageObligationSubjectV2({
                obligationKind: seed.kind,
                initialOperationInputHash:
                  requirement.initialOperationInputHash,
                probeKind: requirement.probeKind,
                queryHash: requirement.queryHash,
              })
          ) {
            throw invalidSeed();
          }
          probeItems.push({ seed, requirement });
          break;
        default:
          throw invalidSeed();
      }
    }
    if (inventory.length !== 1 || changedItems.length === 0) {
      throw invalidSeed();
    }

    const paths = new Map<string, string>();
    const pathHashes = new Map<string, string>();
    const changedTargets = new Set<string>();
    for (const item of changedItems) {
      const target = changedTarget(item.requirement);
      if (
        changedTargets.has(target) ||
        (paths.has(item.requirement.path) &&
          paths.get(item.requirement.path) !== item.requirement.pathHash) ||
        (pathHashes.has(item.requirement.pathHash) &&
          pathHashes.get(item.requirement.pathHash) !== item.requirement.path)
      ) {
        throw new ReviewInvestigationDomainError(
          "investigation_coverage_seed_duplicate",
        );
      }
      changedTargets.add(target);
      paths.set(item.requirement.path, item.requirement.pathHash);
      pathHashes.set(item.requirement.pathHash, item.requirement.path);
    }
    if (
      probeItems.some(
        (item) => !pathHashes.has(item.requirement.sourcePathHash),
      )
    ) {
      throw invalidSeed();
    }

    const boundaryTargets = new Set<string>();
    for (const item of boundaryItems) {
      const target = changedTarget(item.requirement);
      if (
        boundaryTargets.has(target) ||
        !changedTargets.has(target) ||
        paths.get(item.requirement.path) !== item.requirement.pathHash
      ) {
        throw invalidSeed();
      }
      boundaryTargets.add(target);
    }

    const seeds = [
      ...inventory.map((seed) =>
        withOrigin(seed, InvestigationObligationOrigin.CoverageContract),
      ),
      ...changedItems.map((item) =>
        withOrigin(item.seed, InvestigationObligationOrigin.CoverageContract),
      ),
      ...boundaryItems.map((item) =>
        withOrigin(item.seed, InvestigationObligationOrigin.CoverageContract),
      ),
      ...probeItems.map((item) =>
        withOrigin(
          {
            ...item.seed,
            canonicalRequirement: canonicalInvestigationEvidenceRequirement(
              toPersistedInvestigationEvidenceRequirement(item.requirement),
            ),
          },
          InvestigationObligationOrigin.DeterministicExpansion,
        ),
      ),
    ];
    if (new Set(seeds.map(seedIdentity)).size !== seeds.length) {
      throw new ReviewInvestigationDomainError(
        "investigation_coverage_seed_duplicate",
      );
    }
    return Object.freeze(seeds.sort(compareSeed));
  }
}

function changedTarget(input: {
  readonly pathHash: string;
  readonly revision: InvestigationOperationRevision;
}): string {
  return `${input.revision}:${input.pathHash}`;
}

export class VersionedCoverageExpansionPolicy implements CoverageExpansionPolicy {
  expand(input: {
    readonly contract: ReviewInvestigationContract;
    readonly currentObligations: readonly InvestigationObligation[];
    readonly discoveryClaims: readonly PreparedOperationBackedDiscoveryClaim[];
  }): readonly PolicySeedInvestigationObligation[] {
    if (!isVersionedCoverageContract(input.contract)) return Object.freeze([]);
    assertSupportedReviewInvestigationCoverageProfile(input.contract);
    if (input.discoveryClaims.length > maximumDiscoveryClaims) {
      throw invalidDiscovery();
    }
    const obligations = new Map(
      input.currentObligations.map((obligation) => [
        obligation.obligationId,
        obligation,
      ]),
    );
    const additions: PolicySeedInvestigationObligation[] = [];
    for (const claim of [...input.discoveryClaims].sort(compareClaim)) {
      const source = obligations.get(claim.sourceObligationId);
      if (!source) throw invalidDiscovery();
      const sourceProfile = sourceDiscoveryProfile(
        source,
        claim,
        input.contract,
      );
      const chain = completeSearchChain(
        claim.operations,
        claim.expectedInitialOperationInputHash,
      );
      const terminal = chain.pages.at(-1)!;
      if (
        terminal.aggregatePathSetHash !== claim.authenticatedPathSetHash ||
        chain.pathHashes.length !== terminal.aggregatePathCount
      ) {
        throw invalidDiscovery();
      }
      if (terminal.aggregatePathCount === 0) continue;
      if (terminal.aggregatePathCount > investigationRelationPathMaximumCount) {
        throw new ReviewInvestigationDomainError(
          "investigation_operation_backed_discovery_limit_exceeded",
        );
      }
      const relationRequirement = Object.freeze({
        requirementVersion: obligationEvidenceRequirementVersionV2,
        kind: InvestigationEvidenceRequirementKind.CompleteRelationContext,
        sourceObligationId: source.obligationId,
        initialOperationInputHash: claim.expectedInitialOperationInputHash,
        queryHash: claim.queryHash,
        requiredPathCount: terminal.aggregatePathCount,
        requiredPathSetHash: terminal.aggregatePathSetHash,
        requiredPathHashes: Object.freeze([...chain.pathHashes]),
        sourcePathHash: sourceProfile.sourcePathHash,
        revision: InvestigationOperationRevision.Head,
        searchPolicyVersion: input.contract.searchPolicyVersion,
      });
      additions.push(
        Object.freeze({
          kind: sourceProfile.relationKind,
          canonicalSubject: canonicalRelationObligationSubjectV2({
            obligationKind: sourceProfile.relationKind,
            sourceObligationId: source.obligationId,
            initialOperationInputHash: claim.expectedInitialOperationInputHash,
            queryHash: claim.queryHash,
            requiredPathSetHash: terminal.aggregatePathSetHash,
          }),
          canonicalRequirement:
            canonicalInvestigationEvidenceRequirement(relationRequirement),
          riskPriority: source.riskPriority,
          origin: InvestigationObligationOrigin.DeterministicExpansion,
        }),
      );
    }
    const existing = new Set(
      input.currentObligations.map((item) => seedIdentity(item)),
    );
    return Object.freeze(
      dedupeSeeds(additions)
        .filter((item) => !existing.has(seedIdentity(item)))
        .sort(compareSeed),
    );
  }
}

function sourceDiscoveryProfile(
  source: InvestigationObligation,
  claim: PreparedOperationBackedDiscoveryClaim,
  contract: ReviewInvestigationContract,
): Readonly<{
  relationKind: InvestigationObligationKind;
  sourcePathHash: string;
}> {
  const requirement = parseInvestigationEvidenceRequirement(
    source.canonicalRequirement,
  );
  if (
    source.kind === InvestigationObligationKind.ChangedContent &&
    source.origin === InvestigationObligationOrigin.CoverageContract &&
    requirement.kind ===
      InvestigationEvidenceRequirementKind.CompleteChangedFile &&
    requirement.requirementVersion === obligationEvidenceRequirementVersionV2 &&
    source.canonicalSubject ===
      canonicalFileObligationSubject({
        pathHash: requirement.pathHash,
        revision: requirement.revision,
      })
  ) {
    return Object.freeze({
      relationKind: InvestigationObligationKind.DirectCaller,
      sourcePathHash: requirement.pathHash,
    });
  }
  if (
    source.origin !== InvestigationObligationOrigin.DeterministicExpansion ||
    requirement.kind !==
      InvestigationEvidenceRequirementKind.CompletePageChain ||
    requirement.requirementVersion !== obligationEvidenceRequirementVersionV2 ||
    !isApprovedProbeSource(source.kind, requirement.probeKind) ||
    requirement.searchPolicyVersion !== contract.searchPolicyVersion ||
    requirement.queryHash !== claim.queryHash ||
    requirement.initialOperationInputHash !==
      claim.expectedInitialOperationInputHash ||
    source.canonicalSubject !==
      canonicalPageObligationSubjectV2({
        obligationKind: source.kind,
        initialOperationInputHash: requirement.initialOperationInputHash,
        probeKind: requirement.probeKind,
        queryHash: requirement.queryHash,
      })
  ) {
    throw invalidDiscovery();
  }
  return Object.freeze({
    relationKind: expansionKindFor(source.kind),
    sourcePathHash: requirement.sourcePathHash,
  });
}

function completeSearchChain(
  operations: readonly VerifiedInvestigationOperationEvidence[],
  expectedInitialOperationInputHash: string,
): Readonly<{
  pages: readonly InvestigationPageEvidence[];
  pathHashes: readonly string[];
}> {
  if (
    operations.length === 0 ||
    operations.length > maximumDiscoveryReceiptsPerClaim ||
    new Set(operations.map((item) => item.operationReceiptId)).size !==
      operations.length ||
    operations.some(
      (item) => item.operationKind !== InvestigationOperationKind.TextSearch,
    )
  ) {
    throw invalidDiscovery();
  }
  const pages = [...(operations as readonly InvestigationPageEvidence[])].sort(
    (left, right) => left.pageOrdinal - right.pageOrdinal,
  );
  const first = pages[0]!;
  if (
    first.operationInputHash !== expectedInitialOperationInputHash ||
    first.pageOrdinal !== 0 ||
    first.cursorInputHash !== null
  ) {
    throw invalidDiscovery();
  }
  let aggregateItemCount = 0;
  let expectedCursorInputHash: string | null = null;
  const pathHashes = new Set<string>();
  for (const [index, page] of pages.entries()) {
    aggregateItemCount += page.pageItemCount;
    if (
      page.pageOrdinal !== index ||
      page.cursorInputHash !== expectedCursorInputHash ||
      page.queryDigest !== first.queryDigest ||
      page.treeOid !== first.treeOid ||
      page.aggregateItemCount !== aggregateItemCount ||
      (index === pages.length - 1
        ? !page.complete || page.nextCursorHash !== null
        : page.complete || page.nextCursorHash === null)
    ) {
      throw invalidDiscovery();
    }
    for (const pathHash of page.pagePathHashes) {
      if (pathHashes.has(pathHash)) throw invalidDiscovery();
      pathHashes.add(pathHash);
    }
    if (page.aggregatePathCount !== pathHashes.size) {
      throw invalidDiscovery();
    }
    expectedCursorInputHash = page.nextCursorHash;
  }
  return Object.freeze({
    pages: Object.freeze(pages),
    pathHashes: Object.freeze([...pathHashes].sort()),
  });
}

function isApprovedProbeSource(
  obligationKind: InvestigationObligationKind,
  probeKind: InvestigationProbeKind,
): boolean {
  switch (probeKind) {
    case InvestigationProbeKind.StructuredKey:
      return (
        obligationKind === InvestigationObligationKind.SchemaContract ||
        obligationKind === InvestigationObligationKind.ConfigurationContract
      );
    case InvestigationProbeKind.RuntimeContractIdentifier:
      return (
        obligationKind === InvestigationObligationKind.ConfigurationContract
      );
    case InvestigationProbeKind.SideEffectIdentifier:
      return obligationKind === InvestigationObligationKind.SideEffectParity;
    case InvestigationProbeKind.DeclarationIdentifier:
    case InvestigationProbeKind.ImportExportIdentifier:
    case InvestigationProbeKind.ModulePath:
    case InvestigationProbeKind.PreviousPath:
    case InvestigationProbeKind.BasenameFallback:
      return (
        obligationKind === InvestigationObligationKind.DirectReferenceSearch
      );
  }
}

function expansionKindFor(
  source: InvestigationObligationKind,
): InvestigationObligationKind {
  switch (source) {
    case InvestigationObligationKind.DirectReferenceSearch:
      return InvestigationObligationKind.DirectCaller;
    case InvestigationObligationKind.SchemaContract:
      return InvestigationObligationKind.DependencyContract;
    case InvestigationObligationKind.ConfigurationContract:
      return InvestigationObligationKind.ExternalContract;
    case InvestigationObligationKind.SideEffectParity:
      return InvestigationObligationKind.TestEvidence;
    default:
      throw invalidDiscovery();
  }
}

function withOrigin(
  seed: SeedInvestigationObligation,
  origin: InvestigationObligationOrigin,
): PolicySeedInvestigationObligation {
  return Object.freeze({ ...seed, origin });
}

function dedupeSeeds(
  seeds: readonly PolicySeedInvestigationObligation[],
): PolicySeedInvestigationObligation[] {
  const result = new Map<string, PolicySeedInvestigationObligation>();
  for (const seed of seeds) {
    const key = seedIdentity(seed);
    const existing = result.get(key);
    if (!existing || seed.riskPriority > existing.riskPriority) {
      result.set(key, seed);
    }
  }
  return [...result.values()];
}

function seedIdentity(
  seed: Pick<
    SeedInvestigationObligation,
    "kind" | "canonicalSubject" | "canonicalRequirement"
  >,
): string {
  return [seed.kind, seed.canonicalSubject, seed.canonicalRequirement].join(
    "\0",
  );
}

function compareSeed(
  left: SeedInvestigationObligation,
  right: SeedInvestigationObligation,
): number {
  return (
    left.kind.localeCompare(right.kind) ||
    left.canonicalSubject.localeCompare(right.canonicalSubject) ||
    left.canonicalRequirement.localeCompare(right.canonicalRequirement)
  );
}

function compareClaim(
  left: PreparedOperationBackedDiscoveryClaim,
  right: PreparedOperationBackedDiscoveryClaim,
): number {
  return (
    left.sourceObligationId.localeCompare(right.sourceObligationId) ||
    left.queryHash.localeCompare(right.queryHash) ||
    left.expectedInitialOperationInputHash.localeCompare(
      right.expectedInitialOperationInputHash,
    ) ||
    left.authenticatedPathSetHash.localeCompare(right.authenticatedPathSetHash)
  );
}

function isVersionedCoverageContract(
  contract: ReviewInvestigationContract,
): boolean {
  return (
    contract.coverageContractVersion ===
      reviewInvestigationCoverageProfileV2.coverageContractVersion &&
    contract.expansionRulesVersion ===
      reviewInvestigationCoverageProfileV2.expansionRulesVersion
  );
}

function invalidSeed(): ReviewInvestigationDomainError {
  return new ReviewInvestigationDomainError(
    "investigation_coverage_seed_invalid",
  );
}

function invalidDiscovery(): ReviewInvestigationDomainError {
  return new ReviewInvestigationDomainError(
    "investigation_operation_backed_discovery_invalid",
  );
}
