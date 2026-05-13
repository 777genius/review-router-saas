import type { ProviderKind } from "../../domain/provider-catalog";
import type { ReviewModelOption } from "../../domain/provider-models";

export interface ProviderModelCatalogPort {
  listModels(input: {
    readonly providerKind: ProviderKind;
    readonly signal?: AbortSignal;
  }): Promise<readonly ReviewModelOption[]>;
}
