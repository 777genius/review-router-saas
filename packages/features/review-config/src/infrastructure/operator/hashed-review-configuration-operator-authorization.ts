import { createHash, timingSafeEqual } from "node:crypto";
import {
  type ReviewConfigurationOperatorAuthorizationPort,
  type ReviewConfigurationOperatorOperation,
  type ReviewConfigurationOperatorPrincipal,
} from "../../application/ports/review-configuration-operator-ports";

export class HashedReviewConfigurationOperatorAuthorization implements ReviewConfigurationOperatorAuthorizationPort {
  private readonly expectedDigest: Buffer;
  private readonly operatorId: string;

  constructor(operatorId: string, credentialSha256: string) {
    const normalizedOperatorId = operatorId.trim();
    const normalizedCredentialSha256 = credentialSha256.toLowerCase();
    if (!normalizedOperatorId || normalizedOperatorId.length > 120) {
      throw new Error("review_configuration_operator_id_invalid");
    }
    if (!/^[a-f0-9]{64}$/.test(normalizedCredentialSha256)) {
      throw new Error("review_configuration_operator_credential_hash_invalid");
    }
    this.operatorId = normalizedOperatorId;
    this.expectedDigest = Buffer.from(normalizedCredentialSha256, "hex");
  }

  async authenticate(input: {
    readonly credential: string;
    readonly operation: ReviewConfigurationOperatorOperation;
  }): Promise<ReviewConfigurationOperatorPrincipal | null> {
    void input.operation;
    if (input.credential.length < 1 || input.credential.length > 8_192) {
      return null;
    }
    const candidate = createHash("sha256")
      .update(input.credential, "utf8")
      .digest();
    return timingSafeEqual(this.expectedDigest, candidate)
      ? { operatorId: this.operatorId }
      : null;
  }
}
