import type {
  ActionRuntimeCompatibilityInput,
  ActionRuntimeCompatibilityPolicyPort,
} from "../../application/ports/action-runtime-compatibility-policy-port.js";

export class StaticActionRuntimeCompatibilityPolicy implements ActionRuntimeCompatibilityPolicyPort {
  private readonly blockedActionVersions: ReadonlySet<string>;

  constructor(
    input: { readonly blockedActionVersions?: readonly string[] } = {},
  ) {
    this.blockedActionVersions = new Set(
      (input.blockedActionVersions ?? [])
        .map((version) => normalizeActionVersion(version))
        .filter((version) => version.length > 0),
    );
  }

  async assertRuntimeConfigAllowed(
    input: ActionRuntimeCompatibilityInput,
  ): Promise<void> {
    const actionVersion = normalizeActionVersion(input.actionVersion ?? "");
    if (actionVersion && this.blockedActionVersions.has(actionVersion)) {
      throw new Error(`action_version_blocked:${actionVersion}`);
    }
  }
}

function normalizeActionVersion(version: string): string {
  return version.trim();
}
