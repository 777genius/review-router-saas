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

export type ReviewModelOption = {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
};

type OpenRouterCatalogModel = {
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

const codexModelOptions: readonly ReviewModelOption[] = [
  { value: "gpt-5.5", label: "GPT-5.5", description: "Codex default model." },
  { value: "gpt-5.4", label: "GPT-5.4", description: "Codex model." },
  {
    value: "gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    description: "Lower-latency Codex model.",
  },
  {
    value: "gpt-5.3-codex",
    label: "GPT-5.3 Codex",
    description: "Codex-specialized model.",
  },
  {
    value: "gpt-5.3-codex-spark",
    label: "GPT-5.3 Codex Spark",
    description: "Fast Codex-specialized model.",
  },
  { value: "gpt-5.2", label: "GPT-5.2", description: "Codex model." },
];

const fallbackOpenRouterCatalog: readonly OpenRouterCatalogModel[] = [
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
    id: "openai/gpt-oss-120b:free",
    name: "OpenAI: gpt-oss-120b (free)",
    contextTokens: 131072,
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

let cachedOpenRouterCatalog: {
  readonly expiresAt: number;
  readonly models: readonly OpenRouterCatalogModel[];
} | null = null;

export async function getReviewModelOptions(input?: {
  readonly fetchImpl?: typeof fetch;
  readonly now?: number;
}): Promise<readonly ReviewModelOption[]> {
  const openRouterModels = await getOpenRouterCatalog(input);
  return [
    ...codexModelOptions,
    ...openRouterModels.map(formatOpenRouterModelOption),
  ];
}

export async function getOpenRouterCatalog(input?: {
  readonly fetchImpl?: typeof fetch;
  readonly now?: number;
}): Promise<readonly OpenRouterCatalogModel[]> {
  const now = input?.now ?? Date.now();
  const useDefaultFetch = !input?.fetchImpl;

  if (
    useDefaultFetch &&
    cachedOpenRouterCatalog &&
    cachedOpenRouterCatalog.expiresAt > now
  ) {
    return cachedOpenRouterCatalog.models;
  }

  try {
    const models = await fetchOpenRouterCatalog(input?.fetchImpl ?? fetch);
    if (useDefaultFetch) {
      cachedOpenRouterCatalog = {
        models,
        expiresAt: now + cacheTtlMs,
      };
    }
    return models;
  } catch {
    return fallbackOpenRouterCatalog;
  }
}

export async function fetchOpenRouterCatalog(
  fetchImpl: typeof fetch,
): Promise<readonly OpenRouterCatalogModel[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);

  try {
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
  const disabledReason = getDisabledReason(model);

  return {
    value: model.id,
    label: `OpenRouter: ${model.name}`,
    description: disabledReason
      ? `${model.id} - ${pricing} - ${context}. ${disabledReason}`
      : `${model.id} - ${pricing} - ${context}`,
    ...(disabledReason ? { disabled: true } : {}),
  };
}

function getDisabledReason(model: OpenRouterCatalogModel): string | null {
  if (!model.supportsReviewText) {
    return "Not a text review model.";
  }
  if (!model.isFree) {
    return "Paid model, enable paid OpenRouter mode first.";
  }
  if (model.id.startsWith("openrouter/")) {
    return "OpenRouter router-owned ids need action runtime support first.";
  }
  return null;
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
