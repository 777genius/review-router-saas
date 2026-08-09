import {
  codexRotatingSetupPayloadClaimSchema,
  type CodexRotatingSetupPayloadClaim,
} from "../../domain/codex-rotating-setup-payload-claim";
import type { CodexRotatingSetupPayloadClaimPort } from "../ports/codex-rotating-setup-payload-claim-port";

export async function prepareCodexRotatingSetup(
  input: unknown,
  dependencies: { readonly claims: CodexRotatingSetupPayloadClaimPort },
): Promise<{
  readonly status: "claimed" | "already_claimed" | "already_confirmed";
}> {
  const claim: CodexRotatingSetupPayloadClaim =
    codexRotatingSetupPayloadClaimSchema.parse(input);
  return dependencies.claims.claim(claim);
}
