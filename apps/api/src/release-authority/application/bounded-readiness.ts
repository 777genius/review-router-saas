export type BoundedReadinessPolicyOptions = Readonly<{
  deadlineMilliseconds: number;
  successfulLeaseMilliseconds: number;
  monotonicNow?: () => number;
}>;

export type BoundedReadinessPolicy = Readonly<{
  assertReady(): Promise<void>;
}>;

const defaultMonotonicNow = (): number => performance.now();

export function createBoundedReadinessPolicy(
  observe: () => Promise<void>,
  unavailableError: () => Error,
  options: BoundedReadinessPolicyOptions,
): BoundedReadinessPolicy {
  if (
    !Number.isFinite(options.deadlineMilliseconds) ||
    options.deadlineMilliseconds <= 0
  )
    throw new Error("readiness_deadline_invalid");
  if (
    !Number.isFinite(options.successfulLeaseMilliseconds) ||
    options.successfulLeaseMilliseconds < 0
  )
    throw new Error("readiness_lease_invalid");

  const monotonicNow = options.monotonicNow ?? defaultMonotonicNow;
  let successfulObservationAt: number | undefined;
  let inFlight: Promise<void> | undefined;

  const observeWithinDeadline = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      let settled = false;
      const deadline = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(unavailableError());
      }, options.deadlineMilliseconds);

      // Attaching both handlers immediately is intentional: after the deadline,
      // a late probe settlement must be consumed without changing policy state.
      Promise.resolve()
        .then(observe)
        .then(
          () => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            resolve();
          },
          () => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            reject(unavailableError());
          },
        );
    });

  return {
    assertReady(): Promise<void> {
      if (successfulObservationAt !== undefined) {
        const elapsed = monotonicNow() - successfulObservationAt;
        if (elapsed >= 0 && elapsed < options.successfulLeaseMilliseconds)
          return Promise.resolve();
      }
      if (inFlight) return inFlight;

      const observation = observeWithinDeadline();
      const shared = observation
        .then(() => {
          successfulObservationAt = monotonicNow();
        })
        .finally(() => {
          if (inFlight === shared) inFlight = undefined;
        });
      inFlight = shared;
      return shared;
    },
  };
}
