#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  assertTrustedRolloutEvidence,
  type TrustedRolloutEvidence,
} from "../packages/features/release-rollout/src/index";

const path = process.argv[2];
if (!path) throw new Error("private_pg17_evidence_path_required");
assertTrustedRolloutEvidence(
  JSON.parse(readFileSync(path, "utf8")) as TrustedRolloutEvidence,
);
process.stdout.write("Private PG17 trusted rollout evidence verified.\n");
