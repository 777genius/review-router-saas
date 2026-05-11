import { describe, expect, it } from "vitest";
import {
  getReviewModelOptions,
  normalizeOpenRouterModelsResponse,
} from "./openrouter-model-catalog";

describe("openrouter model catalog", () => {
  it("normalizes pricing to dollars per million tokens", () => {
    const models = normalizeOpenRouterModelsResponse({
      data: [
        {
          id: "vendor/paid",
          name: "Vendor Paid",
          context_length: 128000,
          architecture: {
            input_modalities: ["text"],
            output_modalities: ["text"],
          },
          pricing: { prompt: "0.0000005", completion: "0.000001" },
        },
        {
          id: "vendor/free:free",
          name: "Vendor Free",
          context_length: 64000,
          architecture: {
            input_modalities: ["text"],
            output_modalities: ["text"],
          },
          pricing: { prompt: "0", completion: "0" },
        },
      ],
    });

    expect(models).toMatchObject([
      {
        id: "vendor/free:free",
        promptUsdPer1M: 0,
        completionUsdPer1M: 0,
        isFree: true,
      },
      {
        id: "vendor/paid",
        promptUsdPer1M: 0.5,
        completionUsdPer1M: 1,
        isFree: false,
      },
    ]);
  });

  it("keeps paid OpenRouter models visible but disabled in form options", async () => {
    const fetchImpl = async () =>
      Response.json({
        data: [
          {
            id: "vendor/paid",
            name: "Vendor Paid",
            context_length: 128000,
            architecture: {
              input_modalities: ["text"],
              output_modalities: ["text"],
            },
            pricing: { prompt: "0.0000005", completion: "0.000001" },
          },
          {
            id: "vendor/free:free",
            name: "Vendor Free",
            context_length: 64000,
            architecture: {
              input_modalities: ["text"],
              output_modalities: ["text"],
            },
            pricing: { prompt: "0", completion: "0" },
          },
          {
            id: "openrouter/free",
            name: "OpenRouter Free Router",
            context_length: 200000,
            architecture: {
              input_modalities: ["text"],
              output_modalities: ["text"],
            },
            pricing: { prompt: "0", completion: "0" },
          },
          {
            id: "vendor/audio-output",
            name: "Vendor Audio Output",
            context_length: 64000,
            architecture: {
              input_modalities: ["text"],
              output_modalities: ["text", "audio"],
            },
            pricing: { prompt: "0", completion: "0" },
          },
        ],
      });

    const options = await getReviewModelOptions({ fetchImpl });
    const free = options.find((option) => option.value === "vendor/free:free");
    const paid = options.find((option) => option.value === "vendor/paid");
    const openRouterOwned = options.find(
      (option) => option.value === "openrouter/free",
    );
    const audioOutput = options.find(
      (option) => option.value === "vendor/audio-output",
    );

    expect(free).toMatchObject({
      label: "Vendor Free",
      provider: "openrouter",
      badge: "FREE",
    });
    expect(free?.disabled).toBeUndefined();
    expect(free?.description).toContain("$0/$0 per 1M");
    expect(paid).toMatchObject({
      label: "Vendor Paid",
      badge: "PAID",
      disabled: true,
    });
    expect(paid?.description).toContain("$0.50/$1.00 per 1M");
    expect(openRouterOwned).toMatchObject({
      label: "OpenRouter Free Router",
      badge: "Unsupported",
      disabled: true,
    });
    expect(openRouterOwned?.description).toContain(
      "router-owned ids need action runtime support",
    );
    expect(audioOutput).toMatchObject({
      label: "Vendor Audio Output",
      badge: "Unsupported",
      disabled: true,
    });
    expect(audioOutput?.description).toContain("Not a text review model");
  });
});
