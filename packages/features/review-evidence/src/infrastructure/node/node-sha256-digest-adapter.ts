import { createHash } from "node:crypto";
import type { Sha256DigestPort } from "../../application/ports/sha256-digest-port";

export class NodeSha256DigestAdapter implements Sha256DigestPort {
  async digest(bytes: Uint8Array): Promise<string> {
    return createHash("sha256").update(bytes).digest("hex");
  }
}
