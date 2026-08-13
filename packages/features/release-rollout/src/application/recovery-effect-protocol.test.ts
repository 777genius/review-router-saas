import { describe, expect, it, vi } from "vitest";
import {
  RecoveryEffectProtocol,
  type RecoveryEffectAuthorityPort,
} from "./recovery-effect-protocol";
import {
  RecoveryEffectKind,
  type RecoveryEffectRecord,
} from "../domain/recovery-effect";

class FakeAuthority implements RecoveryEffectAuthorityPort {
  records = new Map<string, RecoveryEffectRecord>();
  lateJob = false;
  forwardOnly = false;
  now = Date.now();
  private record(
    input: Partial<RecoveryEffectRecord> &
      Pick<RecoveryEffectRecord, "rolloutId" | "effectKey" | "kind">,
  ): RecoveryEffectRecord {
    return {
      rolloutId: input.rolloutId,
      effectKey: input.effectKey,
      kind: input.kind,
      serviceId: input.serviceId ?? null,
      state: input.state ?? "intended",
      epoch: input.epoch ?? 0,
      claimOwnerId: input.claimOwnerId ?? null,
      permitToken: input.permitToken ?? null,
      leaseExpiresAt: input.leaseExpiresAt ?? null,
      consumedAt: input.consumedAt ?? null,
      completedAt: input.completedAt ?? null,
      observation: input.observation ?? null,
    };
  }
  async intendRecoveryEffect(
    input: Parameters<RecoveryEffectAuthorityPort["intendRecoveryEffect"]>[0],
  ) {
    if (this.forwardOnly) throw new Error("forward_only");
    const existing = this.records.get(input.effectKey);
    if (existing) {
      if (
        existing.kind !== input.kind ||
        existing.serviceId !== (input.serviceId ?? null)
      )
        throw new Error("intent_replay_conflict");
      return existing;
    }
    const value = this.record(input);
    this.records.set(input.effectKey, value);
    return value;
  }
  async claimRecoveryEffect(
    input: Parameters<RecoveryEffectAuthorityPort["claimRecoveryEffect"]>[0],
  ) {
    if (this.lateJob) throw new Error("late_job_prevents_claim");
    const old = this.records.get(input.effectKey)!;
    if (old.state === "claimed" && Date.parse(old.leaseExpiresAt!) > this.now)
      return old;
    const value = this.record({
      ...old,
      state: "claimed",
      epoch: old.epoch + 1,
      claimOwnerId: input.ownerId,
      permitToken: old.epoch.toString(16).padStart(64, "a"),
      leaseExpiresAt: new Date(
        this.now + input.leaseSeconds * 1000,
      ).toISOString(),
    });
    this.records.set(input.effectKey, value);
    return value;
  }
  async consumeRecoveryEffectPermit(
    input: Parameters<
      RecoveryEffectAuthorityPort["consumeRecoveryEffectPermit"]
    >[0],
  ) {
    const old = this.records.get(input.effectKey)!;
    if (this.lateJob) throw new Error("late_job_prevents_consumption");
    if (
      old.state !== "claimed" ||
      old.epoch !== input.epoch ||
      old.permitToken !== input.permitToken ||
      old.claimOwnerId !== input.ownerId ||
      Date.parse(old.leaseExpiresAt!) <= this.now
    )
      throw new Error("permit_denied");
    const value = this.record({
      ...old,
      state: "consumed",
      leaseExpiresAt: null,
      consumedAt: new Date(this.now).toISOString(),
    });
    this.records.set(input.effectKey, value);
    return value;
  }
  async completeRecoveryEffect(
    input: Parameters<RecoveryEffectAuthorityPort["completeRecoveryEffect"]>[0],
  ) {
    const old = this.records.get(input.effectKey)!;
    if (old.epoch !== input.epoch || old.permitToken !== input.permitToken)
      throw new Error("completion_fence_conflict");
    if (this.forwardOnly) {
      const forward = this.markForward(input.effectKey);
      if (
        forward.observation !== null &&
        JSON.stringify(forward.observation) !==
          JSON.stringify(input.observation)
      )
        throw new Error("forward_observation_conflict");
      const observed = this.record({
        ...forward,
        state: "forward_repair",
        completedAt: forward.completedAt ?? new Date(this.now).toISOString(),
        observation: forward.observation ?? input.observation,
      });
      this.records.set(input.effectKey, observed);
      return observed;
    }
    if (old.state === "completed") {
      if (JSON.stringify(old.observation) !== JSON.stringify(input.observation))
        throw new Error("completion_replay_conflict");
      return old;
    }
    const value = this.record({
      ...old,
      state: "completed",
      observation: input.observation,
      completedAt: new Date(this.now).toISOString(),
    });
    this.records.set(input.effectKey, value);
    return value;
  }
  commitLateJob() {
    this.lateJob = true;
    if (
      [...this.records.values()].some((item) =>
        ["consumed", "completed"].includes(item.state),
      )
    ) {
      this.forwardOnly = true;
      for (const key of this.records.keys()) this.markForward(key);
    }
  }
  private markForward(key: string) {
    const old = this.records.get(key)!;
    const value = this.record({
      ...old,
      state: "forward_repair",
      completedAt: old.completedAt,
      observation: old.observation,
    });
    this.records.set(key, value);
    return value;
  }
}

