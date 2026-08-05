import {
  assertDigest,
  canonicalJson,
  ReviewInvestigationDomainError,
  type CanonicalValue,
} from "../../domain/canonicalization";
import {
  investigationDossierCanonicalValue,
  type ReviewInvestigation,
} from "../../domain/review-investigation";
import type { EncryptedInvestigationPrivateMaterial } from "../../domain/investigation-private-material";
import {
  InvestigationExecutionAuthorityVerdict,
  type InvestigationExecutionAuthorityPort,
} from "../ports/execution-authority-port";
import type { InvestigationDigestPort } from "../ports/digest-port";
import {
  InvestigationStoreCommitStatus,
  type InvestigationStoreTransition,
  type InvestigationStorePort,
} from "../ports/investigation-store-port";

export async function digestCanonical(
  digest: InvestigationDigestPort,
  value: CanonicalValue,
): Promise<string> {
  return digest.digestUtf8(canonicalJson(value));
}

export async function admitInvestigationManifest(input: {
  readonly canonicalJson: string;
  readonly hash: string;
  readonly digest: InvestigationDigestPort;
}): Promise<Readonly<{ canonicalJson: string; hash: string }>> {
  assertDigest(input.hash, "investigation_manifest_hash");
  let normalized: string;
  try {
    normalized = canonicalJson(JSON.parse(input.canonicalJson));
  } catch {
    throw new ReviewInvestigationDomainError(
      "investigation_manifest_not_canonical",
    );
  }
  if (
    normalized !== input.canonicalJson ||
    (await input.digest.digestUtf8(normalized)) !== input.hash
  ) {
    throw new ReviewInvestigationDomainError(
      "investigation_manifest_hash_mismatch",
    );
  }
  return Object.freeze({ canonicalJson: normalized, hash: input.hash });
}

export async function withCurrentDossierDigest(
  digest: InvestigationDigestPort,
  investigation: ReviewInvestigation,
): Promise<ReviewInvestigation> {
  return {
    ...investigation,
    dossierDigest: await digestCanonical(
      digest,
      investigationDossierCanonicalValue(investigation),
    ),
  };
}

export async function requireCurrentExecution(input: {
  readonly authority: InvestigationExecutionAuthorityPort;
  readonly investigation: Pick<
    ReviewInvestigation,
    "scope" | "revision" | "executionId" | "workSlotId" | "providerVoteLaneId"
  >;
}): Promise<void> {
  const verdict = await input.authority.check(input.investigation);
  if (verdict !== InvestigationExecutionAuthorityVerdict.Current) {
    throw new Error(`investigation_execution_${verdict}`);
  }
}

export async function commitOrThrow(input: {
  readonly store: InvestigationStorePort;
  readonly investigation: ReviewInvestigation;
  readonly expectedVersion: number | null;
  readonly commandId: string;
  readonly commandHash: string;
  readonly transition: InvestigationStoreTransition;
  readonly privateMaterials?: readonly EncryptedInvestigationPrivateMaterial[];
}): Promise<ReviewInvestigation> {
  const result = await input.store.commit(input);
  switch (result.status) {
    case InvestigationStoreCommitStatus.Committed:
    case InvestigationStoreCommitStatus.Restored:
      if (result.investigation === null)
        throw new Error("store_snapshot_missing");
      return result.investigation;
    case InvestigationStoreCommitStatus.ConcurrencyConflict:
      throw new Error("investigation_concurrency_conflict");
    case InvestigationStoreCommitStatus.IdempotencyConflict:
      throw new Error("investigation_idempotency_conflict");
  }
}

export async function restoreCommandOrThrow(input: {
  readonly store: InvestigationStorePort;
  readonly commandId: string;
  readonly commandHash: string;
}): Promise<ReviewInvestigation | null> {
  const result = await input.store.restoreCommand(input);
  if (result === null) return null;
  if (result.status === InvestigationStoreCommitStatus.IdempotencyConflict) {
    throw new Error("investigation_idempotency_conflict");
  }
  if (
    result.status !== InvestigationStoreCommitStatus.Restored ||
    result.investigation === null
  ) {
    throw new Error("investigation_command_restore_invalid");
  }
  return result.investigation;
}
