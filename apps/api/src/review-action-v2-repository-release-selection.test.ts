import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalReviewProtocolLimits,
  ProducerReleaseState,
  ProducerDistributionKind,
  ReviewCapabilityProfile,
  type ProducerRelease,
  type ReviewProtocolLimitsV2,
} from "@reviewrouter/features-review-run-control";
import {
  createRepositoryReleaseSelector,
  parseRepositoryReleaseBindings,
} from "./review-action-v2-repository-release-selection";
import { reviewActionV2AbsoluteProtocolMaxima } from "./review-action-v2-protocol-policy";
import { inspectRepositoryReleaseSelection } from "./review-action-v2-operator-cli";

function fixture() {
  const profile = (
    id: string,
    lease: number,
    report: number,
  ): ReviewProtocolLimitsV2 => {
    const limits = {
      ...reviewActionV2AbsoluteProtocolMaxima,
      maxLeaseDurationMs: lease,
      maxResultReportDurationMs: report,
    };
    return {
      ...limits,
      protocolLimitsProfileId: id,
      registeredAt: new Date(),
      limitsDigest: createHash("sha256")
        .update(canonicalReviewProtocolLimits(limits))
        .digest("hex"),
    };
  };
  const baseProfile = profile("base-limits", 600_000, 1_200_000);
  const selectedProfile = profile("padel-limits", 2_100_000, 2_400_000);
  const base: ProducerRelease = {
    producerReleaseId: "base",
    distributionKind: ProducerDistributionKind.PublicReusable,
    actionCommitSha: "a".repeat(40),
    runtimeCommitSha: "b".repeat(40),
    wrapperEntrypointDigest: null,
    runtimeEntrypointDigest: "c".repeat(64),
    contextGatewayPolicyVersion: null,
    contextGatewayEntrypointDigest: null,
    reviewInvestigationProfile: null,
    schemaDigest: "d".repeat(64),
    capabilityProfile: ReviewCapabilityProfile.ExactRevisionV2,
    protocolLimitsProfileId: baseProfile.protocolLimitsProfileId,
    operationalSloProfileId: "slo",
    state: ProducerReleaseState.Registered,
    registeredAt: new Date(),
    revokedAt: null,
  };
  const selected = {
    ...base,
    producerReleaseId: "padel",
    protocolLimitsProfileId: selectedProfile.protocolLimitsProfileId,
  };
  const releases = new Map<string, ProducerRelease>([
    ["base", base],
    ["padel", selected],
  ]);
  const profiles = new Map([
    [baseProfile.protocolLimitsProfileId, baseProfile],
    [selectedProfile.protocolLimitsProfileId, selectedProfile],
  ]);
  const binding = {
    workspaceId: "workspace",
    repositoryConnectionId: "repository",
    scmRepositoryIdentityId: "identity",
    actionCommitSha: base.actionCommitSha,
    expectedBaseProducerReleaseId: "base",
    selectedProducerReleaseId: "padel",
    protocolLimitsProfileId: selectedProfile.protocolLimitsProfileId,
    limitsDigest: selectedProfile.limitsDigest,
  };
  const queries = {
    findProducerReleaseById: async (id: string) => releases.get(id) ?? null,
    findProtocolLimitsProfileById: async (id: string) =>
      profiles.get(id) ?? null,
  };
  const raw = JSON.stringify([binding]);
  return {
    base,
    selected,
    baseProfile,
    selectedProfile,
    releases,
    profiles,
    binding,
    raw,
    queries,
    selector: createRepositoryReleaseSelector(raw, queries),
  };
}

