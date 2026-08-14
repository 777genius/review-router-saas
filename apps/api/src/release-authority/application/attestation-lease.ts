import {
  attestationSubjectKey,
  type ReleaseAuthorityAttestationSubject,
} from "../domain/attestation-subject.js";

export type ReadinessTimingPolicy = Readonly<{
  poolWaitMilliseconds: number;
  lockTimeoutMilliseconds: number;
  statementTimeoutMilliseconds: number;
  transactionTimeoutMilliseconds: number;
  observationDeadlineMilliseconds: number;
  leaseMilliseconds: number;
  refreshAfterMilliseconds: number;
  refreshRetryLimit: number;
  refreshRetryBaseMilliseconds: number;
  refreshRetryMaximumMilliseconds: number;
  refreshJitterRatio: number;
}>;

export const defaultReadinessTimingPolicy: ReadinessTimingPolicy =
  Object.freeze({
    poolWaitMilliseconds: 2_000,
    lockTimeoutMilliseconds: 2_000,
    statementTimeoutMilliseconds: 15_000,
    transactionTimeoutMilliseconds: 17_000,
    observationDeadlineMilliseconds: 20_000,
    leaseMilliseconds: 60_000,
    refreshAfterMilliseconds: 40_000,
    refreshRetryLimit: 3,
    refreshRetryBaseMilliseconds: 250,
    refreshRetryMaximumMilliseconds: 2_000,
    refreshJitterRatio: 0.2,
  });

export function validateReadinessTimingPolicy(
  input: ReadinessTimingPolicy,
): ReadinessTimingPolicy {
  const integerFields = [
    input.poolWaitMilliseconds,
    input.lockTimeoutMilliseconds,
    input.statementTimeoutMilliseconds,
    input.transactionTimeoutMilliseconds,
    input.observationDeadlineMilliseconds,
    input.leaseMilliseconds,
    input.refreshAfterMilliseconds,
    input.refreshRetryLimit,
    input.refreshRetryBaseMilliseconds,
    input.refreshRetryMaximumMilliseconds,
  ];
  if (
    integerFields.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    input.poolWaitMilliseconds < 1 ||
    input.lockTimeoutMilliseconds < 1 ||
    input.lockTimeoutMilliseconds > input.statementTimeoutMilliseconds ||
    input.statementTimeoutMilliseconds < 1 ||
    input.transactionTimeoutMilliseconds <=
      input.statementTimeoutMilliseconds ||
    input.observationDeadlineMilliseconds <=
      input.transactionTimeoutMilliseconds ||
    input.poolWaitMilliseconds >= input.observationDeadlineMilliseconds ||
    input.leaseMilliseconds <= input.observationDeadlineMilliseconds ||
    input.refreshAfterMilliseconds < input.observationDeadlineMilliseconds ||
    input.refreshAfterMilliseconds >= input.leaseMilliseconds ||
    input.refreshRetryLimit > 10 ||
    input.refreshRetryBaseMilliseconds < 1 ||
    input.refreshRetryMaximumMilliseconds <
      input.refreshRetryBaseMilliseconds ||
    !Number.isFinite(input.refreshJitterRatio) ||
    input.refreshJitterRatio < 0 ||
    input.refreshJitterRatio > 1
  )
    throw new Error("release_authority_readiness_timing_invalid");
  return Object.freeze({ ...input });
}

export interface MonotonicScheduler {
  now(): number;
  schedule(delayMilliseconds: number, task: () => void): { cancel(): void };
  random(): number;
}

export const systemMonotonicScheduler: MonotonicScheduler = {
  now: () => performance.now(),
  schedule: (delay, task) => {
    const timer = setTimeout(task, delay);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  },
  random: () => Math.random(),
};

export class DefinitiveAttestationMismatchError extends Error {
  constructor() {
    super("release_authority_attestation_mismatch");
  }
}

export type AttestationLeaseState = Readonly<{
  status: "unattested" | "ready" | "expired";
  observedAt?: number;
  expiresAt?: number;
  refreshAt?: number;
}>;

type Lease = Readonly<{
  subjectKey: string;
  observationStartedAt: number;
  expiresAt: number;
  refreshAt: number;
  generation: number;
}>;

type Flight = Readonly<{
  subjectKey: string;
  startedAt: number;
  generation: number;
  forceBoundaryOrdinal?: number;
  promise: Promise<void>;
}>;

export type AttestationFreshnessBoundary = Readonly<{
  monotonicTime: number;
  ordinal: number;
}>;

export class ReleaseAuthorityAttestationCoordinator {
  private lease: Lease | undefined;
  private ordinaryFlight: Flight | undefined;
  private forcedFlight: Flight | undefined;
  private generation = 0;
  private boundaryOrdinal = 0;
  private refreshAttempt = 0;
  private initialAttempt = 0;
  private initialSubjectKey: string | undefined;
  private scheduled: { cancel(): void } | undefined;
  private readonly cancelFlights = new Set<() => void>();
  private closed = false;

