import { describe, expect, it, vi } from "vitest";
import { HttpProviderMutationAuthorityAdapter } from "./http-provider-mutation-authority";
import { AuthoritySerializedMutation } from "../application/provider-mutation-authority";

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
} as const;

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
    const outcome = {
      status: "terminal" as const,
      result: "exact_postcondition" as const,
      ...receipt,
      observation: {
        resource: permit.resource,
        state: permit.expected,
        observedAt: "2026-08-14T00:00:02.000Z",
      },
      completedAt: "2026-08-14T00:00:03.000Z",
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json(permit))
      .mockResolvedValueOnce(Response.json(receipt))
      .mockResolvedValueOnce(Response.json({ authorized: true }))
      .mockResolvedValueOnce(Response.json(outcome));
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

  it("never retries a lost permit issuance", async () => {
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
    ).rejects.toThrow('"code":"provider_http_request_failed"');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("recovers a committed permit after its issuance response is lost", async () => {
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
    const observation = {
      resource: permit.resource,
      state: { fingerprint: `sha256:${"e".repeat(64)}`, version: null },
      observedAt: "2026-08-14T00:00:02.000Z",
    };
    let issued = false;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/recover"))
        return Response.json(
          issued ? { status: "permit", permit } : { status: "absent" },
        );
      if (url.endsWith("/issue")) {
        issued = true;
        throw new Error("response lost after issue commit");
      }
      if (url.endsWith("/consume")) return Response.json(receipt);
      if (url.endsWith("/validate-execution"))
        return Response.json({ authorized: true });
      if (url.endsWith("/complete"))
        return Response.json({ status: "terminal" });
      throw new Error("unexpected authority operation");
    });
    const authority = new HttpProviderMutationAuthorityAdapter(
      "https://authority.invalid",
      "secret",
      fetchImpl,
    );
    const mutate = vi.fn().mockResolvedValue(undefined);
    const input = {
      rolloutId: permit.rolloutId,
      operation: permit.operation,
      resource: permit.resource,
      ownerId: permit.ownerId,
      expected: permit.expected,
      expectedPostcondition: observation.state,
      observe: vi
        .fn()
        .mockResolvedValueOnce({
          resource: permit.resource,
          state: permit.expected,
          observedAt: "2026-08-14T00:00:00.000Z",
        })
        .mockResolvedValue(observation),
      mutate,
    };
    const serialized = new AuthoritySerializedMutation(
      authority,
      () => new Date("2026-08-14T00:00:00.000Z"),
    );
    await expect(serialized.execute(input)).rejects.toThrow(
      '"code":"provider_http_request_failed"',
    );
    await expect(serialized.execute(input)).resolves.toMatchObject({
      status: "applied",
    });
    expect(mutate).toHaveBeenCalledOnce();
  });

  it("retries exact consume and terminal commands after response loss", async () => {
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
    const outcome = {
      status: "terminal" as const,
      result: "exact_postcondition" as const,
      ...receipt,
      observation: {
        resource: permit.resource,
        state: permit.expected,
        observedAt: "2026-08-14T00:00:02.000Z",
      },
      completedAt: "2026-08-14T00:00:03.000Z",
    };
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("consume response lost"))
      .mockResolvedValueOnce(Response.json(receipt))
      .mockRejectedValueOnce(new Error("complete response lost"))
      .mockResolvedValueOnce(Response.json(outcome));
    const adapter = new HttpProviderMutationAuthorityAdapter(
      "https://authority.invalid",
      "secret",
      fetchImpl,
    );
    await expect(adapter.consume(permit)).resolves.toEqual(receipt);
    await expect(
      adapter.complete({ receipt, observation: outcome.observation }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("retries the durable recovery read after a lost response", async () => {
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
    const recovery = {
      status: "receipt" as const,
      phase: "executing" as const,
      reconciliationOnly: true,
      receipt,
    };
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("recovery response lost"))
      .mockResolvedValueOnce(Response.json(recovery));
    await expect(
      new HttpProviderMutationAuthorityAdapter(
        "https://authority.invalid",
        "secret",
        fetchImpl,
      ).recover({
        rolloutId: permit.rolloutId,
        operation: permit.operation,
        resource: permit.resource,
        ownerId: permit.ownerId,
        expected: permit.expected,
        leaseSeconds: 60,
      }),
    ).resolves.toEqual(recovery);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("converges committed consume and complete response loss without a duplicate provider write", async () => {
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
    const observation = {
      resource: permit.resource,
      state: { fingerprint: `sha256:${"e".repeat(64)}`, version: null },
      observedAt: "2026-08-14T00:00:02.000Z",
    };
    const outcome = {
      status: "terminal" as const,
      result: "exact_postcondition" as const,
      ...receipt,
      observation,
      completedAt: "2026-08-14T00:00:03.000Z",
    };
    let consumeCommitted = false;
    let completeCommitted = false;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/recover")) return Response.json({ status: "absent" });
      if (url.endsWith("/issue")) return Response.json(permit);
      if (url.endsWith("/consume")) {
        if (!consumeCommitted) {
          consumeCommitted = true;
          throw new Error("response lost after consume commit");
        }
        return Response.json(receipt);
      }
      if (url.endsWith("/validate-execution"))
        return Response.json({ authorized: true });
      if (url.endsWith("/complete")) {
        if (!completeCommitted) {
          completeCommitted = true;
          throw new Error("response lost after complete commit");
        }
        return Response.json(outcome);
      }
      throw new Error("unexpected authority operation");
    });
    const mutate = vi.fn().mockResolvedValue(undefined);
    const observe = vi
      .fn()
      .mockResolvedValueOnce({
        resource: permit.resource,
        state: permit.expected,
        observedAt: "2026-08-14T00:00:00.000Z",
      })
      .mockResolvedValue(observation);
    const authority = new HttpProviderMutationAuthorityAdapter(
      "https://authority.invalid",
      "secret",
      fetchImpl,
    );
    await expect(
      new AuthoritySerializedMutation(
        authority,
        () => new Date("2026-08-14T00:00:00.000Z"),
      ).execute({
        rolloutId: permit.rolloutId,
        operation: permit.operation,
        resource: permit.resource,
        ownerId: permit.ownerId,
        expected: permit.expected,
        expectedPostcondition: observation.state,
        observe,
        mutate,
      }),
    ).resolves.toMatchObject({ status: "applied" });
    expect(mutate).toHaveBeenCalledOnce();
    expect(consumeCommitted).toBe(true);
    expect(completeCommitted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(7);
  });

  it("drops invalid JSON bodies, response headers, and request tokens", async () => {
    const response = new Response("response-auth-json-canary", {
      status: 200,
      headers: { "set-cookie": "cookie-canary" },
    });
    const error = await new HttpProviderMutationAuthorityAdapter(
      "https://authority.invalid",
      "render-token-canary",
      vi.fn().mockResolvedValue(response),
    )
      .issue({
        rolloutId: permit.rolloutId,
        operation: permit.operation,
        resource: permit.resource,
        ownerId: permit.ownerId,
        expected: permit.expected,
        leaseSeconds: 60,
      })
      .catch((value: unknown) => value);
    for (const output of [String(error), JSON.stringify(error)]) {
      expect(output.length).toBeLessThan(768);
      expect(output).not.toMatch(
        /response-auth-json-canary|cookie-canary|render-token-canary/u,
      );
    }
  });
});
