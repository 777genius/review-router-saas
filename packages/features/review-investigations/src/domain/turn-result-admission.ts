export enum TurnResultAdmissionKind {
  Current = "current",
  HistoricalDrain = "historical_drain",
  Rejected = "rejected",
}

export enum TurnResultAuthority {
  Current = "current",
  Superseded = "superseded",
  Rejected = "rejected",
}

export type TurnResultAdmission = Readonly<{
  kind: TurnResultAdmissionKind;
  effectiveDeadline: string;
}>;

export function decideTurnResultAdmission(input: {
  readonly authority: TurnResultAuthority;
  readonly admittedAt: string;
  readonly deadlines: readonly string[];
}): TurnResultAdmission {
  const admittedAt = timestampMs(
    input.admittedAt,
    "turn_result_admitted_at_invalid",
  );
  if (input.deadlines.length === 0) {
    throw new Error("turn_result_deadline_missing");
  }
  const effectiveDeadlineMs = Math.min(
    ...input.deadlines.map((deadline) =>
      timestampMs(deadline, "turn_result_deadline_invalid"),
    ),
  );
  const effectiveDeadline = new Date(effectiveDeadlineMs).toISOString();
  if (admittedAt >= effectiveDeadlineMs) {
    return Object.freeze({
      kind: TurnResultAdmissionKind.Rejected,
      effectiveDeadline,
    });
  }
  return Object.freeze({
    kind:
      input.authority === TurnResultAuthority.Current
        ? TurnResultAdmissionKind.Current
        : input.authority === TurnResultAuthority.Superseded
          ? TurnResultAdmissionKind.HistoricalDrain
          : TurnResultAdmissionKind.Rejected,
    effectiveDeadline,
  });
}

function timestampMs(value: string, code: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(code);
  }
  return parsed;
}