  constructor(
    private readonly observe: (
      subject: ReleaseAuthorityAttestationSubject,
      signal: AbortSignal,
    ) => Promise<void>,
    private readonly unavailableError: () => Error,
    private readonly timing: ReadinessTimingPolicy = defaultReadinessTimingPolicy,
    private readonly scheduler: MonotonicScheduler = systemMonotonicScheduler,
  ) {
    validateReadinessTimingPolicy(timing);
  }

  state(subject: ReleaseAuthorityAttestationSubject): AttestationLeaseState {
    const lease = this.exactLease(subject);
    if (!lease) return Object.freeze({ status: "unattested" });
    const status =
      this.scheduler.now() >= lease.expiresAt ? "expired" : "ready";
    return Object.freeze({
      status,
      observedAt: lease.observationStartedAt,
      expiresAt: lease.expiresAt,
      refreshAt: lease.refreshAt,
    });
  }

  /** Starts process-lifecycle initialization without delaying server readiness. */
  startInitial(subject: ReleaseAuthorityAttestationSubject): void {
    if (this.closed) return;
    const subjectKey = attestationSubjectKey(subject);
    if (this.initialSubjectKey === subjectKey) return;
    this.initialSubjectKey = subjectKey;
    this.initialAttempt = 0;
    this.startBackgroundInitial(subject);
  }

  /** Cancels timers and in-flight observations owned by this process instance. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.scheduled?.cancel();
    this.scheduled = undefined;
    for (const cancel of [...this.cancelFlights]) cancel();
  }

  assertOrdinary(subject: ReleaseAuthorityAttestationSubject): Promise<void> {
    if (this.closed) return Promise.reject(this.unavailableError());
    const lease = this.exactLease(subject);
    const now = this.scheduler.now();
    if (lease && now < lease.expiresAt) {
      if (now >= lease.refreshAt) this.startBackgroundRefresh(subject);
      return Promise.resolve();
    }
    const key = attestationSubjectKey(subject);
    if (this.forcedFlight) {
      if (this.forcedFlight.subjectKey === key)
        return this.forcedFlight.promise;
      return this.forcedFlight.promise.then(() => this.assertOrdinary(subject));
    }
    if (this.ordinaryFlight?.subjectKey === key)
      return this.ordinaryFlight.promise;
    return this.startFlight("ordinary", subject).promise;
  }

  /** Force evidence whose observation begins at or after the caller's boundary. */
  captureFreshnessBoundary(): AttestationFreshnessBoundary {
    return Object.freeze({
      monotonicTime: this.scheduler.now(),
      ordinal: ++this.boundaryOrdinal,
    });
  }

  forceNew(
    subject: ReleaseAuthorityAttestationSubject,
    boundary = this.captureFreshnessBoundary(),
  ): Promise<void> {
    if (this.closed) return Promise.reject(this.unavailableError());
    const key = attestationSubjectKey(subject);
    if (
      this.forcedFlight?.subjectKey === key &&
      this.forcedFlight.forceBoundaryOrdinal === boundary.ordinal &&
      this.forcedFlight.startedAt >= boundary.monotonicTime
    )
      return this.forcedFlight.promise;
    return this.startFlight(
      "forced",
      subject,
      boundary.monotonicTime,
      boundary.ordinal,
    ).promise;
  }

  private exactLease(
    subject: ReleaseAuthorityAttestationSubject,
  ): Lease | undefined {
    return this.lease?.subjectKey === attestationSubjectKey(subject)
      ? this.lease
      : undefined;
  }

