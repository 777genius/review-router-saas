import type { ProviderKind } from "@reviewrouter/features-review-providers";
import type {
  ActionRuntimeCompatibilityInput,
  ActionRuntimeCompatibilityPolicyPort,
} from "../../application/ports/action-runtime-compatibility-policy-port.js";

export class StaticActionRuntimeCompatibilityPolicy implements ActionRuntimeCompatibilityPolicyPort {
  private readonly blockedActionVersions: ReadonlySet<string>;
  private readonly providerActionVersionAllowlist: ReadonlyMap<
    ProviderKind,
    ReadonlySet<string>
  >;

  constructor(
    input: {
      readonly blockedActionVersions?: readonly string[];
      readonly providerActionVersionAllowlist?: Partial<
        Record<ProviderKind, readonly string[]>
      >;
    } = {},
  ) {
    this.blockedActionVersions = new Set(
      (input.blockedActionVersions ?? [])
        .map((version) => normalizeActionVersion(version))
        .filter((version) => version.length > 0),
    );
    this.providerActionVersionAllowlist = new Map(
      Object.entries(input.providerActionVersionAllowlist ?? {}).map(
        ([providerKind, versions]) => [
          providerKind as ProviderKind,
          new Set(
            versions
              .map((version) => normalizeActionVersion(version))
              .filter((version) => version.length > 0),
          ),
        ],
      ),
    );
  }

  async assertRuntimeConfigAllowed(
    input: ActionRuntimeCompatibilityInput,
  ): Promise<void> {
    const actionVersion = normalizeActionVersion(input.actionVersion ?? "");
    if (actionVersion && this.blockedActionVersions.has(actionVersion)) {
      throw new Error(`action_version_blocked:${actionVersion}`);
    }
    for (const providerKind of input.providerKinds ?? []) {
      const allowedVersions =
        this.providerActionVersionAllowlist.get(providerKind);
      if (!allowedVersions || allowedVersions.size === 0) {
        continue;
      }
      if (!actionVersion || !allowedVersions.has(actionVersion)) {
        throw new Error(
          `action_version_provider_unsupported:${providerKind}:${actionVersion || "unknown"}`,
        );
      }
    }
  }
}

function normalizeActionVersion(version: string): string {
  return version.trim();
}
