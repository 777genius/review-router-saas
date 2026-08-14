import type { ProviderMutationAuthorityPort } from "../application/provider-mutation-authority";
import type {
  MutationExecutionReceipt,
  OneShotMutationPermit,
} from "../domain/provider-mutation";
import {
  BoundedProviderHttpClient,
  ProviderHttpError,
} from "./bounded-provider-io";
import type { RenderFetch } from "./render-api";

export class HttpProviderMutationAuthorityAdapter implements ProviderMutationAuthorityPort {
  private readonly http: BoundedProviderHttpClient;
  constructor(
    private readonly origin: string,
    private readonly token: string,
    fetchImpl: RenderFetch = fetch,
  ) {
    if (!origin.startsWith("https://") || !token)
      throw new Error("provider_mutation_authority_configuration_invalid");
    this.http = new BoundedProviderHttpClient(fetchImpl);
  }

  issue(
    input: Parameters<ProviderMutationAuthorityPort["issue"]>[0],
  ): Promise<OneShotMutationPermit> {
    return this.command("issue", input);
  }
  consume(input: OneShotMutationPermit): Promise<MutationExecutionReceipt> {
    return this.command("consume", input);
  }
  async validateExecution(input: MutationExecutionReceipt): Promise<boolean> {
    const value = await this.command<Record<string, unknown>>(
      "validate-execution",
      input,
    );
    if (value.authorized !== true)
      throw new Error("provider_mutation_execution_not_authorized");
    return true;
  }
  async complete(
    input: Parameters<ProviderMutationAuthorityPort["complete"]>[0],
  ): Promise<void> {
    await this.command("complete", input);
  }
  async reconcile(
    input: Parameters<ProviderMutationAuthorityPort["reconcile"]>[0],
  ): Promise<void> {
    await this.command("reconcile", input);
  }

  private async command<T>(operation: string, body: unknown): Promise<T> {
    const response = await this.http.request(
      `mutation_authority_${operation}`,
      `${this.origin.replace(/\/$/u, "")}/v1/provider-mutations/${operation}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok)
      throw new ProviderHttpError(
        `mutation_authority_${operation}`,
        "response_status",
        response.status,
        true,
      );
    try {
      return (response.status === 204 ? undefined : await response.json()) as T;
    } catch {
      throw new ProviderHttpError(
        `mutation_authority_${operation}`,
        "response_invalid",
        response.status,
        true,
      );
    }
  }
}
