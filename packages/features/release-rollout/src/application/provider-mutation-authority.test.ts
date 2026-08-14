import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  MutationExecutionReceipt,
  ObservedProviderPostcondition,
  OneShotMutationPermit,
  ProviderMutationReconciliation,
} from "../domain/provider-mutation";
import {
  AuthoritySerializedMutation,
  type ProviderMutationAuthorityPort,
} from "./provider-mutation-authority";

const digest = (value: string) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const before = { fingerprint: digest("before"), version: null };
const after = { fingerprint: digest("after"), version: null };
const resource = {
  provider: "render",
  kind: "service",
  id: "srv-one",
} as const;
const observed = (state = before): ObservedProviderPostcondition => ({
  resource,
  state,
  observedAt: "2026-08-14T00:00:00.000Z",
});

class FakeAuthority implements ProviderMutationAuthorityPort {
  epoch = 0;
  consumed = new Set<string>();
  active = false;
  reconciliations: ProviderMutationReconciliation[] = [];
  completed = 0;
  expiresAt = "2026-08-14T00:01:00.000Z";
  lastPermit: OneShotMutationPermit | undefined;
  recovery: Awaited<ReturnType<ProviderMutationAuthorityPort["recover"]>> = {
    status: "absent",
  };

  async recover() {
    return this.recovery;
  }

  async issue(input: Parameters<ProviderMutationAuthorityPort["issue"]>[0]) {
    if (this.active) throw new Error("provider_mutation_lease_held");
    this.active = true;
    this.epoch += 1;
    return (this.lastPermit = {
      ...input,
      epoch: this.epoch,
      permitId: `permit-${this.epoch}`,
      token: "a".repeat(64),
      issuedAt: "2026-08-14T00:00:00.000Z",
      expiresAt: this.expiresAt,
      singleUse: true as const,
    });
  }
  async consume(permit: OneShotMutationPermit) {
    if (this.consumed.has(permit.permitId))
      throw new Error("provider_mutation_permit_consumed");
    this.consumed.add(permit.permitId);
    return {
      rolloutId: permit.rolloutId,
      operation: permit.operation,
      resource: permit.resource,
      ownerId: permit.ownerId,
      epoch: permit.epoch,
      permitId: permit.permitId,
      expected: permit.expected,
      receiptId: `receipt-${permit.epoch}`,
      consumedAt: "2026-08-14T00:00:01.000Z",
    } satisfies MutationExecutionReceipt;
  }
  async validateExecution(receipt: MutationExecutionReceipt) {
    return this.consumed.has(receipt.permitId) && this.active;
  }
  async complete() {
    this.completed += 1;
    this.active = false;
  }
  async reconcile(input: ProviderMutationReconciliation) {
    this.reconciliations.push(input);
    this.active = false;
  }
}

type ExecuteInput = Parameters<AuthoritySerializedMutation["execute"]>[0];
const execute = (
  authority: FakeAuthority,
  overrides: Partial<ExecuteInput> = {},
) =>
  new AuthoritySerializedMutation(
    authority,
    () => new Date("2026-08-14T00:00:02.000Z"),
  ).execute({
    rolloutId: "rollout-one",
    operation: "suspend_service",
    resource,
    ownerId: "actor-one",
    expected: before,
    expectedPostcondition: after,
    observe: vi
      .fn()
      .mockResolvedValueOnce(observed(before))
      .mockResolvedValue(observed(after)),
    mutate: vi.fn().mockResolvedValue(undefined),
    identifyResult: () => ({ kind: "service", id: resource.id }),
    ...overrides,
  });

