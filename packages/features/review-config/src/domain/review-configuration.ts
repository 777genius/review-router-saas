import {
  defaultCodexModel,
  gatewayReferenceSchema,
  gatewayModelSchema,
  defaultProviderReasoningEffort,
  codexModelSupportsReasoningEffort,
  providerAuthModeBelongsToKind,
  providerAuthModeSchema,
  providerKindSchema,
} from "@reviewrouter/features-review-providers";
import { z } from "zod";

const reviewProviderSettingsSchema = z.object({
  kind: providerKindSchema,
  model: z.string().trim().min(1),
  reasoningEffort: z
    .enum(["low", "medium", "high", "xhigh", "max", "ultra"])
    .default(defaultProviderReasoningEffort),
  agenticContext: z.boolean().default(true),
  fastMode: z.boolean().default(false),
  requiredHealthy: z.boolean().default(false),
});

export const reviewProviderConfigurationSchema = z
  .discriminatedUnion("authMode", [
    reviewProviderSettingsSchema.extend({
      authMode: providerAuthModeSchema.exclude(["codex_account_gateway"]),
      gatewayBindingId: z.never().optional(),
      gatewayProfileRef: z.never().optional(),
    }),
    reviewProviderSettingsSchema
      .extend({
        kind: z.literal("codex"),
        authMode: z.literal("codex_account_gateway"),
        model: gatewayModelSchema,
        gatewayBindingId: gatewayReferenceSchema,
        gatewayProfileRef: gatewayReferenceSchema,
      })
      .strict(),
  ])
  .superRefine((provider, context) => {
    if (!providerAuthModeBelongsToKind(provider.authMode, provider.kind)) {
      context.addIssue({
        code: "custom",
        path: ["authMode"],
        message: "provider auth mode does not belong to provider kind",
      });
    }
  });

/**
 * Sanitize a free-text language name before it is stored or sent to a model.
 * Keeps a single line of letters/marks/spaces plus a few separators, caps the
 * length, and drops everything else so the value cannot smuggle instructions.
 */
function sanitizeReviewLanguage(value: string): string | undefined {
  const firstLine = value.split(/[\r\n]/)[0] ?? "";
  const cleaned = firstLine
    .replace(/[^\p{L}\p{M}\s()\-/]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  return cleaned.length > 0 ? cleaned : undefined;
}

const reviewLanguageSchema = z
  .string()
  .transform(sanitizeReviewLanguage)
  .optional();

const blockingPolicySchema = z.object({
  failOnSeverity: z.enum(["off", "critical", "major"]).default("critical"),
});

const limitsSchema = z.object({
  inlineMaxComments: z.number().int().min(0).max(50).default(50),
  targetTokensPerBatch: z.number().int().min(4000).max(200000).default(50000),
});

const reviewExecutionConfigurationSchema = z
  .object({
    providerLimit: z.number().int().min(1).max(16).optional(),
    providerMaxParallel: z.number().int().min(1).max(16).default(1),
    inlineMinAgreement: z.number().int().min(1).max(16).default(1),
  })
  .default({ providerMaxParallel: 1, inlineMinAgreement: 1 });

export const disabledReviewInvestigationRolloutConfiguration = Object.freeze({
  recordingEnabled: false,
  shadowEnabled: false,
  contextCriticEnabled: false,
  verifiedCleanEnabled: false,
  crossRevisionReplayEnabled: false,
  productionEffectsEnabled: false,
});

export const defaultReviewInvestigationRolloutConfiguration = Object.freeze({
  recordingEnabled: true,
  shadowEnabled: true,
  contextCriticEnabled: true,
  verifiedCleanEnabled: true,
  crossRevisionReplayEnabled: false,
  productionEffectsEnabled: true,
});

export const reviewInvestigationRolloutConfigurationSchema = z
  .object({
    recordingEnabled: z.boolean().default(false),
    shadowEnabled: z.boolean().default(false),
    contextCriticEnabled: z.boolean().default(false),
    verifiedCleanEnabled: z.boolean().default(false),
    crossRevisionReplayEnabled: z.boolean().default(false),
    productionEffectsEnabled: z.boolean().default(false),
  })
  .strict()
  .default(disabledReviewInvestigationRolloutConfiguration);

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
  reviewLanguage: reviewLanguageSchema,
  investigationRollout: reviewInvestigationRolloutConfigurationSchema,
});

