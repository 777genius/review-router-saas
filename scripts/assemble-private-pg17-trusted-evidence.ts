#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  assembleTrustedRolloutEvidence,
  type CleanupEvidence,
  type TrustedRolloutEvidence,
} from "../packages/features/release-rollout/src/index";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`private_pg17_evidence_required:${name}`);
  return value;
};
const bodyWithReceipts = JSON.parse(
  readFileSync(required("REVIEW_ROUTER_PRIVATE_ROLLOUT_BODY_FILE"), "utf8"),
) as Omit<
  TrustedRolloutEvidence,
  "schemaVersion" | "evidenceSha256" | "cleanups"
> & { receipts?: unknown };
const { receipts, ...body } = bodyWithReceipts;
if (receipts !== undefined && !Array.isArray(receipts))
  throw new Error("private_pg17_evidence_receipts_invalid");
const cleanupReceipts = [
  required("REVIEW_ROUTER_ROLE_BOOTSTRAP_RUNNER_CLEANUP_FILE"),
  required("REVIEW_ROUTER_CUTOVER_RUNNER_CLEANUP_FILE"),
].map(
  (path) =>
    JSON.parse(readFileSync(path, "utf8")) as { cleanup?: CleanupEvidence },
);
if (cleanupReceipts.some((receipt) => !receipt.cleanup))
  throw new Error("private_pg17_evidence_cleanup_missing");
const evidence = assembleTrustedRolloutEvidence({
  ...body,
  cleanups: cleanupReceipts.map((receipt) => receipt.cleanup) as [
    CleanupEvidence,
    CleanupEvidence,
  ],
});
process.stdout.write(`${JSON.stringify(evidence)}\n`);
