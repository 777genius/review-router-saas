#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  assertTrustedRolloutEvidence,
  type TrustedRolloutEvidence,
} from "../packages/features/release-rollout/src/index";
import { privatePg17ReleaseImagePolicy } from "./lib/private-pg17-release-image-policy";
const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`private_pg17_evidence_policy_missing:${name}`);
  return value;
};
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
assertTrustedRolloutEvidence(
  finalized.evidence,
  privatePg17ReleaseImagePolicy({
    sourceRepository: required("REVIEW_ROUTER_RELEASE_CONTROL_REPOSITORY"),
    sourceRevision: required("REVIEW_ROUTER_EXPECTED_SHA"),
  }),
  {
    keyId: required("REVIEW_ROUTER_RELEASE_WITNESS_SIGNING_KEY_ID"),
    publicKeyPem: required(
      "REVIEW_ROUTER_RELEASE_WITNESS_SIGNING_PUBLIC_KEY_PEM",
    ),
    maximumAgeMilliseconds: Number(
      process.env.REVIEW_ROUTER_RELEASE_WITNESS_MAXIMUM_AGE_MS || "300000",
    ),
  },
);
process.stdout.write(`${JSON.stringify(finalized.evidence)}\n`);
