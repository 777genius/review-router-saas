import {
  collectPayloadStrings,
  looksLikeCodeOrDiff,
  looksLikeSecretValue,
} from "@reviewrouter/shared";
import { z } from "zod";

export const auditEventSchema = z.object({
  workspaceId: z.string().min(1),
  actor: z.string().min(1).max(120),
  action: z.string().min(1).max(120),
  targetType: z.string().min(1).max(80),
  targetId: z.string().min(1).max(160),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type AuditEventInput = z.infer<typeof auditEventSchema>;

export function sanitizeAuditMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const serialized = JSON.stringify(metadata);
  if (Buffer.byteLength(serialized, "utf8") > 4096) {
    throw new Error("audit_metadata_too_large");
  }
  for (const value of collectPayloadStrings(metadata)) {
    if (looksLikeSecretValue(value)) {
      throw new Error("audit_metadata_contains_secret");
    }
    if (looksLikeCodeOrDiff(value)) {
      throw new Error("audit_metadata_contains_code_or_diff");
    }
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}
