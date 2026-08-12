import type {
  ProviderAuthorityDecision,
  ProviderAuthorityDecisionPort,
  ProviderAuthorityRequest,
} from "../application/ports";
import type { RenderFetch } from "./render-api";

export class HttpProviderAuthorityDecisionAdapter implements ProviderAuthorityDecisionPort {
  constructor(
    private readonly origin: string,
    private readonly token: string,
    private readonly fetchImpl: RenderFetch = fetch,
  ) {
    if (!origin.startsWith("https://") || !token)
      throw new Error("provider_authority_configuration_invalid");
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
      throw new Error(`provider_authority_decision_denied:${response.status}`);
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new Error("provider_authority_decision_response_invalid");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("provider_authority_decision_response_invalid");
    return value as ProviderAuthorityDecision;
  }
}
