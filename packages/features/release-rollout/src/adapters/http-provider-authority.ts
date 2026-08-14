import type {
  ProviderAuthorityDecision,
  ProviderAuthorityDecisionPort,
  ProviderAuthorityRequest,
} from "../application/ports";
import type { RenderFetch } from "./render-api";
import {
  BoundedProviderHttpClient,
  ProviderHttpError,
} from "./bounded-provider-io";

export class HttpProviderAuthorityDecisionAdapter implements ProviderAuthorityDecisionPort {
  private readonly fetchImpl: RenderFetch;
  constructor(
    private readonly origin: string,
    private readonly token: string,
    fetchImpl: RenderFetch = fetch,
  ) {
    if (!origin.startsWith("https://") || !token)
      throw new Error("provider_authority_configuration_invalid");
    const http = new BoundedProviderHttpClient(fetchImpl);
    this.fetchImpl = (url, init) =>
      http.request("provider_authority", url, init);
  }

  async decide(
    input: ProviderAuthorityRequest,
  ): Promise<ProviderAuthorityDecision> {
    const response = await this.fetchImpl(
      `${this.origin.replace(/\/$/u, "")}/v1/provider-authority/decisions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      },
    );
    if (response.status !== 200)
      throw new ProviderHttpError(
        "provider_authority",
        "response_status",
        response.status,
        true,
      );
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new ProviderHttpError(
        "provider_authority",
        "response_invalid",
        response.status,
        true,
      );
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ProviderHttpError(
        "provider_authority",
        "response_invalid",
        response.status,
        true,
      );
    return value as ProviderAuthorityDecision;
  }
}