const input = (authority: FakeAuthority, effect = vi.fn(async () => "ok")) => ({
  protocol: new RecoveryEffectProtocol(authority),
  effect,
  value: {
    rolloutId: "rollout-1",
    effectKey: "restore_database_writes",
    kind: RecoveryEffectKind.RestoreDatabaseWrites,
    ownerId: "worker-1",
    effect,
    observe: async () => ({ sourceWritesRestored: true }),
  },
});

describe("authority-mediated recovery effects", () => {
  it("prevents an effect when a late job commits before claim", async () => {
    const authority = new FakeAuthority();
    authority.commitLateJob();
    const test = input(authority);
    await expect(test.protocol.execute(test.value)).rejects.toThrow(
      "late_job_prevents_claim",
    );
    expect(test.effect).not.toHaveBeenCalled();
  });
  it("prevents an effect when a late job commits after claim but before consumption", async () => {
    const authority = new FakeAuthority();
    const original = authority.consumeRecoveryEffectPermit.bind(authority);
    authority.consumeRecoveryEffectPermit = async (value) => {
      authority.commitLateJob();
      return original(value);
    };
    const test = input(authority);
    await expect(test.protocol.execute(test.value)).rejects.toThrow(
      "late_job_prevents_consumption",
    );
    expect(test.effect).not.toHaveBeenCalled();
  });
  it("keeps a consumed effect forward-only when a late job commits", async () => {
    const authority = new FakeAuthority();
    const effect = vi.fn(async () => {
      authority.commitLateJob();
      return "ok";
    });
    const test = input(authority, effect);
    await expect(test.protocol.execute(test.value)).resolves.toMatchObject({
      state: "forward_repair",
      observation: { sourceWritesRestored: true },
    });
    expect(effect).toHaveBeenCalledOnce();
  });
  it("reconciles a dropped response without replaying the consumed effect", async () => {
    const authority = new FakeAuthority();
    const first = input(
      authority,
      vi.fn(async () => {
        throw new Error("dropped");
      }),
    );
    await expect(first.protocol.execute(first.value)).rejects.toThrow(
      "dropped",
    );
    const retryEffect = vi.fn(async () => "replayed");
    const result = await first.protocol.execute({
      ...first.value,
      effect: retryEffect,
      reconcileConsumed: async () => "observed",
    });
    expect(result.state).toBe("completed");
    expect(retryEffect).not.toHaveBeenCalled();
  });
  it("fences duplicate, expired, and old-epoch permit replay", async () => {
    const authority = new FakeAuthority();
    await authority.intendRecoveryEffect({
      rolloutId: "rollout-1",
      effectKey: "restore_database_writes",
      kind: RecoveryEffectKind.RestoreDatabaseWrites,
    });
    const first = await authority.claimRecoveryEffect({
      rolloutId: "rollout-1",
      effectKey: "restore_database_writes",
      ownerId: "worker-1",
      leaseSeconds: 5,
    });
    authority.now += 6_000;
    const second = await authority.claimRecoveryEffect({
      rolloutId: "rollout-1",
      effectKey: "restore_database_writes",
      ownerId: "worker-2",
      leaseSeconds: 5,
    });
    expect(second.epoch).toBe(first.epoch + 1);
    await expect(
      authority.consumeRecoveryEffectPermit({
        rolloutId: "rollout-1",
        effectKey: "restore_database_writes",
        ownerId: "worker-1",
        epoch: first.epoch,
        permitToken: first.permitToken!,
      }),
    ).rejects.toThrow("permit_denied");
  });
  it("keeps selective multi-service recovery independent", async () => {
    const authority = new FakeAuthority();
    const protocol = new RecoveryEffectProtocol(authority);
    for (const serviceId of ["srv-api", "srv-worker"])
      await protocol.execute({
        rolloutId: "rollout-1",
        effectKey: `resume_source_service:${serviceId}`,
        kind: RecoveryEffectKind.ResumeSourceService,
        serviceId,
        ownerId: "worker-1",
        effect: async () => serviceId,
        observe: async (id) => ({ serviceId: id, resumed: true }),
      });
    expect(
      [...authority.records.values()].map((item) => item.serviceId),
    ).toEqual(["srv-api", "srv-worker"]);
  });
  it("refuses compensation intents after the authority becomes forward-only", async () => {
    const authority = new FakeAuthority();
    const test = input(authority);
    await test.protocol.execute(test.value);
    authority.commitLateJob();
    expect(authority.records.get("restore_database_writes")).toMatchObject({
      state: "forward_repair",
      observation: { sourceWritesRestored: true },
    });
    await expect(
      authority.intendRecoveryEffect({
        rolloutId: "rollout-1",
        effectKey: "resume_source_service:srv-api",
        kind: RecoveryEffectKind.ResumeSourceService,
        serviceId: "srv-api",
      }),
    ).rejects.toThrow("forward_only");
  });
});
