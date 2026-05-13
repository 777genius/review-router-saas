import type {
  ProviderAuthMode,
  ProviderKind,
} from "@reviewrouter/features-review-providers";

export type ActionRuntimeCompatibilityInput = {
  readonly protocolVersion: 1;
  readonly actionVersion?: string;
  readonly providerKinds?: readonly ProviderKind[];
  readonly providerAuthModes?: readonly ProviderAuthMode[];
};

export interface ActionRuntimeCompatibilityPolicyPort {
  assertRuntimeConfigAllowed(
    input: ActionRuntimeCompatibilityInput,
  ): Promise<void>;
}
