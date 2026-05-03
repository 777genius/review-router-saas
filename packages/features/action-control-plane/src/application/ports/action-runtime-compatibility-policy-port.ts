export type ActionRuntimeCompatibilityInput = {
  readonly protocolVersion: 1;
  readonly actionVersion?: string;
};

export interface ActionRuntimeCompatibilityPolicyPort {
  assertRuntimeConfigAllowed(
    input: ActionRuntimeCompatibilityInput,
  ): Promise<void>;
}
