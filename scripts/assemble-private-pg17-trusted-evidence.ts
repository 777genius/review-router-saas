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
  "schemaVersion" | "evidenceSha256" | "cleanup"
> & { receipts?: unknown };
const { receipts, ...body } = bodyWithReceipts;
if (receipts !== undefined && !Array.isArray(receipts))
  throw new Error("private_pg17_evidence_receipts_invalid");
const cleanupReceipt = JSON.parse(
  readFileSync(required("REVIEW_ROUTER_PRIVATE_RUNNER_CLEANUP_FILE"), "utf8"),
) as { cleanup?: CleanupEvidence };
if (!cleanupReceipt.cleanup)
  throw new Error("private_pg17_evidence_cleanup_missing");
const evidence = assembleTrustedRolloutEvidence({
  ...body,
  cleanup: cleanupReceipt.cleanup,
});
process.stdout.write(`${JSON.stringify(evidence)}\n`);
