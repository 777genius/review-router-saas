import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import type { PrismaClient } from "@reviewrouter/platform-db";
import type {
  TargetActivationFacts,
  TargetActivationReceiptReaderPort,
} from "../domain/model.js";

export class RoutineTargetActivationReceiptReaderAdapter implements TargetActivationReceiptReaderPort {
  constructor(private readonly prisma: PrismaClient) {}

  async read(rolloutId: string): Promise<TargetActivationFacts | null> {
    const rows = await this.prisma.$queryRaw<{ value: unknown }[]>(Prisma.sql`
      SELECT reviewrouter_activation.read_activation_receipt(${rolloutId}) AS value
    `);
    if (rows.length !== 1)
      throw new Error("target_activation_receipt_result_invalid");
    const value = rows[0]?.value;
    if (value === null) return null;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("target_activation_receipt_result_invalid");
    return {
      ...value,
      activationObservationSha256: `sha256:${createHash("sha256")
        .update(JSON.stringify(value))
        .digest("hex")}`,
    } as TargetActivationFacts;
  }
}
