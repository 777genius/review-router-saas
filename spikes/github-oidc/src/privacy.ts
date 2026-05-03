import { z } from 'zod';

const secretPatterns = [
  /gh[pousr]_[A-Za-z0-9_]{20,}/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /CODEX_AUTH_JSON/i,
  /OPENAI_API_KEY/i,
  /OPENROUTER_API_KEY/i,
];

const codeDiffPatterns = [
  /diff --git a\//,
  /@@ -\d+,?\d* \+\d+,?\d* @@/,
  /\+\+\+ b\//,
  /--- a\//,
];

export const healthReportSchema = z.object({
  protocolVersion: z.literal('v1'),
  actionVersion: z.string().min(1).max(100),
  configVersion: z.number().int().nonnegative(),
  configSource: z.enum(['saas', 'static', 'fallback']),
  status: z.enum(['started', 'succeeded', 'failed', 'skipped']),
  providerTypes: z.array(z.string().max(80)).max(10).default([]),
  safeErrorCode: z.string().max(120).optional(),
  safeErrorSummary: z.string().max(2_000).optional(),
});

export type HealthReport = z.infer<typeof healthReportSchema>;

export function assertPrivacySafeString(value: string): void {
  for (const pattern of [...secretPatterns, ...codeDiffPatterns]) {
    if (pattern.test(value)) throw new Error('payload contains prohibited secret/code-like content');
  }
}

export function parseHealthReport(input: unknown): HealthReport {
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized, 'utf8') > 64 * 1024) {
    throw new Error('health report exceeds 64 KB limit');
  }
  assertPrivacySafeString(serialized);
  return healthReportSchema.parse(input);
}
