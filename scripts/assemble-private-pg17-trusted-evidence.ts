#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  assertTrustedRolloutEvidence,
  type TrustedRolloutEvidence,
} from "../packages/features/release-rollout/src/index";
const path = process.env.REVIEW_ROUTER_FINALIZED_ROLLOUT_FILE;
if (!path) throw new Error("private_pg17_finalized_rollout_file_required");
const finalized = JSON.parse(readFileSync(path, "utf8")) as {
  evidence?: TrustedRolloutEvidence;
  finalReceipt?: unknown;
  phase?: string;
};
if (
  !finalized.evidence ||
  !finalized.finalReceipt ||
  finalized.phase !== "rollout_verified"
)
  throw new Error("private_pg17_finalized_rollout_incomplete");
assertTrustedRolloutEvidence(finalized.evidence);
process.stdout.write(`${JSON.stringify(finalized.evidence)}\n`);
