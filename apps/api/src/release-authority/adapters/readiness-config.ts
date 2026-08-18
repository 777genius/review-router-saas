import {
  defaultReadinessTimingPolicy,
  validateReadinessTimingPolicy,
  type ReadinessTimingPolicy,
} from "../application/attestation-lease.js";

const integer = (
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number => {
  const raw = environment[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]*$/u.test(raw))
    throw new Error(`release_authority_readiness_config_invalid:${name}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value))
    throw new Error(`release_authority_readiness_config_invalid:${name}`);
  return value;
};

/** Environment adapter for database/app bounds; lease and refresh remain fixed. */
export function readinessTimingPolicyFromEnvironment(
  environment: NodeJS.ProcessEnv,
): ReadinessTimingPolicy {
  return validateReadinessTimingPolicy({
    ...defaultReadinessTimingPolicy,
    poolWaitMilliseconds: integer(
      environment,
      "REVIEW_ROUTER_READINESS_POOL_WAIT_MS",
      defaultReadinessTimingPolicy.poolWaitMilliseconds,
    ),
    lockTimeoutMilliseconds: integer(
      environment,
      "REVIEW_ROUTER_READINESS_LOCK_TIMEOUT_MS",
      defaultReadinessTimingPolicy.lockTimeoutMilliseconds,
    ),
    statementTimeoutMilliseconds: integer(
      environment,
      "REVIEW_ROUTER_READINESS_STATEMENT_TIMEOUT_MS",
      defaultReadinessTimingPolicy.statementTimeoutMilliseconds,
    ),
    transactionTimeoutMilliseconds: integer(
      environment,
      "REVIEW_ROUTER_READINESS_TRANSACTION_TIMEOUT_MS",
      defaultReadinessTimingPolicy.transactionTimeoutMilliseconds,
    ),
    observationDeadlineMilliseconds: integer(
      environment,
      "REVIEW_ROUTER_READINESS_OBSERVATION_DEADLINE_MS",
      defaultReadinessTimingPolicy.observationDeadlineMilliseconds,
    ),
  });
}
