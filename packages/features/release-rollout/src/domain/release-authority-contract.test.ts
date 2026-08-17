import { describe, expect, it } from "vitest";
import {
  providerTrustRootPinIsOpaqueAndExact,
  releaseAuthorityBootstrapLifecycleStates,
} from "./release-authority-contract";

describe("release authority provider trust-root contract", () => {
  it("models the exact lifecycle and treats the root as a pinned opaque identity", () => {
    expect(releaseAuthorityBootstrapLifecycleStates).toEqual([
      "fresh",
      "retryable",
      "cleanup-pending",
      "terminal",
      "drifted",
    ]);
    const pin = {
      contractVersion: 1 as const,
      systemIdentifier: "72623859790382856",
      rootOid: 10,
      rootName: "provider-owned-root",
      providerOid: 16_384,
      providerName: "reviewrouter_bootstrap_administrator" as const,
    };
    expect(providerTrustRootPinIsOpaqueAndExact(pin)).toBe(true);
    expect(
      providerTrustRootPinIsOpaqueAndExact({
        ...pin,
        rootOid: pin.providerOid,
      }),
    ).toBe(false);
  });
});
