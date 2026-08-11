import {
  codexRotatingSetupPayloadClaimSchema,
  type CodexRotatingSetupPayloadClaim,
} from "../../domain/codex-rotating-setup-payload-claim";
import type {
  CodexRotatingSetupClaimAdmissionStatus,
  CodexRotatingSetupPayloadClaimPort,
} from "../ports/codex-rotating-setup-payload-claim-port";

export async function prepareCodexRotatingSetup(
  input: unknown,
  dependencies: { readonly claims: CodexRotatingSetupPayloadClaimPort },
): Promise<{
  readonly status: CodexRotatingSetupClaimAdmissionStatus;
  readonly claimId: string;
  readonly claimVersion: number;
  readonly prepareReplayExpiresAt: string;
  readonly recoveryExpiresAt: string;
}> {
  const claim: CodexRotatingSetupPayloadClaim =
    codexRotatingSetupPayloadClaimSchema.parse(input);
  return dependencies.claims.claim(claim);
}
