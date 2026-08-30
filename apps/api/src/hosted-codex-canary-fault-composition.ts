import { noHostedCodexCanaryFaultPlan } from "@reviewrouter/features-hosted-account-pool";
import type { PrismaClient } from "@reviewrouter/platform-db";
import { createPrismaHostedCodexCanaryFaultPlanPort } from "./hosted-codex-canary-fault-plan.js";

/** Composes only server-owned operator authority; repository requests are absent. */
export function composeHostedCodexCanaryFaultPlans(input: {
  readonly prisma: PrismaClient;
  readonly env: Readonly<Record<string, string | undefined>>;
}) {
  const authorityKeyId =
    input.env.REVIEW_ROUTER_HOSTED_CODEX_CANARY_FAULT_AUTHORITY_KEY_ID?.trim();
  const authorityPublicKeyPem =
    input.env.REVIEW_ROUTER_HOSTED_CODEX_CANARY_FAULT_AUTHORITY_PUBLIC_KEY?.trim();
  if (!authorityKeyId && !authorityPublicKeyPem)
    return noHostedCodexCanaryFaultPlan;
  if (!authorityKeyId || !authorityPublicKeyPem)
    throw new Error("hosted_codex_canary_fault_plan_config_incomplete");
  if (input.env.NODE_ENV !== "production")
    throw new Error("hosted_codex_canary_fault_plan_production_only");
  return createPrismaHostedCodexCanaryFaultPlanPort({
    prisma: input.prisma,
    expectedAuthorityKeyId: authorityKeyId,
    authorityPublicKeyPem: authorityPublicKeyPem.replaceAll("\\n", "\n"),
  });
}