export type ReviewProviderConfiguration = z.infer<
  typeof reviewProviderConfigurationSchema
>;

export type ReviewExecutionConfiguration = {
  readonly providerLimit: number;
  readonly providerMaxParallel: number;
  readonly inlineMinAgreement: number;
};

export type ReviewInvestigationRolloutConfiguration = z.infer<
  typeof reviewInvestigationRolloutConfigurationSchema
>;

export type ReviewConfiguration = {
  readonly schemaVersion: 2;
  readonly providers: readonly ReviewProviderConfiguration[];
  readonly provider: ReviewProviderConfiguration;
  readonly execution: ReviewExecutionConfiguration;
  readonly blockingPolicy: z.infer<typeof blockingPolicySchema>;
  readonly limits: z.infer<typeof limitsSchema>;
  readonly reviewLanguage?: string;
  readonly investigationRollout: ReviewInvestigationRolloutConfiguration;
};

const reviewConfigurationInputSchema = z.union([
  reviewConfigurationV2Schema,
  reviewConfigurationV1Schema,
]);

type ReviewConfigurationInput = z.infer<typeof reviewConfigurationInputSchema>;

type NormalizeReviewConfigurationOptions = {
  readonly rejectDuplicateProviderRows: boolean;
};

const tolerantNormalizeOptions = {
  rejectDuplicateProviderRows: false,
} satisfies NormalizeReviewConfigurationOptions;

const strictNormalizeOptions = {
  rejectDuplicateProviderRows: true,
} satisfies NormalizeReviewConfigurationOptions;

export const reviewConfigurationSchema =
  reviewConfigurationInputSchema.transform((input) =>
    normalizeReviewConfiguration(input, tolerantNormalizeOptions),
  );

const parsedSafeDefaultReviewConfiguration = parseReviewConfiguration({
  schemaVersion: 2,
  providers: [
    {
      kind: "codex",
      authMode: "codex_subscription_oauth_rotating",
      model: defaultCodexModel,
      reasoningEffort: defaultProviderReasoningEffort,
      agenticContext: true,
      fastMode: false,
    },
  ],
  blockingPolicy: { failOnSeverity: "critical" },
  limits: { inlineMaxComments: 50, targetTokensPerBatch: 50000 },
  investigationRollout: defaultReviewInvestigationRolloutConfiguration,
});

// Keep the known legacy default precise when callers derive another provider
// from it. Gateway references are valid only on explicitly parsed gateway rows.
const safeDefaultProvider = parsedSafeDefaultReviewConfiguration.provider;
if (
  safeDefaultProvider.authMode === "codex_account_gateway" ||
  parsedSafeDefaultReviewConfiguration.providers.length !== 1
) {
  throw new Error("review_configuration_default_requires_legacy_provider");
}
export const safeDefaultReviewConfiguration = {
  ...parsedSafeDefaultReviewConfiguration,
  provider: safeDefaultProvider,
  providers: [safeDefaultProvider] as const,
} satisfies ReviewConfiguration;

export function parseReviewConfiguration(input: unknown): ReviewConfiguration {
  return reviewConfigurationSchema.parse(input);
}

export function parseReviewConfigurationStrict(
  input: unknown,
): ReviewConfiguration {
  return normalizeReviewConfiguration(
    reviewConfigurationInputSchema.parse(input),
    strictNormalizeOptions,
  );
}

