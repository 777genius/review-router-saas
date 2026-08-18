import { describe, expect, it, vi } from "vitest";
import {
  DefinitiveAttestationMismatchError,
  ReleaseAuthorityAttestationCoordinator,
  defaultReadinessTimingPolicy,
  type MonotonicScheduler,
} from "./attestation-lease";
import { createReleaseAuthorityAttestationSubject } from "../domain/attestation-subject";
import { ReleaseAuthorityServiceKind } from "../domain/attestation-subject";

class FakeScheduler implements MonotonicScheduler {
  time = 0;
  randomValue = 0.5;
  tasks: { at: number; task: () => void; canceled: boolean }[] = [];
  now = () => this.time;
  random = () => this.randomValue;
  schedule = (delay: number, task: () => void) => {
    const entry = { at: this.time + delay, task, canceled: false };
    this.tasks.push(entry);
    return {
      cancel: () => {
        entry.canceled = true;
      },
    };
  };
  async advance(milliseconds: number) {
    const end = this.time + milliseconds;
    for (;;) {
      const next = this.tasks
        .filter((item) => !item.canceled && item.at <= end)
        .sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      next.canceled = true;
      this.time = next.at;
      next.task();
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    }
    this.time = end;
    await Promise.resolve();
  }
}

const subject = () =>
  createReleaseAuthorityAttestationSubject({
    serviceKind: ReleaseAuthorityServiceKind.Control,
    deploymentRevision: "a".repeat(40),
    artifactDigest: `sha256:${"b".repeat(64)}`,
    catalogContractId: "complete_catalog_v5_provider_root_pin",
    expectedDatabases: [
      {
        roleName: "reviewrouter_release_control",
        identity: {
          serverIdentity: "1",
          databaseIdentity: "2",
          databaseName: "authority",
        },
      },
    ],
    requiredRoles: ["reviewrouter_release_control"],
    authorityOwnerRoleName: "reviewrouter_release_authority_owner",
    activationGuardRoleName: "reviewrouter_activation_receipt_guard",
    routineBodyRoots: {
      installerSha256: `sha256:${"c".repeat(64)}`,
      readerSha256: `sha256:${"d".repeat(64)}`,
    },
    migrationManifestIdentity: `sha256:${"e".repeat(64)}`,
    activationFingerprint: `sha256:${"f".repeat(64)}`,
    activationCatalogPolicies: {
      preactivationCatalogPolicySha256: `sha256:${"1".repeat(64)}`,
      activatedCatalogPolicySha256: `sha256:${"2".repeat(64)}`,
    },
  });
const unavailable = () =>
  Object.assign(new Error("unavailable"), { statusCode: 503 });
const timing = {
  ...defaultReadinessTimingPolicy,
  observationDeadlineMilliseconds: 20,
  transactionTimeoutMilliseconds: 17,
  statementTimeoutMilliseconds: 15,
  poolWaitMilliseconds: 2,
  lockTimeoutMilliseconds: 2,
  leaseMilliseconds: 60,
  refreshAfterMilliseconds: 40,
  refreshRetryBaseMilliseconds: 2,
  refreshRetryMaximumMilliseconds: 8,
};

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

