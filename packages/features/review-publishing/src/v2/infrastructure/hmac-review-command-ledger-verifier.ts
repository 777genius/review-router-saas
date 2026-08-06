import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  ReviewCommandLedgerVerificationStatus,
  type ReviewCommandLedgerKeyDerivationPort,
  type ReviewCommandLedgerVerificationDecision,
  type ReviewCommandLedgerVerificationPort,
} from "../application/ports/review-command-ledger-verification-port";

const commandLedgerMarker =
  /<!--\s*reviewrouter-ledger:v1\s+payload=([A-Za-z0-9_-]+)\s+signature=([a-f0-9]{64})\s*-->/u;

export class HmacReviewCommandLedgerVerifier implements ReviewCommandLedgerVerificationPort {
  constructor(
    private readonly ledgerKeys: ReviewCommandLedgerKeyDerivationPort | null,
  ) {}

  async verify(
    input: Parameters<ReviewCommandLedgerVerificationPort["verify"]>[0],
  ): Promise<ReviewCommandLedgerVerificationDecision> {
    const match = commandLedgerMarker.exec(input.markerBody);
    if (!match) return invalid();

    let payload: unknown;
    try {
      payload = JSON.parse(
        Buffer.from(match[1] ?? "", "base64url").toString("utf8"),
      );
    } catch {
      return invalid();
    }
    if (!isRecord(payload) || payload.version !== 1) return invalid();

    let ledgerKey: string | null;
    try {
      ledgerKey =
        this.ledgerKeys?.deriveLedgerKey({
          workspaceId: input.scope.workspaceId,
          repositoryId: input.scope.repositoryConnectionId,
          githubRepositoryId: input.repository.githubRepositoryId,
          repositoryFullName: input.repository.repositoryFullName,
        }) ?? null;
    } catch {
      return unavailable();
    }
    if (!ledgerKey) return unavailable();

    const expectedSignature = createHmac("sha256", ledgerKey)
      .update(canonicalJson(payload))
      .digest("hex");
    if (!safeEqualHex(expectedSignature, match[2] ?? "")) return invalid();
    if (
      payload.repo !== input.repository.repositoryFullName ||
      payload.pr !== input.scope.pullRequestNumber ||
      !Array.isArray(payload.entries)
    ) {
      return invalid();
    }

    let commandLedgerWatermark = 0n;
    for (const candidate of payload.entries) {
      if (!isRecord(candidate)) return invalid();
      if (candidate.action !== "skip" && candidate.action !== "unskip") {
        return invalid();
      }
      const rawId = candidate.commandCommentId ?? candidate.parentCommentId;
      if (
        typeof rawId !== "number" ||
        !Number.isSafeInteger(rawId) ||
        rawId <= 0
      ) {
        return invalid();
      }
      const id = BigInt(rawId);
      if (id > commandLedgerWatermark) commandLedgerWatermark = id;
    }
    return {
      status: ReviewCommandLedgerVerificationStatus.Valid,
      commandLedgerWatermark,
      commandLedgerStateDigest: expectedSignature,
    };
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function safeEqualHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/iu.test(left) || !/^[a-f0-9]{64}$/iu.test(right)) {
    return false;
  }
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(): ReviewCommandLedgerVerificationDecision {
  return { status: ReviewCommandLedgerVerificationStatus.Invalid };
}

function unavailable(): ReviewCommandLedgerVerificationDecision {
  return { status: ReviewCommandLedgerVerificationStatus.Unavailable };
}
