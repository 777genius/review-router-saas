import type { ProviderKind } from "../../domain/provider-catalog";
import type { ReviewModelOption } from "../../domain/provider-models";
import type { ProviderModelCatalogPort } from "../../application/ports/provider-model-catalog-port";

type OpenRouterPricing = {
  readonly prompt?: unknown;
  readonly completion?: unknown;
};

type OpenRouterArchitecture = {
  readonly input_modalities?: unknown;
  readonly output_modalities?: unknown;
};

type OpenRouterModel = {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly context_length?: unknown;
  readonly pricing?: OpenRouterPricing;
  readonly architecture?: OpenRouterArchitecture;
};

type OpenRouterModelsResponse = {
  readonly data?: unknown;
};

export type OpenRouterCatalogModel = {
  readonly id: string;
  readonly name: string;
  readonly contextTokens: number | null;
  readonly promptUsdPer1M: number | null;
  readonly completionUsdPer1M: number | null;
  readonly isFree: boolean;
  readonly supportsReviewText: boolean;
};

const openRouterModelsUrl = "https://openrouter.ai/api/v1/models";
const cacheTtlMs = 30 * 60 * 1000;
const fetchTimeoutMs = 4000;

const recommendedCodexAgentOpenRouterModelIds = [
  "openai/gpt-5.3-codex",
] as const;

const recommendedFreeOpenRouterModelIds = [
  "poolside/laguna-m.1:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "openai/gpt-oss-120b:free",
  "openrouter/owl-alpha",
] as const;

const supportedOpenRouterOwnedModelIds = new Set<string>([
  "openrouter/owl-alpha",
]);

const fallbackOpenRouterCatalog: readonly OpenRouterCatalogModel[] = [
  {
    id: "openai/gpt-5.3-codex",
    name: "OpenAI: GPT-5.3 Codex",
    contextTokens: null,
    promptUsdPer1M: null,
    completionUsdPer1M: null,
    isFree: false,
    supportsReviewText: true,
  },
  {
    id: "poolside/laguna-m.1:free",
    name: "Poolside: Laguna M.1 (free)",
    contextTokens: 131072,
    promptUsdPer1M: 0,
    completionUsdPer1M: 0,
    isFree: true,
    supportsReviewText: true,
  },
  {
    id: "nvidia/nemotron-3-super-120b-a12b:free",
    name: "NVIDIA: Nemotron 3 Super (free)",
    contextTokens: 262144,
    promptUsdPer1M: 0,
    completionUsdPer1M: 0,
    isFree: true,
    supportsReviewText: true,
  },
  {
    id: "openai/gpt-oss-120b:free",
    name: "OpenAI: gpt-oss-120b (free)",
    contextTokens: 131072,
    promptUsdPer1M: 0,
    completionUsdPer1M: 0,
    isFree: true,
    supportsReviewText: true,
  },
  {
    id: "openrouter/owl-alpha",
    name: "Owl Alpha",
    contextTokens: 1048756,
    promptUsdPer1M: 0,
    completionUsdPer1M: 0,
    isFree: true,
    supportsReviewText: true,
  },
  {
    id: "minimax/minimax-m2.5:free",
    name: "MiniMax: MiniMax M2.5 (free)",
    contextTokens: 196608,
    promptUsdPer1M: 0,
    completionUsdPer1M: 0,
    isFree: true,
    supportsReviewText: true,
  },
  {
    id: "z-ai/glm-4.5-air:free",
    name: "Z.ai: GLM 4.5 Air (free)",
    contextTokens: 131072,
    promptUsdPer1M: 0,
    completionUsdPer1M: 0,
    isFree: true,
    supportsReviewText: true,
  },
];

export class OpenRouterModelCatalogAdapter implements ProviderModelCatalogPort {
  private cachedOpenRouterCatalog: {
    readonly expiresAt: number;
    readonly models: readonly OpenRouterCatalogModel[];
  } | null = null;

  constructor(
    private readonly dependencies: {
      readonly fetchImpl?: typeof fetch;
      readonly now?: () => number;
    } = {},
  ) {}

  async listModels(input: {
    readonly providerKind: ProviderKind;
    readonly signal?: AbortSignal;
  }): Promise<readonly ReviewModelOption[]> {
    if (input.providerKind !== "openrouter") {
      return [];
    }
    const openRouterModels = await this.getOpenRouterCatalog(input.signal);
    return openRouterModels.map(formatOpenRouterModelOption);
  }