describe("authority-serialized provider mutation", () => {
  it("resumes a durable consumed receipt after a crash before provider I/O", async () => {
    const authority = new FakeAuthority();
    const permit = await authority.issue({
      rolloutId: "rollout-one",
      operation: "suspend_service",
      resource,
      ownerId: "actor-one",
      expected: before,
      leaseSeconds: 60,
    });
    const receipt = await authority.consume(permit);
    authority.recovery = {
      status: "receipt",
      phase: "consumed",
      reconciliationOnly: false,
      receipt,
    };
    const mutate = vi.fn().mockResolvedValue(undefined);
    await expect(execute(authority, { mutate })).resolves.toMatchObject({
      status: "applied",
    });
    expect(mutate).toHaveBeenCalledOnce();
  });

  it("reconciles a recovered executing receipt without replaying provider I/O", async () => {
    const authority = new FakeAuthority();
    const permit = await authority.issue({
      rolloutId: "rollout-one",
      operation: "suspend_service",
      resource,
      ownerId: "actor-one",
      expected: before,
      leaseSeconds: 60,
    });
    const receipt = await authority.consume(permit);
    await authority.validateExecution(receipt);
    authority.recovery = {
      status: "receipt",
      phase: "executing",
      reconciliationOnly: true,
      receipt,
    };
    const mutate = vi.fn();
    await expect(
      execute(authority, { mutate, observe: async () => observed(after) }),
    ).resolves.toMatchObject({ status: "reconciled" });
    expect(mutate).not.toHaveBeenCalled();
    expect(authority.reconciliations.at(-1)?.result).toBe(
      "exact_postcondition",
    );
  });

  it("makes a recovered executing receipt permanently ambiguous when the postcondition is unproven", async () => {
    const authority = new FakeAuthority();
    const permit = await authority.issue({
      rolloutId: "rollout-one",
      operation: "suspend_service",
      resource,
      ownerId: "actor-one",
      expected: before,
      leaseSeconds: 60,
    });
    const receipt = await authority.consume(permit);
    await authority.validateExecution(receipt);
    authority.recovery = {
      status: "receipt",
      phase: "executing",
      reconciliationOnly: true,
      receipt,
    };
    const mutate = vi.fn();
    await expect(
      execute(authority, { mutate, observe: async () => observed(before) }),
    ).rejects.toThrow("provider_mutation_forward_repair_required");
    expect(mutate).not.toHaveBeenCalled();
    expect(authority.reconciliations.at(-1)?.result).toBe(
      "ambiguous_forward_repair",
    );
  });

  it("returns a durable terminal outcome after a lost completion response", async () => {
    const authority = new FakeAuthority();
    const observation = {
      ...observed(after),
      resultIdentity: { kind: "service" as const, id: resource.id },
    };
    const mutate = vi.fn();
    authority.recovery = {
      status: "terminal",
      outcome: {
        status: "terminal",
        result: "exact_postcondition",
        rolloutId: "rollout-one",
        operation: "suspend_service",
        resource,
        ownerId: "actor-one",
        epoch: 1,
        permitId: "permit-1",
        receiptId: "receipt-1",
        expected: before,
        consumedAt: "2026-08-14T00:00:01.000Z",
        observation,
        completedAt: "2026-08-14T00:00:02.000Z",
      },
    };
    await expect(
      execute(authority, { mutate, observe: async () => observed(after) }),
    ).resolves.toMatchObject({
      status: "reconciled",
      observation,
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it("uses the durable precondition when a restarted process observes the post-state", async () => {
    const authority = new FakeAuthority();
    const permit = await authority.issue({
      rolloutId: "rollout-one",
      operation: "suspend_service",
      resource,
      ownerId: "actor-one",
      expected: before,
      leaseSeconds: 60,
    });
    const receipt = await authority.consume(permit);
    await authority.validateExecution(receipt);
    authority.recovery = {
      status: "receipt",
      phase: "executing",
      reconciliationOnly: true,
      receipt,
    };
    const mutate = vi.fn();
    await expect(
      execute(authority, {
        expected: after,
        mutate,
        observe: async () => observed(after),
      }),
    ).resolves.toMatchObject({ status: "reconciled" });
    expect(mutate).not.toHaveBeenCalled();
  });

  it("allows one concurrent actor and rejects the other", async () => {
    const authority = new FakeAuthority();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = execute(authority, { mutate: async () => gate });
    await vi.waitFor(() => expect(authority.consumed.size).toBe(1));
    await expect(execute(authority)).rejects.toThrow(
      "provider_mutation_lease_held",
    );
    release();
    await expect(first).resolves.toMatchObject({ status: "applied" });
  });

  it("rejects stale state without provider I/O", async () => {
    const authority = new FakeAuthority();
    const mutate = vi.fn();
    await expect(
      execute(authority, { observe: async () => observed(after), mutate }),
    ).rejects.toThrow("provider_mutation_precondition_drift");
    expect(mutate).not.toHaveBeenCalled();
    expect(authority.reconciliations[0]?.result).toBe("precondition_drift");
  });

  it("rejects expired and replayed permits", async () => {
    const expired = new FakeAuthority();
    expired.expiresAt = "2026-08-13T23:59:59.000Z";
    await expect(execute(expired)).rejects.toThrow(
      "provider_mutation_permit_invalid_or_expired",
    );
    const authority = new FakeAuthority();
    const permit = await authority.issue({
      rolloutId: "rollout-one",
      operation: "resume_service",
      resource,
      ownerId: "actor-one",
      expected: before,
      leaseSeconds: 60,
    });
    await authority.consume(permit);
    await expect(authority.consume(permit)).rejects.toThrow(
      "provider_mutation_permit_consumed",
    );
  });

  it("does not replay an ambiguous write and enters forward repair", async () => {
    const authority = new FakeAuthority();
    const mutate = vi.fn().mockRejectedValue(new Error("deadline"));
    await expect(
      execute(authority, {
        mutate,
        observe: vi.fn().mockResolvedValue(observed(before)),
      }),
    ).rejects.toThrow("provider_mutation_forward_repair_required");
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(authority.reconciliations.at(-1)?.result).toBe(
      "ambiguous_forward_repair",
    );
  });

  it("closes a consumed permit when execution validation response is lost", async () => {
    const authority = new FakeAuthority();
    authority.validateExecution = vi
      .fn()
      .mockImplementation(async (receipt) => {
        authority.recovery = {
          status: "receipt",
          phase: "executing",
          reconciliationOnly: false,
          receipt,
        };
        throw new Error("response lost");
      });
    const mutate = vi.fn();
    await expect(execute(authority, { mutate })).rejects.toThrow(
      "provider_mutation_execution_in_progress",
    );
    expect(mutate).not.toHaveBeenCalled();
    expect(authority.reconciliations).toHaveLength(0);
    expect(authority.active).toBe(true);
  });

  it("preserves an active fence when exact application replays race at validation", async () => {
    let state: "absent" | "consumed" | "executing" | "completed" = "absent";
    let recoveries = 0;
    let releaseRecovery!: () => void;
    const bothRecovered = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    const permit: OneShotMutationPermit = {
      rolloutId: "rollout-one",
      operation: "suspend_service",
      resource,
      ownerId: "actor-one",
      expected: before,
      epoch: 1,
      permitId: "permit-1",
      token: "a".repeat(64),
      issuedAt: "2026-08-14T00:00:00.000Z",
      expiresAt: "2026-08-14T00:01:00.000Z",
      singleUse: true,
    };
    const receipt: MutationExecutionReceipt = {
      rolloutId: permit.rolloutId,
      operation: permit.operation,
      resource: permit.resource,
      ownerId: permit.ownerId,
      expected: permit.expected,
      epoch: permit.epoch,
      permitId: permit.permitId,
      receiptId: "receipt-1",
      consumedAt: "2026-08-14T00:00:01.000Z",
    };
    const reconciliations: ProviderMutationReconciliation[] = [];
    let fenceActive = false;
    const authority: ProviderMutationAuthorityPort = {
      async recover() {
        recoveries += 1;
        if (recoveries <= 2) {
          if (recoveries === 2) releaseRecovery();
          await bothRecovered;
          return { status: "absent" };
        }
        if (state === "executing")
          return {
            status: "receipt",
            phase: "executing",
            reconciliationOnly: false,
            receipt,
          };
        throw new Error(`unexpected_recovery:${state}`);
      },
      async issue() {
        fenceActive = true;
        return permit;
      },
      async consume() {
        state = "consumed";
        return receipt;
      },
      async validateExecution() {
        if (state !== "consumed") return false;
        state = "executing";
        return true;
      },
      async complete() {
        state = "completed";
        fenceActive = false;
      },
      async reconcile(value) {
        reconciliations.push(value);
        fenceActive = false;
      },
    };
    let releaseMutation!: () => void;
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const providerWrite = vi.fn(async () => mutationGate);
    const observe = vi
      .fn()
      .mockResolvedValueOnce(observed(before))
      .mockResolvedValueOnce(observed(before))
      .mockResolvedValue(observed(after));
    const first = new AuthoritySerializedMutation(
      authority,
      () => new Date("2026-08-14T00:00:02.000Z"),
    ).execute({
      rolloutId: permit.rolloutId,
      operation: permit.operation,
      resource,
      ownerId: permit.ownerId,
      expected: before,
      expectedPostcondition: after,
      observe,
      mutate: providerWrite,
    });
    const second = new AuthoritySerializedMutation(
      authority,
      () => new Date("2026-08-14T00:00:02.000Z"),
    ).execute({
      rolloutId: permit.rolloutId,
      operation: permit.operation,
      resource,
      ownerId: permit.ownerId,
      expected: before,
      expectedPostcondition: after,
      observe,
      mutate: providerWrite,
    });
    const secondRejected = expect(second).rejects.toThrow(
      "provider_mutation_execution_in_progress",
    );
    await vi.waitFor(() => expect(providerWrite).toHaveBeenCalledOnce());
    await secondRejected;
    expect(fenceActive).toBe(true);
    expect(reconciliations).toHaveLength(0);
    releaseMutation();
    await expect(first).resolves.toMatchObject({ status: "applied" });
    expect(providerWrite).toHaveBeenCalledOnce();
    expect(fenceActive).toBe(false);
  });

  it("reconciles the exact postcondition after response loss", async () => {
    const authority = new FakeAuthority();
    const mutate = vi.fn().mockRejectedValue(new Error("response lost"));
    const observe = vi
      .fn()
      .mockResolvedValueOnce(observed(before))
      .mockResolvedValueOnce(observed(after));
    await expect(
      execute(authority, { mutate, observe }),
    ).resolves.toMatchObject({
      status: "reconciled",
    });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(authority.reconciliations.at(-1)?.result).toBe(
      "exact_postcondition",
    );
  });
});
