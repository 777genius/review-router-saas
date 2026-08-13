import { describe, expect, it, vi } from "vitest";
import { ProviderAuthorityOperation } from "../application/ports";
import { HttpProviderAuthorityDecisionAdapter } from "./http-provider-authority";

const request = {
  rolloutId: "rollout-1",
  operation: ProviderAuthorityOperation.ResumeTarget,
  sourceSystemIdentifier: "100",
  targetSystemIdentifier: "200",
  expectedReceiptSha256: `sha256:${"a".repeat(64)}`,
  activationBoundary: "activated" as const,
};

describe("HTTP provider authority decision", () => {
  it("returns only the remote decision and sends the full binding", async () => {
    const decision = {
      ...request,
      decision: "allow" as const,
      decisionId: "decision-1",
      decidedAt: "2026-08-12T00:00:00.000Z",
    };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(decision), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      new HttpProviderAuthorityDecisionAdapter(
        "https://authority.example.test",
        "secret",
        fetchImpl,
      ).decide(request),
    ).resolves.toEqual(decision);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual(
      request,
    );
  });

  it("fails closed on outage, denial, and absent configuration", async () => {
    expect(() => new HttpProviderAuthorityDecisionAdapter("", "")).toThrow(
      "provider_authority_configuration_invalid",
    );
    await expect(
      new HttpProviderAuthorityDecisionAdapter(
        "https://authority.example.test",
        "secret",
        vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
      ).decide(request),
    ).rejects.toThrow("provider_authority_decision_denied:503");
  });
});
