import type {
  HostedBindingId,
  InvocationGrantId,
  InvocationId,
} from "../../domain/identifiers";

export interface InvocationGrantCapabilityPort {
  issue(input: {
    readonly grantId: InvocationGrantId;
    readonly invocationId: InvocationId;
    readonly repositoryBindingId: HostedBindingId;
    readonly expiresAt: Date;
  }): Promise<{
    readonly plaintextToken: string;
    readonly tokenHash: string;
  }>;
}
