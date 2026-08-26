export const defaultCustodyOperationTimeoutMs = 15_000;

export type CustodyDeadline = Readonly<{
  signal: AbortSignal;
  run<T>(operation: Promise<T>, onLateResult?: (value: T) => void): Promise<T>;
  dispose(): void;
}>;

/** Settles even when an adapter ignores AbortSignal. */
export function createCustodyDeadline(
  parent: AbortSignal | undefined,
  timeoutMs = defaultCustodyOperationTimeoutMs,
): CustodyDeadline {
  const boundedTimeoutMs = Math.max(1, Math.floor(timeoutMs));
  const controller = new AbortController();
  let disposed = false;
  let expired = false;
  const abort = () => {
    if (controller.signal.aborted) return;
    expired = true;
    controller.abort(parent?.reason ?? custodyTimeoutError());
  };
  const parentAbort = () => abort();
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", parentAbort, { once: true });
  const timer = setTimeout(abort, boundedTimeoutMs);
  timer.unref?.();

  return {
    signal: controller.signal,
    async run<T>(operation: Promise<T>, onLateResult?: (value: T) => void) {
      let abortListener: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        abortListener = () =>
          reject(
            controller.signal.reason instanceof Error
              ? controller.signal.reason
              : custodyTimeoutError(),
          );
        if (controller.signal.aborted) abortListener();
        else
          controller.signal.addEventListener("abort", abortListener, {
            once: true,
          });
      });
      void operation.then(
        (value) => {
          if (expired || controller.signal.aborted) onLateResult?.(value);
        },
        () => undefined,
      );
      try {
        return await Promise.race([operation, aborted]);
      } finally {
        if (abortListener)
          controller.signal.removeEventListener("abort", abortListener);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      parent?.removeEventListener("abort", parentAbort);
    },
  };
}

export function custodyTimeoutError(): Error {
  return Object.assign(new Error("hosted_codex_custody_timeout"), {
    name: "AbortError",
  });
}
