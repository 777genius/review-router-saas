import { z } from "zod";

export const reviewProviderConfigurationSchema = z.object({
  kind: z.enum(["codex", "openrouter"]),
  authMode: z.enum([
    "codex_subscription_oauth",
    "codex_openai_api_key",
    "openrouter_api_key",
  ]),
  model: z.string().min(1),
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]).default("medium"),
  agenticContext: z.boolean().default(true),
  fastMode: z.boolean().default(false),
});

const blockingPolicySchema = z.object({
  failOnSeverity: z.enum(["off", "critical", "major"]).default("critical"),
});

const limitsSchema = z.object({
  inlineMaxComments: z.number().int().min(0).max(50).default(5),
  targetTokensPerBatch: z.number().int().min(4000).max(200000).default(50000),
});

const reviewExecutionConfigurationSchema = z
  .object({
    providerLimit: z.number().int().min(1).max(16).optional(),
    providerMaxParallel: z.number().int().min(1).max(16).default(1),
    inlineMinAgreement: z.number().int().min(1).max(16).default(1),
  })
  .default({ providerMaxParallel: 1, inlineMinAgreement: 1 });

const reviewConfigurationV1Schema = z.object({
  schemaVersion: z.literal(1).default(1),
  provider: reviewProviderConfigurationSchema,
  blockingPolicy: blockingPolicySchema,
  limits: limitsSchema,
});

const reviewConfigurationV2Schema = z.object({
  schemaVersion: z.literal(2).default(2),
  providers: z.array(reviewProviderConfigurationSchema).min(1).max(16),
  provider: reviewProviderConfigurationSchema.optional(),
  execution: reviewExecutionConfigurationSchema,
  blockingPolicy: blockingPolicySchema,
  limits: limitsSchema,
});

export type ReviewProviderConfiguration = z.infer<
  typeof reviewProviderConfigurationSchema
>;

export type ReviewExecutionConfiguration = {
  readonly providerLimit: number;
  readonly providerMaxParallel: number;
  readonly inlineMinAgreement: number;
};

export type ReviewConfiguration = {
  readonly schemaVersion: 2;
  readonly providers: readonly ReviewProviderConfiguration[];
  readonly provider: ReviewProviderConfiguration;
  readonly execution: ReviewExecutionConfiguration;
  readonly blockingPolicy: z.infer<typeof blockingPolicySchema>;
  readonly limits: z.infer<typeof limitsSchema>;
};

export const reviewConfigurationSchema = z
  .union([reviewConfigurationV2Schema, reviewConfigurationV1Schema])
  .transform(normalizeReviewConfiguration);

export const safeDefaultReviewConfiguration = parseReviewConfiguration({
  schemaVersion: 2,
  providers: [
    {
      kind: "codex",
      authMode: "codex_subscription_oauth",
      model: "gpt-5.5",
      reasoningEffort: "medium",
      agenticContext: true,
      fastMode: false,
    },
  ],
  blockingPolicy: { failOnSeverity: "critical" },
  limits: { inlineMaxComments: 5, targetTokensPerBatch: 50000 },
});

export function parseReviewConfiguration(input: unknown): ReviewConfiguration {
  return reviewConfigurationSchema.parse(input);
}

function normalizeReviewConfiguration(
  input:
    | z.infer<typeof reviewConfigurationV1Schema>
    | z.infer<typeof reviewConfigurationV2Schema>,
): ReviewConfiguration {
  const providers =
    input.schemaVersion === 1
      ? [input.provider]
      : input.provider &&
          input.providers.length === 1 &&
          !sameProvider(input.provider, input.providers[0]!)
        ? [input.provider]
        : [...input.providers];
  const provider = providers[0]!;
  const execution =
    input.schemaVersion === 1
      ? { providerMaxParallel: 1, inlineMinAgreement: 1 }
      : input.execution;
  const providerLimit = providers.length;

  return {
    schemaVersion: 2,
    providers,
    provider,
    execution: {
      providerLimit,
      providerMaxParallel: clamp(
        execution.providerMaxParallel,
        1,
        providerLimit,
      ),
      inlineMinAgreement: clamp(execution.inlineMinAgreement, 1, providerLimit),
    },
    blockingPolicy: input.blockingPolicy,
    limits: input.limits,
  };
}

function clamp(value: number | undefined, min: number, max: number): number {
  const fallback = min;
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Number(value), min), max);
}

function sameProvider(
  left: ReviewProviderConfiguration,
  right: ReviewProviderConfiguration,
): boolean {
  return (
    left.kind === right.kind &&
    left.authMode === right.authMode &&
    left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort &&
    left.agenticContext === right.agenticContext &&
    left.fastMode === right.fastMode
  );
}
