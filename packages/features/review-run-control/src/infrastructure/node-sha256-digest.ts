import { createHash } from "node:crypto";
import type { Sha256DigestPort } from "../application/ports/platform-ports";

export class NodeSha256Digest implements Sha256DigestPort {
  async digestUtf8(value: string): Promise<string> {
    return createHash("sha256").update(value, "utf8").digest("hex");
  }
}