  private startFlight(
    mode: "ordinary" | "forced",
    subject: ReleaseAuthorityAttestationSubject,
    notBefore = this.scheduler.now(),
    forceBoundaryOrdinal?: number,
  ): Flight {
    if (this.closed)
      return Object.freeze({
        subjectKey: attestationSubjectKey(subject),
        startedAt: this.scheduler.now(),
        generation: this.generation,
        ...(forceBoundaryOrdinal === undefined ? {} : { forceBoundaryOrdinal }),
        promise: Promise.reject(this.unavailableError()),
      });
    const subjectKey = attestationSubjectKey(subject);
    const startedAt = this.scheduler.now();
    if (startedAt < notBefore)
      throw new Error("release_authority_monotonic_clock_regressed");
    const generation = ++this.generation;
    const cancellation = new AbortController();
    let settled = false;
    let cancelFlight = () => undefined;
    const observation = new Promise<void>((resolve, reject) => {
      const deadline = this.scheduler.schedule(
        this.timing.observationDeadlineMilliseconds,
        () => {
          if (settled) return;
          settled = true;
          this.cancelFlights.delete(cancelFlight);
          cancellation.abort(new Error("readiness_deadline_exceeded"));
          reject(this.unavailableError());
        },
      );
      cancelFlight = () => {
        if (settled) return;
        settled = true;
        deadline.cancel();
        this.cancelFlights.delete(cancelFlight);
        cancellation.abort(new Error("readiness_coordinator_closed"));
        reject(this.unavailableError());
      };
      this.cancelFlights.add(cancelFlight);
      Promise.resolve()
        .then(() => this.observe(subject, cancellation.signal))
        .then(
          () => {
            if (settled) return;
            settled = true;
            this.cancelFlights.delete(cancelFlight);
            deadline.cancel();
            if (generation !== this.generation) {
              reject(this.unavailableError());
              return;
            }
            this.lease = Object.freeze({
              subjectKey,
              observationStartedAt: startedAt,
              expiresAt: startedAt + this.timing.leaseMilliseconds,
              refreshAt: startedAt + this.timing.refreshAfterMilliseconds,
              generation,
            });
            this.refreshAttempt = 0;
            this.initialAttempt = 0;
            this.scheduleRefresh(
              subject,
              Math.max(
                0,
                startedAt +
                  this.timing.refreshAfterMilliseconds -
                  this.scheduler.now(),
              ),
            );
            resolve();
          },
          (error: unknown) => {
            if (settled) return;
            settled = true;
            this.cancelFlights.delete(cancelFlight);
            deadline.cancel();
            if (
              error instanceof DefinitiveAttestationMismatchError &&
              generation === this.generation
            ) {
              ++this.generation;
              this.lease = undefined;
              this.scheduled?.cancel();
              this.scheduled = undefined;
            }
            reject(this.unavailableError());
          },
        );
    });
    const shared = observation.finally(() => {
      if (mode === "ordinary" && this.ordinaryFlight?.promise === shared)
        this.ordinaryFlight = undefined;
      if (mode === "forced" && this.forcedFlight?.promise === shared)
        this.forcedFlight = undefined;
    });
    const flight = Object.freeze({
      subjectKey,
      startedAt,
      generation,
      ...(forceBoundaryOrdinal === undefined ? {} : { forceBoundaryOrdinal }),
      promise: shared,
    });
    if (mode === "ordinary") this.ordinaryFlight = flight;
    else this.forcedFlight = flight;
    return flight;
  }

  private scheduleRefresh(
    subject: ReleaseAuthorityAttestationSubject,
    delay: number,
  ): void {
    if (this.closed) return;
    this.scheduled?.cancel();
    this.scheduled = this.scheduler.schedule(delay, () => {
      this.scheduled = undefined;
      this.startBackgroundRefresh(subject);
    });
  }

  private startBackgroundInitial(
    subject: ReleaseAuthorityAttestationSubject,
  ): void {
    if (this.closed || this.exactLease(subject)) return;
    void this.assertOrdinary(subject).catch(() => {
      if (this.closed || this.exactLease(subject)) return;
      if (this.initialAttempt >= this.timing.refreshRetryLimit) return;
      this.scheduleInitialRetry(subject, this.initialAttempt++);
    });
  }

  private scheduleInitialRetry(
    subject: ReleaseAuthorityAttestationSubject,
    attempt: number,
  ): void {
    const exponential = Math.min(
      this.timing.refreshRetryMaximumMilliseconds,
      this.timing.refreshRetryBaseMilliseconds * 2 ** attempt,
    );
    const jitter =
      exponential *
      this.timing.refreshJitterRatio *
      (this.scheduler.random() * 2 - 1);
    this.scheduled?.cancel();
    this.scheduled = this.scheduler.schedule(
      Math.max(0, Math.round(exponential + jitter)),
      () => {
        this.scheduled = undefined;
        this.startBackgroundInitial(subject);
      },
    );
  }

  private startBackgroundRefresh(
    subject: ReleaseAuthorityAttestationSubject,
  ): void {
    const lease = this.exactLease(subject);
    if (
      this.closed ||
      !lease ||
      this.scheduler.now() >= lease.expiresAt ||
      this.ordinaryFlight ||
      this.forcedFlight
    )
      return;
    const promise = this.startFlight("ordinary", subject).promise;
    void promise.catch(() => {
      // A transient refresh failure never changes or extends the old lease.
      const current = this.exactLease(subject);
      if (!current || this.scheduler.now() >= current.expiresAt) return;
      if (this.refreshAttempt >= this.timing.refreshRetryLimit) return;
      const exponential = Math.min(
        this.timing.refreshRetryMaximumMilliseconds,
        this.timing.refreshRetryBaseMilliseconds * 2 ** this.refreshAttempt++,
      );
      const jitter =
        exponential *
        this.timing.refreshJitterRatio *
        (this.scheduler.random() * 2 - 1);
      this.scheduleRefresh(
        subject,
        Math.max(0, Math.round(exponential + jitter)),
      );
    });
  }
}
