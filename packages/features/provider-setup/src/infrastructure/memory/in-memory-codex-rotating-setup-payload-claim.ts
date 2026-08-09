import type { CodexRotatingSetupPayloadClaimPort } from "../../application/ports/codex-rotating-setup-payload-claim-port";
import {
  codexRotatingSetupPayloadClaimsMatch,
  type CodexRotatingSetupPayloadClaim,
} from "../../domain/codex-rotating-setup-payload-claim";

export class InMemoryCodexRotatingSetupPayloadClaim implements CodexRotatingSetupPayloadClaimPort {
  readonly #claims = new Map<string, CodexRotatingSetupPayloadClaim>();

  async claim(claim: CodexRotatingSetupPayloadClaim) {
    const existing = this.#claims.get(claim.setupNonce);
    if (!existing) {
      this.#claims.set(claim.setupNonce, { ...claim });
      return { status: "claimed" as const };
    }
    if (!codexRotatingSetupPayloadClaimsMatch(existing, claim)) {
      throw new Error("codex_rotating_setup_payload_claim_conflict");
    }
    return { status: "already_claimed" as const };
  }
}
