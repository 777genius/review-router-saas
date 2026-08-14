import { describe, expect, it, vi } from "vitest";
import { HttpProviderMutationAuthorityAdapter } from "./http-provider-mutation-authority";

const permit = {
  rolloutId: "rollout-one",
  operation: "freeze:srv-one",
  resource: { provider: "render", kind: "service", id: "srv-one" },
  ownerId: "actor-one",
  epoch: 1,
  permitId: "a".repeat(64),
  token: "b".repeat(64),
  expected: { fingerprint: `sha256:${"c".repeat(64)}`, version: null },
  issuedAt: "2026-08-14T00:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
  singleUse: true as const,
};

describe("HTTP provider mutation authority", () => {
  it("uses one bounded HTTP command per authority transition", async () => {
    const receipt = {
      rolloutId: permit.rolloutId,
      operation: permit.operation,
      resource: permit.resource,
      ownerId: permit.ownerId,
      epoch: permit.epoch,
      permitId: permit.permitId,
      receiptId: "d".repeat(64),
      expected: permit.expected,
      consumedAt: "2026-08-14T00:00:01.000Z",
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json(permit))
      .mockResolvedValueOnce(Response.json(receipt))
      .mockResolvedValueOnce(Response.json({ authorized: true }))
      .mockResolvedValueOnce(Response.json({ completed: true }));
    const adapter = new HttpProviderMutationAuthorityAdapter(
      "https://authority.invalid",
      "secret",
      fetchImpl,
    );
    await expect(
      adapter.issue({
        rolloutId: permit.rolloutId,
        operation: permit.operation,
        resource: permit.resource,
        ownerId: permit.ownerId,
        expected: permit.expected,
        leaseSeconds: 60,
      }),
    ).resolves.toEqual(permit);
    await expect(adapter.consume(permit)).resolves.toEqual(receipt);
    await expect(adapter.validateExecution(receipt)).resolves.toBe(true);
    await expect(
      adapter.complete({
        receipt,
        observation: {
          resource: permit.resource,
          state: permit.expected,
          observedAt: "2026-08-14T00:00:02.000Z",
        },
      }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(
      fetchImpl.mock.calls.every(([, init]) => init?.method === "POST"),
    ).toBe(true);
  });

  it("never retries a lost authority write", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("hung/lost"));
    await expect(
      new HttpProviderMutationAuthorityAdapter(
        "https://authority.invalid",
        "secret",
        fetchImpl,
      ).issue({
        rolloutId: permit.rolloutId,
        operation: permit.operation,
        resource: permit.resource,
        ownerId: permit.ownerId,
        expected: permit.expected,
        leaseSeconds: 60,
      }),
    ).rejects.toThrow("provider_http_mutation_authority_issue_network");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
