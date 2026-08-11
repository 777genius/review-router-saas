import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const harness = readFileSync(
  resolve("spikes/github-oidc/src/codex-rotating-live-e2e.ts"),
  "utf8",
);
const repositoryProvisioner = readFileSync(
  resolve(
    "packages/features/workflow-provisioning/src/application/use-cases/provision-repository-reviewrouter-workflow.ts",
  ),
  "utf8",
);
const wrapper = readFileSync(
  resolve("scripts/run-subscription-runtime-live-e2e.mjs"),
  "utf8",
);

describe("disposable Codex rotating live E2E wiring", () => {
  it("has no blocker, V3, or fixed stable-secret workflow path", () => {
    expect(harness).not.toContain(
      "codex_rotating_live_e2e_blocked_until_versioned_setup_protocol_is_wired",
    );
    expect(harness).not.toContain("ClientTriggeredLifecycleV3");
    expect(harness).not.toContain("secrets.REVIEWROUTER_CODEX_AUTH_JSON");
    expect(harness).toContain("assertRetiredStableSecretAbsent");
  });

  it("requires explicit mutation opt-in and exactly one disposable allowlisted repository", () => {
    expect(harness).toContain(
      'REVIEW_ROUTER_RUN_SUBSCRIPTION_RUNTIME_LIVE_E2E !== "1"',
    );
    expect(harness).toContain(
      "/(^rr-|reviewrouter|e2e|smoke|test|disposable)/i",
    );
    expect(harness).toContain("assertDisposableRepositoryProvenance");
    expect(harness).toContain(
      "REVIEW_ROUTER_CODEX_ROTATING_E2E_DISPOSABLE_REPOSITORY_ID",
    );
    expect(harness).toContain('["api", `repos/${repository}`, "--jq", ".id"]');
    expect(harness).not.toContain(
      '"id,nameWithOwner,isPrivate,isArchived,defaultBranchRef"',
    );
    expect(harness).toContain(
      "repository.githubRepositoryId.toString() !== repositoryView.numericId",
    );
    expect(harness).toContain("allowlist.length !== 1");
    expect(harness).toContain(
      "!allowlist.includes(repositoryFullName.toLowerCase())",
    );
    expect(harness).toContain("isLoopbackHostname(parsed.hostname)");
    expect(harness).not.toContain('parsed.hostname.endsWith(".localhost")');
  });

  it("uses the rotating exact-SHA contract and shared loopback policy at both entry points", () => {
    expect(harness).toContain("resolveReviewRouterCodexRotatingActionRef()");
    expect(wrapper).toContain(
      'read("REVIEW_ROUTER_CODEX_ROTATING_ACTION_REF")',
    );
    expect(wrapper).not.toContain('read("REVIEW_ROUTER_ACTION_REF")');
    expect(wrapper).toContain("isLoopbackHostname(parsed.hostname)");
  });

  it("provisions and attests V4, activates its exact namespace, and verifies durable writeback proof", () => {
    expect(harness).toContain("provisionRepositoryReviewRouterWorkflow");
    expect(harness).toContain("codexRotatingWorkflowSecretNamespace");
    expect(repositoryProvisioner).toContain(
      "CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV4",
    );
    expect(harness).toContain("assertTrustedCanonicalVersionedWorkflow");
    expect(harness).toContain("activateVersionedSetupNamespace");
    expect(harness).toContain("assertActiveWorkflowNamespace");
    expect(harness).toContain(
      'inspection.source !== "confirmed_setup_candidate"',
    );
    expect(harness).not.toContain("workflowNamespaceSource");
    expect(harness).toContain("assertCompletedVersionedWritebackForRun");
    expect(harness).toContain("waitForRunCompletion(runView)");
    expect(harness).toContain(
      "runView.headSha.toLowerCase() !== authoredHeadSha",
    );
    expect(harness).toContain("observed.attempt !== expected.attempt");
    expect(harness).toContain("githubRunAttempt: String(completedRun.attempt)");
    expect(harness).toContain("intent.latestGenerationHash ===");
    expect(harness).toContain(
      "intent.lease.restoredGenerationHash !== input.previousGenerationHash",
    );
    expect(harness).toContain(
      "intent.lease.nextGeneration !== input.expectedGeneration",
    );
    expect(harness).toContain("codex_rotating_e2e_namespace_did_not_advance");
    expect(harness).toContain(
      'previousNamespace.status !== "retired_superseded"',
    );
    for (const proofField of [
      "dispatchAttemptId",
      "secretNamespaceId",
      "dispatchAuthorizedAt",
      "providerResponseCode",
      "providerConfirmedAt",
      "workflowSourceCommitSha",
      "workflowSourceBlobSha",
      "workflowSourceSha256",
      "workflowSemanticSha256",
      "workflowSourceTrust",
      "attestedRepositoryId",
    ]) {
      expect(harness).toContain(proofField);
    }
  });
});
