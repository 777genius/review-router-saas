import {
  fetchOpenRouterCatalog,
  listReviewModelOptions,
  normalizeOpenRouterModelsResponse,
  OpenRouterModelCatalogAdapter,
  type OpenRouterCatalogModel,
  type ReviewModelOption,
} from "@reviewrouter/features-review-providers";

export type { OpenRouterCatalogModel, ReviewModelOption };
export { fetchOpenRouterCatalog, normalizeOpenRouterModelsResponse };

const defaultOpenRouterModelCatalog = new OpenRouterModelCatalogAdapter();

export async function getReviewModelOptions(input?: {
  readonly fetchImpl?: typeof fetch;
  readonly now?: number;
}): Promise<readonly ReviewModelOption[]> {
  const now = input?.now;
  const modelCatalog = input?.fetchImpl
    ? new OpenRouterModelCatalogAdapter({
        fetchImpl: input.fetchImpl,
        ...(now !== undefined ? { now: () => now } : {}),
      })
    : defaultOpenRouterModelCatalog;

  return listReviewModelOptions({ modelCatalog });
}

export async function getOpenRouterCatalog(input?: {
  readonly fetchImpl?: typeof fetch;
  readonly now?: number;
}): Promise<readonly OpenRouterCatalogModel[]> {
  const now = input?.now;
  const modelCatalog = new OpenRouterModelCatalogAdapter({
    ...(input?.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(now !== undefined ? { now: () => now } : {}),
  });
  return modelCatalog.getOpenRouterCatalog();
}
