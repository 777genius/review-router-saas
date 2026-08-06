import {
  assertDigest,
  assertIdentifier,
  canonicalJson,
} from "../../domain/canonicalization";
import {
  InvestigationPrivateMaterialExpiryDisposition,
  InvestigationPrivateMaterialExpiryReason,
} from "../../domain/investigation-private-material";
import {
  reconcileInvestigationPrivateMaterialExpiry,
  type ReviewInvestigation,
} from "../../domain/review-investigation";
import type { InvestigationDigestPort } from "../ports/digest-port";
import {
  requireValidDossierDigest,
  withCurrentDossierDigest,
} from "./investigation-use-case-support";

export type ReconcileExpiredInvestigationPrivateMaterialResult = Readonly<{
  disposition: InvestigationPrivateMaterialExpiryDisposition;
  investigation: ReviewInvestigation;
  affectedObligationIds: readonly string[];
  expiredTurnId: string | null;
  command: Readonly<{
    commandId: string;
    commandHash: string;
  }> | null;
}>;

export class ReconcileExpiredInvestigationPrivateMaterial {
  constructor(private readonly digest: InvestigationDigestPort) {}

  async execute(input: {
    readonly investigation: ReviewInvestigation;
    readonly privateMaterialIds: readonly string[];
    readonly obligationIds: readonly string[];
    readonly expiredAt: string;
  }): Promise<ReconcileExpiredInvestigationPrivateMaterialResult> {
    await requireValidDossierDigest(this.digest, input.investigation);
    const privateMaterialIds = uniqueSortedIdentifiers(
      input.privateMaterialIds,
      "private_material_id",
    );
    if (privateMaterialIds.length === 0) {
      throw new Error("investigation_private_material_expiry_batch_empty");
    }
    const obligationIds = uniqueSortedIdentifiers(
      input.obligationIds,
      "private_material_obligation_id",
    );
    const reconciled = reconcileInvestigationPrivateMaterialExpiry({
      investigation: input.investigation,
      obligationIds,
      expiredAt: input.expiredAt,
    });
    if (
      reconciled.disposition !==
      InvestigationPrivateMaterialExpiryDisposition.Inconclusive
    ) {
      return { ...reconciled, command: null };
    }

    const investigation = await withCurrentDossierDigest(
      this.digest,
      reconciled.investigation,
    );
    const commandHash = await this.digest.digestUtf8(
      canonicalJson({
        operation: "reconcile_expired_investigation_private_material",
        command: {
          investigationId: investigation.investigationId,
          expectedVersion: input.investigation.version,
          resultingVersion: investigation.version,
          privateMaterialIds,
          affectedObligationIds: reconciled.affectedObligationIds,
          expiredTurnId: reconciled.expiredTurnId,
          reason:
            InvestigationPrivateMaterialExpiryReason.RegenerationUnavailable,
          expiredAt: input.expiredAt,
        },
      }),
    );
    assertDigest(commandHash, "private_material_expiry_command_hash");
    return {
      ...reconciled,
      investigation,
      command: {
        commandId: `private-material-expiry-${commandHash}`,
        commandHash,
      },
    };
  }
}

function uniqueSortedIdentifiers(
  values: readonly string[],
  field: string,
): readonly string[] {
  for (const value of values) assertIdentifier(value, field);
  return Object.freeze([...new Set(values)].sort());
}
