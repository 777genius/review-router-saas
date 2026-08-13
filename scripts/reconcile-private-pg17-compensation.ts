#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  AuthenticatedRunnerLedgerAdapter,
  HttpProviderAuthorityDecisionAdapter,
  PostgreSqlGenerationAdapter,
  RedactedProcessCommandAdapter,
  ReleaseCompensationReconciliationUseCase,
  RenderProviderFreezeAdapter,
  type ReleaseRollout,
} from "../packages/features/release-rollout/src/index";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`private_pg17_reconcile_required:${name}`);
  return value;
};
const rollout = JSON.parse(
  readFileSync(required("REVIEW_ROUTER_INITIAL_ROLLOUT_FILE"), "utf8"),
) as ReleaseRollout;
if (rollout.rolloutId !== required("REVIEW_ROUTER_ROLLOUT_ID"))
  throw new Error("private_pg17_reconcile_rollout_mismatch");
const ledger = new AuthenticatedRunnerLedgerAdapter(
  required("REVIEW_ROUTER_RUNNER_LEDGER_URL"),
  required("REVIEW_ROUTER_RUNNER_LEDGER_TOKEN"),
);
const authority = new HttpProviderAuthorityDecisionAdapter(
  required("REVIEW_ROUTER_PROVIDER_AUTHORITY_URL"),
  required("REVIEW_ROUTER_PROVIDER_AUTHORITY_TOKEN"),
);
const database = new PostgreSqlGenerationAdapter(
  new RedactedProcessCommandAdapter(),
);
const provider = new RenderProviderFreezeAdapter();
const useCase = new ReleaseCompensationReconciliationUseCase({
  authority,
  ledger,
  compensateDatabase: async () =>
    database.compensateSource({
      adminUrl: required("REVIEW_ROUTER_SOURCE_DATABASE_URL"),
      source: rollout.source,
      reconnectUrls: JSON.parse(
        required("REVIEW_ROUTER_SOURCE_RECONNECT_URLS_JSON"),
      ) as Record<string, string>,
    }),
  provider: {
    compensateAndObserve: async ({ decision, databaseWitness }) =>
      provider.compensateAndObserve({
        apiKey: required("RENDER_SERVICE_SUSPENSION_API_KEY"),
        sourceWriterServiceIds: JSON.parse(
          required("REVIEW_ROUTER_SOURCE_WRITER_SERVICE_IDS"),
        ) as string[],
        sourceSystemIdentifier: rollout.source.systemIdentifier,
        decision,
        databaseWitness,
      }),
  },
});
process.stdout.write(`${JSON.stringify(await useCase.execute(rollout))}\n`);