describe("repository release selection", () => {
  it("defaults disabled and freezes strict process configuration", async () => {
    const f = fixture();
    expect(
      await createRepositoryReleaseSelector(undefined, f.queries).select({
        ...f.binding,
        baseRelease: f.base,
      }),
    ).toBe(f.base);
    const parsed = parseRepositoryReleaseBindings(f.raw);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed[0])).toBe(true);
  });
  it("selects the registered 35/40 minute variant", async () => {
    const f = fixture();
    expect(await f.selector.select({ ...f.binding, baseRelease: f.base })).toBe(
      f.selected,
    );
  });
  it.each([
    "workspaceId",
    "repositoryConnectionId",
    "scmRepositoryIdentityId",
    "actionCommitSha",
  ] as const)("isolates %s", async (key) => {
    const f = fixture();
    expect(
      await f.selector.select({
        ...f.binding,
        [key]: "other",
        baseRelease: f.base,
      }),
    ).toBe(f.base);
  });
  it.each(["", "null", "{}", '[{"workspaceId":"*"}]'])(
    "rejects malformed configuration %s",
    (raw) => {
      expect(() => parseRepositoryReleaseBindings(raw)).toThrow();
    },
  );
  it("rejects duplicates, unknown fields and wildcard scopes", () => {
    const f = fixture();
    for (const bindings of [
      [f.binding, f.binding],
      [{ ...f.binding, unexpected: true }],
      [{ ...f.binding, workspaceId: "*" }],
      [{ ...f.binding, repositoryConnectionId: undefined }],
    ]) {
      expect(() =>
        parseRepositoryReleaseBindings(JSON.stringify(bindings)),
      ).toThrow();
    }
  });
  it("fails closed on changed base identity", async () => {
    const f = fixture();
    await expect(
      f.selector.select({
        ...f.binding,
        baseRelease: { ...f.base, producerReleaseId: "changed" },
      }),
    ).rejects.toThrow();
  });
  it.each(["base", "padel"])(
    "rejects missing or revoked release %s",
    async (id) => {
      const f = fixture();
      f.releases.set(id, {
        ...f.releases.get(id)!,
        state: ProducerReleaseState.Revoked,
      });
      await expect(
        f.selector.select({ ...f.binding, baseRelease: f.base }),
      ).rejects.toThrow();
      f.releases.delete(id);
      await expect(
        f.selector.select({ ...f.binding, baseRelease: f.base }),
      ).rejects.toThrow();
    },
  );
  it.each([
    "runtimeCommitSha",
    "runtimeEntrypointDigest",
    "wrapperEntrypointDigest",
    "schemaDigest",
    "capabilityProfile",
    "contextGatewayPolicyVersion",
    "contextGatewayEntrypointDigest",
    "operationalSloProfileId",
    "distributionKind",
    "reviewInvestigationProfile",
  ])("rejects artifact drift: %s", (key) => {
    const f = fixture();
    f.releases.set("padel", { ...f.selected, [key]: "changed" });
    return expect(
      f.selector.select({ ...f.binding, baseRelease: f.base }),
    ).rejects.toThrow();
  });
  it.each([
    "limitsDigest",
    "maxWorkSlots",
    "maxLeaseDurationMs",
    "maxResultReportDurationMs",
    "maxReconciliationDurationMs",
  ])("rejects invalid profile: %s", async (key) => {
    const f = fixture();
    f.profiles.set("padel-limits", {
      ...f.selectedProfile,
      [key]: key === "limitsDigest" ? "0".repeat(64) : 0,
    });
    await expect(
      f.selector.select({ ...f.binding, baseRelease: f.base }),
    ).rejects.toThrow();
  });
  it.each([
    { maxLeaseDurationMs: 3_600_001 },
    { maxLeaseDurationMs: 0.5 },
    { maxLeaseDurationMs: Number.MAX_SAFE_INTEGER + 1 },
    { maxResultReportDurationMs: 2_099_999 },
    { maxLeaseDurationMs: undefined },
  ])("rejects canonical invalid duration bounds %j", async (changes) => {
    const f = fixture();
    const profile = {
      ...f.selectedProfile,
      ...changes,
    } as ReviewProtocolLimitsV2;
    const digest = createHash("sha256")
      .update(canonicalReviewProtocolLimits(profile))
      .digest("hex");
    f.profiles.set("padel-limits", { ...profile, limitsDigest: digest });
    const selector = createRepositoryReleaseSelector(
      JSON.stringify([{ ...f.binding, limitsDigest: digest }]),
      f.queries,
    );
    await expect(
      selector.select({ ...f.binding, baseRelease: f.base }),
    ).rejects.toThrow();
  });

  it("rejects missing profiles and canonical but changed non-duration limits", async () => {
    const f = fixture();
    const changed = { ...f.selectedProfile, maxWorkSlots: 1 };
    changed.limitsDigest = createHash("sha256")
      .update(canonicalReviewProtocolLimits(changed))
      .digest("hex");
    f.profiles.set("padel-limits", changed);
    await expect(
      createRepositoryReleaseSelector(
        JSON.stringify([{ ...f.binding, limitsDigest: changed.limitsDigest }]),
        f.queries,
      ).select({ ...f.binding, baseRelease: f.base }),
    ).rejects.toThrow();
    f.profiles.delete("padel-limits");
    await expect(
      f.selector.select({ ...f.binding, baseRelease: f.base }),
    ).rejects.toThrow();
  });
  it("preflight returns only sanitized scope, policy identity and duration differences", async () => {
    const f = fixture();
    const input = {
      raw: f.raw,
      actionCommitSha: f.base.actionCommitSha,
      queries: f.queries,
      repositories: [
        {
          id: "repository",
          workspaceId: "workspace",
          scmRepositoryIdentityId: "identity",
        },
      ],
    };
    const result = await inspectRepositoryReleaseSelection(input);
    expect(result.durations.after).toEqual({
      maxLeaseDurationMs: 2_100_000,
      maxResultReportDurationMs: 2_400_000,
    });
    expect(result.configurationDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result).not.toHaveProperty("runtimeEntrypointDigest");
    await expect(
      inspectRepositoryReleaseSelection({
        ...input,
        repositories: [...input.repositories, ...input.repositories],
      }),
    ).rejects.toThrow("ambiguous");
    await expect(
      inspectRepositoryReleaseSelection({ ...input, raw: undefined }),
    ).rejects.toThrow("binding_missing");
  });
});
