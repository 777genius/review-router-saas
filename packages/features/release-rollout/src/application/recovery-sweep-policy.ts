export type RecoverySweepCursorDecision = Readonly<{
  dispatchNextWindow: boolean;
  preserveWindowFailure: boolean;
}>;

/**
 * A terminal window owns its result, not the traversal cursor. Failed items
 * remain failed and are redriven by the durable schedule, while a bounded
 * continuation advances to eligible later windows.
 */
export function decideRecoverySweepCursor(input: {
  hasNextWindow: boolean;
  windowResult: string;
}): RecoverySweepCursorDecision {
  if (
    input.windowResult !== "success" &&
    input.windowResult !== "failure" &&
    input.windowResult !== "skipped"
  )
    throw new Error("release_recovery_sweep_window_result_invalid");
  return {
    dispatchNextWindow: input.hasNextWindow,
    preserveWindowFailure: input.windowResult === "failure",
  };
}
