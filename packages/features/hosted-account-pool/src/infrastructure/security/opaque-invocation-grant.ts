import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { InvocationGrantCapabilityPort } from "../../application/ports/invocation-grant-capability-port";

export type IssuedOpaqueInvocationGrant = {
  readonly plaintextToken: string;
  readonly tokenHash: string;
};

/** The plaintext capability exists only in the issuance response; persistence is hash-only. */
export class OpaqueInvocationGrantTokenService implements InvocationGrantCapabilityPort {
  async issue(): Promise<IssuedOpaqueInvocationGrant> {
    const plaintextToken = randomBytes(32).toString("base64url");
    return { plaintextToken, tokenHash: this.hash(plaintextToken) };
  }

  hash(plaintextGrant: string): string {
    if (!/^[A-Za-z0-9_-]{43}$/.test(plaintextGrant)) {
      throw new Error("hosted_invocation_grant_invalid");
    }
    return createHash("sha256").update(plaintextGrant, "utf8").digest("hex");
  }

  matches(plaintextGrant: string, expectedHash: string): boolean {
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) return false;
    let actual: Buffer;
    try {
      actual = Buffer.from(this.hash(plaintextGrant), "hex");
    } catch {
      return false;
    }
    return timingSafeEqual(actual, Buffer.from(expectedHash, "hex"));
  }
}
