import type {
  ActivationAuthorization,
  ActivationReceipt,
} from "@reviewrouter/features-release-rollout";
import { activationCatalogPolicyDigestsEqual } from "@reviewrouter/features-release-rollout";
import type { TargetActivationFacts } from "../domain/model.js";

const digest = /^sha256:[a-f0-9]{64}$/u;

const sameOrderedValues = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

/**
 * One fail-closed identity invariant shared by normal activation finalization and
 * uncertain-boundary reconciliation. A proposed ledger receipt, when supplied,
 * must describe the exact independently observed target activation.
 */
export function targetActivationIdentityMatches(
  input: Readonly<{
    target: TargetActivationFacts;
    authorization: ActivationAuthorization;
    proposedReceipt?: ActivationReceipt;
    expectedReceiptSha256?: string;
  }>,
): boolean {
  const { target, authorization, proposedReceipt, expectedReceiptSha256 } =
    input;
  const targetMatchesAuthorization =
    target.rolloutId === authorization.rolloutId &&
    target.expectedCommitSha === authorization.expectedCommitSha &&
    target.sourceSystemIdentifier === authorization.sourceSystemIdentifier &&
    target.targetSystemIdentifier === authorization.targetSystemIdentifier &&
    target.postgresMajor === authorization.postgresMajor &&
    target.migrationChecksum === authorization.migrationChecksum &&
    target.permitEpoch === authorization.epoch &&
    target.permitNonce === authorization.nonce &&
    sameOrderedValues(target.targetDeployIds, authorization.targetDeployIds) &&
    target.firstWriteBoundary === true &&
    digest.test(target.canonicalPrivilegesSha256) &&
    digest.test(target.catalogFactsSha256) &&
    digest.test(target.preactivationCatalogPolicySha256) &&
    digest.test(target.activatedCatalogPolicySha256) &&
    activationCatalogPolicyDigestsEqual(target) &&
    digest.test(target.beforePrincipalInventorySha256) &&
    digest.test(target.beforePrincipalPolicySha256) &&
    digest.test(target.activatedPrincipalInventorySha256) &&
    digest.test(target.activatedPrincipalPolicySha256) &&
    digest.test(target.firstWriteReceiptSha256) &&
    digest.test(target.activationObservationSha256) &&
    /^[0-9]+$/u.test(target.transactionId) &&
    Number.isFinite(Date.parse(target.activatedAt));

  if (!targetMatchesAuthorization) return false;
  if (!proposedReceipt) return true;

  return (
    proposedReceipt.rolloutId === target.rolloutId &&
    proposedReceipt.expectedCommitSha === target.expectedCommitSha &&
    proposedReceipt.sourceSystemIdentifier === target.sourceSystemIdentifier &&
    proposedReceipt.targetSystemIdentifier === target.targetSystemIdentifier &&
    proposedReceipt.observedAt === target.activatedAt &&
    proposedReceipt.observationSha256 === target.activationObservationSha256 &&
    proposedReceipt.previousReceiptSha256 ===
      authorization.previousReceiptSha256 &&
    proposedReceipt.canonicalPrivilegesSha256 ===
      target.canonicalPrivilegesSha256 &&
    proposedReceipt.catalogFactsSha256 === target.catalogFactsSha256 &&
    proposedReceipt.preactivationCatalogPolicySha256 ===
      target.preactivationCatalogPolicySha256 &&
    proposedReceipt.activatedCatalogPolicySha256 ===
      target.activatedCatalogPolicySha256 &&
    activationCatalogPolicyDigestsEqual(proposedReceipt) &&
    proposedReceipt.beforePrincipalInventorySha256 ===
      target.beforePrincipalInventorySha256 &&
    proposedReceipt.beforePrincipalPolicySha256 ===
      target.beforePrincipalPolicySha256 &&
    proposedReceipt.activatedPrincipalInventorySha256 ===
      target.activatedPrincipalInventorySha256 &&
    proposedReceipt.activatedPrincipalPolicySha256 ===
      target.activatedPrincipalPolicySha256 &&
    proposedReceipt.transactionId === target.transactionId &&
    proposedReceipt.firstWriteReceiptSha256 ===
      target.firstWriteReceiptSha256 &&
    proposedReceipt.firstWriteBoundary === target.firstWriteBoundary &&
    proposedReceipt.postgresMajor === target.postgresMajor &&
    proposedReceipt.migrationChecksum === target.migrationChecksum &&
    proposedReceipt.permitEpoch === target.permitEpoch &&
    proposedReceipt.permitNonce === target.permitNonce &&
    sameOrderedValues(
      proposedReceipt.targetDeployIds,
      target.targetDeployIds,
    ) &&
    proposedReceipt.receiptSha256 === expectedReceiptSha256
  );
}
