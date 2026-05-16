import {
  listStaticReviewModelOptions,
  type ReviewModelOption,
} from "../../domain/provider-models";
import type { ProviderModelCatalogPort } from "../ports/provider-model-catalog-port";

export async function listReviewModelOptions(input?: {
  readonly modelCatalog?: ProviderModelCatalogPort;
  readonly signal?: AbortSignal;
}): Promise<readonly ReviewModelOption[]> {
  const staticOptions = listStaticReviewModelOptions();
  if (!input?.modelCatalog) {
    return staticOptions;
  }
  const openRouterOptions = await input.modelCatalog.listModels({
    providerKind: "openrouter",
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return [...staticOptions, ...openRouterOptions];
}