  async getOpenRouterCatalog(
    signal?: AbortSignal,
  ): Promise<readonly OpenRouterCatalogModel[]> {
    const now = this.dependencies.now?.() ?? Date.now();
    const useDefaultFetch = !this.dependencies.fetchImpl;

    if (
      useDefaultFetch &&
      this.cachedOpenRouterCatalog &&
      this.cachedOpenRouterCatalog.expiresAt > now
    ) {
      return this.cachedOpenRouterCatalog.models;
    }

    try {
      const models = await fetchOpenRouterCatalog(
        this.dependencies.fetchImpl ?? fetch,
        signal,
      );
      if (useDefaultFetch) {
        this.cachedOpenRouterCatalog = {
          models,
          expiresAt: now + cacheTtlMs,
        };
      }
      return models;
    } catch {
      return fallbackOpenRouterCatalog;
    }
  }
}

export async function fetchOpenRouterCatalog(
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<readonly OpenRouterCatalogModel[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  const abortListener = () => controller.abort();

  try {
    signal?.addEventListener("abort", abortListener, { once: true });
    const response = await fetchImpl(openRouterModelsUrl, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`openrouter_models_fetch_failed:${response.status}`);
    }

    return normalizeOpenRouterModelsResponse(
      (await response.json()) as OpenRouterModelsResponse,
    );
  } finally {
    signal?.removeEventListener("abort", abortListener);
    clearTimeout(timeout);
  }
}

export function normalizeOpenRouterModelsResponse(
  response: OpenRouterModelsResponse,
): readonly OpenRouterCatalogModel[] {
  if (!Array.isArray(response.data)) {
    throw new Error("openrouter_models_invalid_response");
  }

  return response.data
    .map(normalizeOpenRouterModel)
    .filter((model): model is OpenRouterCatalogModel => model !== null)
    .sort(compareOpenRouterCatalogModels);
}

function normalizeOpenRouterModel(
  rawModel: unknown,
): OpenRouterCatalogModel | null {
  if (!rawModel || typeof rawModel !== "object") {
    return null;
  }

  const model = rawModel as OpenRouterModel;
  if (typeof model.id !== "string" || model.id.length === 0) {
    return null;
  }

  const promptUsdPer1M = pricePerTokenToMillionUsd(model.pricing?.prompt);
  const completionUsdPer1M = pricePerTokenToMillionUsd(
    model.pricing?.completion,
  );

  return {
    id: model.id,
    name: typeof model.name === "string" && model.name ? model.name : model.id,
    contextTokens:
      typeof model.context_length === "number" &&
      Number.isFinite(model.context_length)
        ? model.context_length
        : null,
    promptUsdPer1M,
    completionUsdPer1M,
    isFree: promptUsdPer1M === 0 && completionUsdPer1M === 0,
    supportsReviewText: supportsReviewText(model.architecture),
  };
}

function compareOpenRouterCatalogModels(
  left: OpenRouterCatalogModel,
  right: OpenRouterCatalogModel,
): number {
  const leftUnsupported = isUnsupportedOpenRouterModel(left);
  const rightUnsupported = isUnsupportedOpenRouterModel(right);
  if (leftUnsupported !== rightUnsupported) {
    return leftUnsupported ? 1 : -1;
  }

  const leftCodexAgentRank = getRecommendedCodexAgentOpenRouterModelRank(left);
  const rightCodexAgentRank =
    getRecommendedCodexAgentOpenRouterModelRank(right);
  if (leftCodexAgentRank !== rightCodexAgentRank) {
    if (leftCodexAgentRank === null) {
      return 1;
    }
    if (rightCodexAgentRank === null) {
      return -1;
    }
    return leftCodexAgentRank - rightCodexAgentRank;
  }

  const leftRecommendedRank = getRecommendedFreeOpenRouterModelRank(left);
  const rightRecommendedRank = getRecommendedFreeOpenRouterModelRank(right);
  if (leftRecommendedRank !== rightRecommendedRank) {
    if (leftRecommendedRank === null) {
      return 1;
    }
    if (rightRecommendedRank === null) {
      return -1;
    }
    return leftRecommendedRank - rightRecommendedRank;
  }

  if (left.isFree !== right.isFree) {
    return left.isFree ? -1 : 1;
  }

  const leftPrice =
    (left.promptUsdPer1M ?? Number.POSITIVE_INFINITY) +
    (left.completionUsdPer1M ?? Number.POSITIVE_INFINITY);
  const rightPrice =
    (right.promptUsdPer1M ?? Number.POSITIVE_INFINITY) +
    (right.completionUsdPer1M ?? Number.POSITIVE_INFINITY);

  if (leftPrice !== rightPrice) {
    return leftPrice - rightPrice;
  }

  return left.name.localeCompare(right.name);
}

