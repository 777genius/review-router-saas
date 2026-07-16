export const stalePullRequestHeadErrorCode =
  "review_runtime_stale_pull_request_head";

export type PullRequestHeadSupervisor = {
  readonly signal: AbortSignal;
  readonly stop: () => void;
};

export async function startPullRequestHeadSupervisor(input: {
  readonly expectedHeadSha: string;
  readonly readCurrentHeadSha: (signal: AbortSignal) => Promise<string>;
  readonly pollIntervalMs?: number;
  readonly onPollFailure?: (error: unknown) => void;
}): Promise<PullRequestHeadSupervisor> {
  const controller = new AbortController();
  const pollIntervalMs = input.pollIntervalMs ?? 30_000;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error("pull_request_head_poll_interval_invalid");
  }

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pollAbortController = new AbortController();

  const checkHead = async (): Promise<void> => {
    try {
      const currentHeadSha = await input.readCurrentHeadSha(
        pollAbortController.signal,
      );
      if (
        !stopped &&
        currentHeadSha.toLowerCase() !== input.expectedHeadSha.toLowerCase()
      ) {
        controller.abort(new Error(stalePullRequestHeadErrorCode));
      }
    } catch (error) {
      if (!stopped) {
        try {
          input.onPollFailure?.(error);
        } catch {
          // Diagnostics must not turn a fail-open head check into a failed review.
        }
      }
    }
  };

  const scheduleNextCheck = (): void => {
    if (stopped || controller.signal.aborted) return;
    timer = setTimeout(() => {
      void (async () => {
        await checkHead();
        scheduleNextCheck();
      })();
    }, pollIntervalMs);
  };

  await checkHead();
  scheduleNextCheck();

  return {
    signal: controller.signal,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      pollAbortController.abort();
    },
  };
}

export function isStalePullRequestHeadError(error: unknown): error is Error {
  return (
    error instanceof Error && error.message === stalePullRequestHeadErrorCode
  );
}
