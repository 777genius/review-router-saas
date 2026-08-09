import type { CodexRotatingSetupPayloadClaim } from "../../domain/codex-rotating-setup-payload-claim";

export interface CodexRotatingSetupPayloadClaimPort {
  claim(claim: CodexRotatingSetupPayloadClaim): Promise<{
    readonly status: "claimed" | "already_claimed" | "already_confirmed";
  }>;
}
