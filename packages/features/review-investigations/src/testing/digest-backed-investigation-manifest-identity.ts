import type { InvestigationDigestPort } from "../application/ports/digest-port";
import type { InvestigationManifestIdentityPort } from "../application/ports/investigation-manifest-identity-port";

export function digestBackedInvestigationManifestIdentity(
  digest: InvestigationDigestPort,
): InvestigationManifestIdentityPort {
  return Object.freeze({
    computeManifestKey: (canonicalJson: string) =>
      digest.digestUtf8(canonicalJson),
  });
}
