import { describe, expect, it } from "vitest";
import {
  listReviewModelOptions,
  listStaticReviewModelOptions,
  normalizeOpenRouterModelsResponse,
  OpenRouterModelCatalogAdapter,
} from "../index";

describe("provider model catalog", () => {
  it("lists static Codex and Claude options", () => {
    const options = listStaticReviewModelOptions();

    expect(options.some((option) => option.provider === "codex")).toBe(true);
    expect(options[0]).toMatchObject({
      provider: "codex",
      value: "gpt-5.6-sol",
    });
    expect(options).toContainEqual(
      expect.objectContaining({
        provider: "claude",
        value: "sonnet",
      }),
    );
  });

  it("combines static options with OpenRouter adapter models", async () => {
    const options = await listReviewModelOptions({
      modelCatalog: {
        listModels: async () => [
          {
            value: "openrouter/test:free",
            label: "OpenRouter Test",
            provider: "openrouter",
          },
        ],
      },
    });

    expect(options.map((option) => option.provider)).toContain("claude");
    expect(options.map((option) => option.value)).toContain(
      "openrouter/test:free",
    );
  });

  it("normalizes and sorts OpenRouter models for review suitability", () => {
    const models = normalizeOpenRouterModelsResponse({
      data: [
        {
          id: "openrouter/router-owned",
          name: "Router owned",
          pricing: { prompt: "0", completion: "0" },
          architecture: {
            input_modalities: ["text"],
            output_modalities: ["text"],
          },
        },
        {
          id: "poolside/laguna-m.1:free",
          name: "Poolside: Laguna M.1 (free)",
          pricing: { prompt: "0", completion: "0" },
          architecture: {
            input_modalities: ["text"],
            output_modalities: ["text"],
          },
        },
        {
          id: "openai/gpt-5.3-codex",
          name: "OpenAI: GPT-5.3 Codex",
          pricing: { prompt: "0.000001", completion: "0.000008" },
          architecture: {
            input_modalities: ["text"],
            output_modalities: ["text"],
          },
        },
      ],
    });
    const adapter = new OpenRouterModelCatalogAdapter({
      fetchImpl: async () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      now: () => 1,
    });

    expect(models[0]?.id).toBe("openai/gpt-5.3-codex");
    expect(models.at(-1)?.id).toBe("openrouter/router-owned");
    expect(adapter).toBeInstanceOf(OpenRouterModelCatalogAdapter);
  });
});
