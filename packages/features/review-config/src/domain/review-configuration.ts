import { z } from "zod";

export const reviewConfigurationSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  provider: z.object({
    kind: z.enum(["codex", "openrouter"]),
    authMode: z.enum([
      "codex_subscription_oauth",
      "codex_openai_api_key",
      "openrouter_api_key",
    ]),
    model: z.string().min(1),
    reasoningEffort: z.enum(["low", "medium", "high"]).default("medium"),
    agenticContext: z.boolean().default(true),
  }),
  blockingPolicy: z.object({
    failOnSeverity: z.enum(["off", "critical", "major"]).default("critical"),
  }),
  limits: z.object({
    inlineMaxComments: z.number().int().min(0).max(50).default(5),
    targetTokensPerBatch: z.number().int().min(4000).max(200000).default(50000),
  }),
});

export type ReviewConfiguration = z.infer<typeof reviewConfigurationSchema>;

export const safeDefaultReviewConfiguration = reviewConfigurationSchema.parse({
  provider: {
    kind: "codex",
    authMode: "codex_subscription_oauth",
    model: "gpt-5.5",
    reasoningEffort: "medium",
    agenticContext: true,
  },
  blockingPolicy: { failOnSeverity: "critical" },
  limits: { inlineMaxComments: 5, targetTokensPerBatch: 50000 },
});

export function parseReviewConfiguration(input: unknown): ReviewConfiguration {
  return reviewConfigurationSchema.parse(input);
}