describe("process-local full-attestation lease", () => {
  it("uses the independently bounded production timings", () => {
    expect(defaultReadinessTimingPolicy).toMatchObject({
      poolWaitMilliseconds: 2_000,
      lockTimeoutMilliseconds: 2_000,
      statementTimeoutMilliseconds: 15_000,
      transactionTimeoutMilliseconds: 17_000,
      observationDeadlineMilliseconds: 20_000,
      leaseMilliseconds: 60_000,
      refreshAfterMilliseconds: 40_000,
    });
  });

  it("expires at equality from the earliest observation start", async () => {
    const clock = new FakeScheduler();
    const probe = vi.fn(async () => {
      clock.time = 6;
    });
    const gate = new ReleaseAuthorityAttestationCoordinator(
      probe,
      unavailable,
      timing,
      clock,
    );
    await gate.assertOrdinary(subject());
    expect(gate.state(subject())).toMatchObject({
      status: "ready",
      observedAt: 0,
      expiresAt: 60,
    });
    clock.time = 59;
    expect(gate.state(subject()).status).toBe("ready");
    clock.time = 60;
    expect(gate.state(subject()).status).toBe("expired");
  });

  it("coalesces ordinary and force-new callers separately", async () => {
    const clock = new FakeScheduler();
    const pending = [deferred(), deferred()];
    const probe = vi.fn(() => pending[probe.mock.calls.length - 1]!.promise);
    const gate = new ReleaseAuthorityAttestationCoordinator(
      probe,
      unavailable,
      timing,
      clock,
    );
    const ordinaryA = gate.assertOrdinary(subject());
    const ordinaryB = gate.assertOrdinary(subject());
    expect(ordinaryB).toBe(ordinaryA);
    await Promise.resolve();
    const boundary = gate.captureFreshnessBoundary();
    const forcedA = gate.forceNew(subject(), boundary);
    const forcedB = gate.forceNew(subject(), boundary);
    expect(forcedB).toBe(forcedA);
    await Promise.resolve();
    expect(probe).toHaveBeenCalledTimes(2);
    pending[1]!.resolve();
    await forcedA;
    pending[0]!.resolve();
    await expect(ordinaryA).rejects.toThrow("unavailable");
  });

  it("bypasses a live lease immediately before a high-risk mutation", async () => {
    const clock = new FakeScheduler();
    const events: string[] = [];
    const probe = vi.fn(async () => {
      events.push("attested");
    });
    const gate = new ReleaseAuthorityAttestationCoordinator(
      probe,
      unavailable,
      timing,
      clock,
    );
    await gate.assertOrdinary(subject());

    await gate.executeHighRiskMutation(subject(), async () => {
      events.push("mutated");
    });

    expect(probe).toHaveBeenCalledTimes(2);
    expect(events).toEqual(["attested", "attested", "mutated"]);
    expect(gate.state(subject()).status).toBe("ready");
  });

  it("freshly attests every write in one exclusive high-risk sequence", async () => {
    const clock = new FakeScheduler();
    const events: string[] = [];
    const gate = new ReleaseAuthorityAttestationCoordinator(
      vi.fn(async () => {
        events.push("attested");
      }),
      unavailable,
      timing,
      clock,
    );

    await gate.executeHighRiskMutationSequence(
      subject(),
      async (executeFresh) => {
        await executeFresh(async () => {
          events.push("authority-write");
        });
        await executeFresh(async () => {
          events.push("target-write");
        });
      },
    );

    expect(events).toEqual([
      "attested",
      "authority-write",
      "attested",
      "target-write",
    ]);
  });

  it("gives concurrent high-risk callers distinct fresh evidence and ordered mutation boundaries", async () => {
    const clock = new FakeScheduler();
    const observations = [deferred(), deferred()];
    const events: string[] = [];
    const probe = vi.fn(() => {
      const index = probe.mock.calls.length - 1;
      events.push(`attestation-${index + 1}-started`);
      return observations[index]!.promise;
    });
    const gate = new ReleaseAuthorityAttestationCoordinator(
      probe,
      unavailable,
      timing,
      clock,
    );

    const first = gate.executeHighRiskMutation(subject(), async () => {
      events.push("mutation-1");
    });
    const second = gate.executeHighRiskMutation(subject(), async () => {
      events.push("mutation-2");
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(probe).toHaveBeenCalledOnce();
    observations[0]!.resolve();
    await first;
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    expect(probe).toHaveBeenCalledTimes(2);
    observations[1]!.resolve();
    await second;

    expect(events).toEqual([
      "attestation-1-started",
      "mutation-1",
      "attestation-2-started",
      "mutation-2",
    ]);
  });

  it("fails a high-risk mutation closed when fresh evidence drifts", async () => {
    const clock = new FakeScheduler();
    const mutation = vi.fn();
    const gate = new ReleaseAuthorityAttestationCoordinator(
      vi.fn().mockRejectedValue(new DefinitiveAttestationMismatchError()),
      unavailable,
      timing,
      clock,
    );

    await expect(
      gate.executeHighRiskMutation(subject(), mutation),
    ).rejects.toThrow("unavailable");
    expect(mutation).not.toHaveBeenCalled();
    expect(gate.state(subject()).status).toBe("unattested");
  });

  it("makes ordinary callers join force-new evidence instead of superseding it", async () => {
    const clock = new FakeScheduler();
    const forcedObservation = deferred();
    const probe = vi.fn(() => forcedObservation.promise);
    const gate = new ReleaseAuthorityAttestationCoordinator(
      probe,
      unavailable,
      timing,
      clock,
    );
    const forced = gate.forceNew(subject(), gate.captureFreshnessBoundary());
    await Promise.resolve();
    const ordinary = gate.assertOrdinary(subject());
    expect(ordinary).toBe(forced);
    expect(probe).toHaveBeenCalledOnce();
    forcedObservation.resolve();
    await Promise.all([forced, ordinary]);
    expect(gate.state(subject()).status).toBe("ready");
  });

  it("redirects later ordinary callers from stale ordinary work to a force-new flight", async () => {
    const clock = new FakeScheduler();
    const stale = deferred();
    const forcedObservation = deferred();
    const probe = vi
      .fn()
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(forcedObservation.promise);
    const gate = new ReleaseAuthorityAttestationCoordinator(
      probe,
      unavailable,
      timing,
      clock,
    );
    const firstOrdinary = gate.assertOrdinary(subject());
    await Promise.resolve();
    const forced = gate.forceNew(subject(), gate.captureFreshnessBoundary());
    await Promise.resolve();
    const laterOrdinary = gate.assertOrdinary(subject());
    expect(laterOrdinary).toBe(forced);
    forcedObservation.resolve();
    await Promise.all([forced, laterOrdinary]);
    stale.resolve();
    await expect(firstOrdinary).rejects.toThrow("unavailable");
    expect(gate.state(subject()).status).toBe("ready");
  });

  it("runs bounded background initial retries", async () => {
    const clock = new FakeScheduler();
    const probe = vi.fn().mockRejectedValue(new Error("transient"));
    const gate = new ReleaseAuthorityAttestationCoordinator(
      probe,
      unavailable,
      {
        ...timing,
        refreshRetryLimit: 2,
        refreshJitterRatio: 0,
      },
      clock,
    );
    gate.startInitial(subject());
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    await clock.advance(0);
    await clock.advance(2);
    await clock.advance(4);
    await clock.advance(100);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(gate.state(subject()).status).toBe("unattested");
  });

  it("cancels background initialization and retries on lifecycle close", async () => {
    const clock = new FakeScheduler();
    let observedSignal: AbortSignal | undefined;
    const probe = vi.fn(
      (_subject, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          observedSignal = signal;
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    const gate = new ReleaseAuthorityAttestationCoordinator(
      probe,
      unavailable,
      timing,
      clock,
    );
    gate.startInitial(subject());
    await Promise.resolve();
    gate.close();
    await clock.advance(100);
    expect(observedSignal?.aborted).toBe(true);
    expect(probe).toHaveBeenCalledOnce();
    expect(gate.state(subject()).status).toBe("unattested");
  });

  it("never leases negative, timeout, abort, or malformed observations", async () => {
    for (const behavior of [
      () => Promise.reject(new DefinitiveAttestationMismatchError()),
      () => Promise.reject(new Error("malformed")),
      (signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        ),
    ]) {
      const clock = new FakeScheduler();
      const gate = new ReleaseAuthorityAttestationCoordinator(
        (_subject, signal) => behavior(signal),
        unavailable,
        timing,
        clock,
      );
      const result = gate.assertOrdinary(subject()).catch((error) => error);
      await Promise.resolve();
      await clock.advance(20);
      expect(await result).toMatchObject({ message: "unavailable" });
      expect(gate.state(subject()).status).not.toBe("ready");
    }
  });

  it("ignores a completion arriving after its deadline", async () => {
    const clock = new FakeScheduler();
    const old = deferred();
    const current = deferred();
    const probe = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    const gate = new ReleaseAuthorityAttestationCoordinator(
      probe,
      unavailable,
      timing,
      clock,
    );
    const first = gate.assertOrdinary(subject()).catch(() => undefined);
    await Promise.resolve();
    await clock.advance(20);
    await first;
    const second = gate.assertOrdinary(subject());
    await Promise.resolve();
    current.resolve();
    await second;
    old.resolve();
    await Promise.resolve();
    expect(gate.state(subject()).status).toBe("ready");
  });

  it("does not let a stale definitive result revoke newer evidence", async () => {
    const clock = new FakeScheduler();
    const old = deferred();
    const current = deferred();
    const probe = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    const gate = new ReleaseAuthorityAttestationCoordinator(
      probe,
      unavailable,
      timing,
      clock,
    );
    const stale = gate.assertOrdinary(subject());
    await Promise.resolve();
    const fresh = gate.forceNew(subject(), gate.captureFreshnessBoundary());
    await Promise.resolve();
    current.resolve();
    await fresh;
    old.reject(new DefinitiveAttestationMismatchError());
    await expect(stale).rejects.toThrow("unavailable");
    expect(gate.state(subject()).status).toBe("ready");
  });

  it("revokes on a current definitive mismatch but transient refresh never extends", async () => {
    const clock = new FakeScheduler();
    const probe = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("transient"))
      .mockRejectedValueOnce(new DefinitiveAttestationMismatchError());
    const gate = new ReleaseAuthorityAttestationCoordinator(
      probe,
      unavailable,
      timing,
      clock,
    );
    await gate.assertOrdinary(subject());
    await clock.advance(40);
    expect(gate.state(subject()).expiresAt).toBe(60);
    await clock.advance(2);
    expect(gate.state(subject()).status).toBe("unattested");
  });

  it("uses bounded exponential retry and injected jitter", async () => {
    const clock = new FakeScheduler();
    clock.randomValue = 1;
    const probe = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error())
      .mockRejectedValueOnce(new Error())
      .mockResolvedValueOnce(undefined);
    const gate = new ReleaseAuthorityAttestationCoordinator(
      probe,
      unavailable,
      { ...timing, refreshJitterRatio: 0.5 },
      clock,
    );
    await gate.assertOrdinary(subject());
    await clock.advance(40);
    await clock.advance(3); // base 2 + 50%
    await clock.advance(6); // doubled 4 + 50%
    expect(probe).toHaveBeenCalledTimes(4);
  });

  it("does not share state across instances or restart", async () => {
    const clock = new FakeScheduler();
    const probe = vi.fn().mockResolvedValue(undefined);
    const first = new ReleaseAuthorityAttestationCoordinator(
      probe,
      unavailable,
      timing,
      clock,
    );
    const second = new ReleaseAuthorityAttestationCoordinator(
      probe,
      unavailable,
      timing,
      clock,
    );
    await first.assertOrdinary(subject());
    expect(second.state(subject()).status).toBe("unattested");
    await second.assertOrdinary(subject());
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
