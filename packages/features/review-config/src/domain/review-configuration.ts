import {
  providerAuthModeBelongsToKind,
  providerAuthModeSchema,
  providerKindSchema,
} from "@reviewrouter/features-review-providers";
import { z } from "zod";

export const reviewProviderConfigurationSchema = z
  .object({
    kind: providerKindSchema,
    authMode: providerAuthModeSchema,
    model: z.string().trim().min(1),
    reasoningEffort: z
      .enum(["low", "medium", "high", "xhigh"])
      .default("medium"),
    agenticContext: z.boolean().default(true),
    fastMode: z.boolean().default(false),
    requiredHealthy: z.boolean().default(false),
  })
  .superRefine((provider, context) => {
    if (!providerAuthModeBelongsToKind(provider.authMode, provider.kind)) {
      context.addIssue({
        code: "custom",
        path: ["authMode"],
        message: "provider auth mode does not belong to provider kind",
      });
    }
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
      authMode: "codex_subscription_oauth_rotating",
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
  const parsedProviders =
    input.schemaVersion === 1 ? [input.provider] : [...input.providers];
  const providers = ensureRequiredHealthyProvider(
    normalizeProductionCodexProviders(parsedProviders),
  );
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

function normalizeProductionCodexProviders(
  providers: readonly ReviewProviderConfiguration[],
): readonly ReviewProviderConfiguration[] {
  const normalizedProviders = providers.map((provider) => {
    if (
      provider.authMode !== "codex_subscription_oauth" &&
      provider.authMode !== "codex_openai_api_key"
    ) {
      return provider;
    }
    return {
      ...provider,
      kind: "codex" as const,
      authMode: "codex_subscription_oauth_rotating" as const,
    };
  });
  const rotatingCodexProvider = normalizedProviders.find(
    (provider) => provider.authMode === "codex_subscription_oauth_rotating",
  );
  if (!rotatingCodexProvider) {
    return normalizedProviders;
  }
  return [{ ...rotatingCodexProvider, requiredHealthy: true }];
}

function ensureRequiredHealthyProvider(
  providers: readonly ReviewProviderConfiguration[],
): readonly ReviewProviderConfiguration[] {
  if (providers.some((provider) => provider.requiredHealthy)) {
    return providers;
  }

  return providers.map((provider, index) => ({
    ...provider,
    requiredHealthy: index === 0,
  }));
}

function clamp(value: number | undefined, min: number, max: number): number {
  const fallback = min;
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Number(value), min), max);
}
