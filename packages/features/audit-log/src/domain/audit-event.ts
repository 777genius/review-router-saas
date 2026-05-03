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
  for (const value of collectStrings(metadata)) {
    if (looksLikeSecret(value)) {
      throw new Error("audit_metadata_contains_secret");
    }
    if (looksLikeCodeOrDiff(value)) {
      throw new Error("audit_metadata_contains_code_or_diff");
    }
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(collectStrings);
  }
  return [];
}

function looksLikeSecret(value: string): boolean {
  return (
    /BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY/.test(value) ||
    /\b[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|AUTH_JSON)[A-Z0-9_]*\s*[:=]\s*\S+/i.test(
      value,
    ) ||
    /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,})\b/.test(value)
  );
}

function looksLikeCodeOrDiff(value: string): boolean {
  return /```|diff --git|@@\s+-\d+|^\+\+\+\s|^---\s/m.test(value);
}