function normalizeReviewConfiguration(
  input: ReviewConfigurationInput,
  options: NormalizeReviewConfigurationOptions,
): ReviewConfiguration {
  const parsedProviders =
    input.schemaVersion === 1 ? [input.provider] : [...input.providers];
  const providers = ensureRequiredHealthyProvider(
    normalizeProductionCodexProviders(parsedProviders, options),
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
    investigationRollout: {
      ...(input.schemaVersion === 2
        ? input.investigationRollout
        : disabledReviewInvestigationRolloutConfiguration),
    },
    ...(input.schemaVersion === 2 && input.reviewLanguage !== undefined
      ? { reviewLanguage: input.reviewLanguage }
      : {}),
  };
}

function normalizeProductionCodexProviders(
  providers: readonly ReviewProviderConfiguration[],
  options: NormalizeReviewConfigurationOptions,
): readonly ReviewProviderConfiguration[] {
  const normalizedProviders = providers.map((provider) => {
    if (provider.authMode === "codex_subscription_oauth_hosted_pool") {
      return {
        ...provider,
        kind: "codex" as const,
        requiredHealthy: true,
      };
    }
    if (
      provider.authMode !== "codex_subscription_oauth" &&
      provider.authMode !== "codex_openai_api_key"
    ) {
      return provider.authMode === "codex_subscription_oauth_rotating"
        ? {
            ...provider,
            kind: "codex" as const,
            requiredHealthy: true,
          }
        : provider;
    }
    return {
      ...provider,
      kind: "codex" as const,
      authMode: "codex_subscription_oauth_rotating" as const,
      requiredHealthy: true,
    };
  });

  if (options.rejectDuplicateProviderRows) {
    assertUniqueProviderRows(normalizedProviders);
    assertSupportedReasoningEfforts(normalizedProviders);
  }

  const uniqueProviders = dedupeProviderRows(normalizedProviders);
  const rotatingCodexProviders = uniqueProviders.filter(
    (provider) => provider.authMode === "codex_subscription_oauth_rotating",
  );
  if (rotatingCodexProviders.length > 1) {
    throw new Error("codex_rotating_single_provider_required");
  }

  return uniqueProviders;
}

function assertSupportedReasoningEfforts(
  providers: readonly ReviewProviderConfiguration[],
): void {
  for (const provider of providers) {
    if (
      provider.authMode !== "codex_account_gateway" &&
      !codexModelSupportsReasoningEffort(
        provider.model,
        provider.reasoningEffort,
      )
    ) {
      throw new Error("review_reasoning_effort_unsupported_for_model");
    }
  }
}

function dedupeProviderRows(
  providers: readonly ReviewProviderConfiguration[],
): readonly ReviewProviderConfiguration[] {
  const seen = new Set<string>();
  const uniqueProviders: ReviewProviderConfiguration[] = [];

  for (const provider of providers) {
    const key = providerRowKey(provider);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniqueProviders.push(provider);
  }

  return uniqueProviders;
}

function assertUniqueProviderRows(
  providers: readonly ReviewProviderConfiguration[],
): void {
  const seen = new Set<string>();

  for (const provider of providers) {
    const key = providerRowKey(provider);
    if (seen.has(key)) {
      throw new Error("duplicate_review_provider");
    }
    seen.add(key);
  }
}

function providerRowKey(provider: ReviewProviderConfiguration): string {
  return JSON.stringify([
    provider.kind,
    provider.authMode,
    provider.model.trim(),
    provider.gatewayBindingId ?? null,
    provider.gatewayProfileRef ?? null,
  ]);
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

export const DEFAULT_INLINE_MAX_COMMENTS = 50;
const LEGACY_DEFAULT_INLINE_MAX_COMMENTS = 5;

export function effectiveInlineMaxComments(value: number): number {
  if (value === 0) {
    return 0;
  }
  if (value === LEGACY_DEFAULT_INLINE_MAX_COMMENTS) {
    return DEFAULT_INLINE_MAX_COMMENTS;
  }
  return value;
}

function clamp(value: number | undefined, min: number, max: number): number {
  const fallback = min;
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Number(value), min), max);
}
