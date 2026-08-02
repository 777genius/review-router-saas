import { canonicalJson } from "../../domain/canonicalization";
import {
  certificateCandidateCanonicalValue,
  type ReviewInvestigationCertificate,
  type ReviewInvestigationCertificateCandidate,
} from "../../domain/investigation-certificate";
import {
  concludeReviewInvestigation,
  type ReviewInvestigation,
} from "../../domain/review-investigation";
import { ReviewInvestigationConclusion } from "../../domain/review-investigation-types";
import type { InvestigationClockPort } from "../ports/clock-port";
import type { InvestigationDigestPort } from "../ports/digest-port";
import type { InvestigationExecutionAuthorityPort } from "../ports/execution-authority-port";
import {
  InvestigationStoreTransitionKind,
  type InvestigationStorePort,
} from "../ports/investigation-store-port";
import {
  toInvestigationReadModel,
  type ReviewInvestigationReadModel,
} from "../investigation-read-model";
import {
  commitOrThrow,
  digestCanonical,
  requireCurrentExecution,
  restoreCommandOrThrow,
  withCurrentDossierDigest,
} from "./investigation-use-case-support";

export type ConcludeReviewInvestigationCommand = Readonly<{
  commandId: string;
  investigationId: string;
  expectedVersion: number;
  certificateTtlMs: number;
}>;

export class ConcludeReviewInvestigation {
  constructor(
    private readonly store: InvestigationStorePort,
    private readonly authority: InvestigationExecutionAuthorityPort,
    private readonly digest: InvestigationDigestPort,
    private readonly clock: InvestigationClockPort,
  ) {}

  async execute(
    command: ConcludeReviewInvestigationCommand,
  ): Promise<ReviewInvestigationReadModel> {
    const commandHash = await this.digest.digestUtf8(
      canonicalJson({ operation: "conclude_review_investigation", command }),
    );
    const restored = await restoreCommandOrThrow({
      store: this.store,
      commandId: command.commandId,
      commandHash,
    });
    if (restored) return toInvestigationReadModel(restored);
    const current = await this.store.findById(command.investigationId);
    if (current === null) throw new Error("investigation_missing");
    if (current.version !== command.expectedVersion) {
      throw new Error("investigation_concurrency_conflict");
    }
    await requireCurrentExecution({ authority: this.authority, investigation: current });
    if (!Number.isSafeInteger(command.certificateTtlMs) || command.certificateTtlMs <= 0) {
      throw new Error("certificate_ttl_invalid");
    }
    const now = this.clock.now();
    const conclusion =
      current.findings.length > 0
        ? ReviewInvestigationConclusion.Findings
        : ReviewInvestigationConclusion.VerifiedClean;
    const candidate: ReviewInvestigationCertificateCandidate = {
      certificateId: `certificate-${current.investigationId.slice(-32)}`,
      investigationId: current.investigationId,
      investigationVersion: current.version,
      dossierDigest: current.dossierDigest,
      reviewRevisionHash: current.revision.reviewRevisionHash,
      stableReviewUnitKey: current.stableReviewUnitKey,
      providerVoteLaneId: current.providerVoteLaneId,
      coverageContractVersion: current.contract.coverageContractVersion,
      expansionRulesVersion: current.contract.expansionRulesVersion,
      gatewayPolicyVersion: current.contract.gatewayPolicyVersion,
      criticPolicyVersion: current.contract.criticPolicyVersion,
      runtimeProfileVersion: current.contract.runtimeProfileVersion,
      producerReleaseId: current.contract.producerReleaseId,
      conclusion,
      findingSetHash: await digestCanonical(
        this.digest,
        current.findings.map((item) => item.fingerprint).sort(),
      ),
      obligationSetHash: await digestCanonical(
        this.digest,
        current.obligations.map((item) => item.obligationId).sort(),
      ),
      receiptSetHash: await digestCanonical(
        this.digest,
        current.obligations
          .map((item) => item.receipt?.receiptId ?? null)
          .filter((item): item is string => item !== null)
          .sort(),
      ),
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + command.certificateTtlMs).toISOString(),
    };
    const certificate: ReviewInvestigationCertificate = {
      ...candidate,
      certificateHash: await digestCanonical(
        this.digest,
        certificateCandidateCanonicalValue(candidate),
      ),
    };
    let next = concludeReviewInvestigation({
      investigation: current,
      certificate,
      concludedAt: now.toISOString(),
    });
    next = await withCurrentDossierDigest(this.digest, next);
    const committed = await commitOrThrow({
      store: this.store,
      investigation: next,
      expectedVersion: current.version,
      commandId: command.commandId,
      commandHash,
      transition: { kind: InvestigationStoreTransitionKind.Concluded },
    });
    return toInvestigationReadModel(committed);
  }
}

export async function investigationCertificateInputHash(
  digest: InvestigationDigestPort,
  investigation: ReviewInvestigation,
): Promise<string> {
  return digest.digestUtf8(
    canonicalJson({
      dossierDigest: investigation.dossierDigest,
      version: investigation.version,
      state: investigation.state,
    }),
  );
}
