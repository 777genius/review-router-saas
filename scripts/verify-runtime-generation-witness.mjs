#!/usr/bin/env node
import { createHash, timingSafeEqual } from "node:crypto";

const required = (env, name) => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`runtime_generation_witness_required:${name}`);
  return value;
};

export function verifyRuntimeGenerationWitness(env = process.env) {
  const witness = required(env, "REVIEW_ROUTER_DATABASE_RECOVERY_WITNESS");
  const expected = required(
    env,
    "REVIEW_ROUTER_EXPECTED_RECOVERY_WITNESS_SHA256",
  );
  if (
    !/^[A-Za-z0-9_-]{43,256}$/u.test(witness) ||
    !/^[a-f0-9]{64}$/u.test(expected)
  )
    throw new Error("runtime_generation_witness_invalid");
  const actual = createHash("sha256").update(witness, "utf8").digest();
  const expectedBuffer = Buffer.from(expected, "hex");
  if (
    actual.length !== expectedBuffer.length ||
    !timingSafeEqual(actual, expectedBuffer)
  )
    throw new Error("runtime_generation_witness_mismatch");
  return expected;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  verifyRuntimeGenerationWitness();
}