function formatOpenRouterModelOption(
  model: OpenRouterCatalogModel,
): ReviewModelOption {
  const pricing = formatPricing(model);
  const context = model.contextTokens
    ? `${formatTokenCount(model.contextTokens)} context`
    : "context unknown";
  const unsupportedReason = getUnsupportedReason(model);
  const recommendedRank = getRecommendedFreeOpenRouterModelRank(model);
  const badge = unsupportedReason
    ? "Unsupported"
    : recommendedRank !== null
      ? "FREE RECOMMENDED"
      : model.isFree
        ? "FREE"
        : "PAID";

  return {
    value: model.id,
    label: cleanOpenRouterModelName(model.name),
    provider: "openrouter",
    description: unsupportedReason
      ? `${model.id} - ${pricing} - ${context}. ${unsupportedReason}`
      : `${model.id} - ${pricing} - ${context}`,
    ...(badge ? { badge } : {}),
    ...(unsupportedReason ? { disabled: true } : {}),
  };
}

function cleanOpenRouterModelName(value: string): string {
  return value.replace(/\s+\(free\)$/i, "");
}

function getUnsupportedReason(model: OpenRouterCatalogModel): string | null {
  if (!model.supportsReviewText) {
    return "Not a text review model.";
  }
  if (
    model.id.startsWith("openrouter/") &&
    !supportedOpenRouterOwnedModelIds.has(model.id)
  ) {
    return "OpenRouter router-owned ids need action runtime support first.";
  }
  return null;
}

function isUnsupportedOpenRouterModel(model: OpenRouterCatalogModel): boolean {
  return getUnsupportedReason(model) !== null;
}

function getRecommendedCodexAgentOpenRouterModelRank(
  model: OpenRouterCatalogModel,
): number | null {
  if (isUnsupportedOpenRouterModel(model)) {
    return null;
  }

  const index = recommendedCodexAgentOpenRouterModelIds.indexOf(
    model.id as (typeof recommendedCodexAgentOpenRouterModelIds)[number],
  );
  return index === -1 ? null : index;
}

function getRecommendedFreeOpenRouterModelRank(
  model: OpenRouterCatalogModel,
): number | null {
  if (!model.isFree || isUnsupportedOpenRouterModel(model)) {
    return null;
  }

  const index = recommendedFreeOpenRouterModelIds.indexOf(
    model.id as (typeof recommendedFreeOpenRouterModelIds)[number],
  );
  return index === -1 ? null : index;
}

function formatPricing(model: OpenRouterCatalogModel): string {
  return `${formatUsd(model.promptUsdPer1M)}/${formatUsd(model.completionUsdPer1M)} per 1M input/output`;
}

function formatUsd(value: number | null): string {
  if (value === null) {
    return "unknown";
  }
  if (value === 0) {
    return "$0";
  }
  if (value < 0.01) {
    return `$${value.toFixed(4)}`;
  }
  return `$${value.toFixed(2)}`;
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (value >= 1000) {
    return `${Math.round(value / 1000)}K`;
  }
  return String(value);
}

function pricePerTokenToMillionUsd(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return parsed * 1_000_000;
}

function supportsReviewText(
  architecture: OpenRouterArchitecture | undefined,
): boolean {
  const inputModalities = architecture?.input_modalities;
  const outputModalities = architecture?.output_modalities;
  if (!Array.isArray(inputModalities) || !Array.isArray(outputModalities)) {
    return true;
  }
  return (
    inputModalities.includes("text") &&
    outputModalities.length === 1 &&
    outputModalities[0] === "text"
  );
}
