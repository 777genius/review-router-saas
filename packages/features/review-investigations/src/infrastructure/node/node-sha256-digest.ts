import { createHash } from "node:crypto";
import type { InvestigationDigestPort } from "../../application/ports/digest-port";

export class NodeSha256InvestigationDigest implements InvestigationDigestPort {
  async digestUtf8(value: string): Promise<string> {
    return createHash("sha256").update(value, "utf8").digest("hex");
  }
}
