import { renderSchemaHandoffMigrationContract } from "./render-schema-handoff-policy.mjs";
import { renderManagedWorkflowCutoverPhase } from "./render-managed-workflow-cutover.mjs";

export const renderHistorical89AdmissionPhase = Object.freeze({
  kind: "managed-historical89-in-place/v1",
  // The seven bodies come from two separately reviewed lanes. Both identities
  // are bound: restating only one would leave half the applied SQL unattributed.
  handoffSourceCommit: renderSchemaHandoffMigrationContract.sourceCommit,
  cutoverSourceCommit: renderManagedWorkflowCutoverPhase.sourceCommit,
  baselineCount: 89,
  interimCount: 92,
  targetCount: 96,
  atomic: true,
  // 89 and 96 are the only durable endpoints. 92 is verified inside the same
  // backend and transaction; it never becomes a durable checkpoint here.
  baselineManifest: renderSchemaHandoffMigrationContract.baselineManifest,
  interimManifest: renderSchemaHandoffMigrationContract.targetManifest,
  targetManifest: renderManagedWorkflowCutoverPhase.targetManifest,
});
