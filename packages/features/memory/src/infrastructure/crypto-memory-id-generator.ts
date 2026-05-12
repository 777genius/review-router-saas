import { randomUUID } from "node:crypto";
import type { MemoryIdGeneratorPort } from "../application/ports/memory-id-generator-port";

export class CryptoMemoryIdGenerator implements MemoryIdGeneratorPort {
  newId(prefix: "mem" | "mem_suggestion" | "mem_usage"): string {
    return `${prefix}_${randomUUID()}`;
  }
}
