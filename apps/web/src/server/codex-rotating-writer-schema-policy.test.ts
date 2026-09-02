import { describe, expect, it } from "vitest";
import { CodexRotatingT0WorkflowSchemaVersion } from "@reviewrouter/features-workflow-provisioning";
import { CodexRotatingWriterSchemaPolicy } from "./codex-rotating-writer-schema-policy";
import { createCodexRotatingWriterSchemaPolicy } from "./codex-rotating-writer-schema-policy-env";

const releaseSha = "a".repeat(40);
const v4 = CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV4;
const v5 = CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV5;

describe("CodexRotatingWriterSchemaPolicy", () => {
  it.each([
    [
      "defaults a new namespace to V4",
      { v5WritingEnabled: false },
      false,
      null,
      v4,
    ],
    [
      "requires explicit V5 enablement",
      {
        v5WritingEnabled: false,
        configuredReaderReleaseCommitSha: releaseSha,
        runtimeReleaseCommitSha: releaseSha,
      },
      false,
      null,
      v4,
    ],
    [
      "requires exact reader and runtime release equality",
      {
        v5WritingEnabled: true,
        configuredReaderReleaseCommitSha: releaseSha,
        runtimeReleaseCommitSha: "b".repeat(40),
      },
      false,
      null,
      v4,
    ],
    [
      "authorizes V5 only when the deployment identity gate passes",
      {
        v5WritingEnabled: true,
        configuredReaderReleaseCommitSha: releaseSha,
        runtimeReleaseCommitSha: releaseSha,
      },
      false,
      null,
      v5,
    ],
    [
      "keeps an existing V4 namespace on V4 while unauthorized",
      { v5WritingEnabled: false },
      true,
      v4,
      v4,
    ],
    [
      "allows an existing V4 namespace to transition when authorized",
      {
        v5WritingEnabled: true,
        configuredReaderReleaseCommitSha: releaseSha,
        runtimeReleaseCommitSha: releaseSha,
      },
      true,
      v4,
      v5,
    ],
    [
      "never downgrades an existing V5 namespace",
      { v5WritingEnabled: false },
      true,
      v5,
      v5,
    ],
  ] as const)(
    "%s",
    (
      _name,
      configuration,
      existingNamespace,
      existingWorkflowSchemaVersion,
      expected,
    ) => {
      expect(
        new CodexRotatingWriterSchemaPolicy(
          configuration,
        ).selectWriterSchemaVersion({
          existingNamespace,
          existingWorkflowSchemaVersion,
        }),
      ).toBe(expected);
    },
  );

  it("fails closed when an existing namespace has no versioned schema identity", () => {
    const policy = new CodexRotatingWriterSchemaPolicy({
      v5WritingEnabled: false,
    });
    expect(() =>
      policy.selectWriterSchemaVersion({
        existingNamespace: true,
        existingWorkflowSchemaVersion: null,
      }),
    ).toThrow("codex_rotating_writer_schema_state_invalid");
  });

  it("keeps environment parsing in the adapter", () => {
    expect(
      createCodexRotatingWriterSchemaPolicy({
        REVIEW_ROUTER_ENABLE_CODEX_ROTATING_V5_WRITES: "1",
        REVIEW_ROUTER_CODEX_ROTATING_V5_READER_RELEASE_COMMIT_SHA: releaseSha,
        REVIEW_ROUTER_RUNTIME_RELEASE_COMMIT_SHA: releaseSha,
      }).selectWriterSchemaVersion({ existingNamespace: false }),
    ).toBe(v5);
    expect(
      createCodexRotatingWriterSchemaPolicy({
        REVIEW_ROUTER_ENABLE_CODEX_ROTATING_V5_WRITES: "true",
        REVIEW_ROUTER_CODEX_ROTATING_V5_READER_RELEASE_COMMIT_SHA: releaseSha,
        REVIEW_ROUTER_RUNTIME_RELEASE_COMMIT_SHA: releaseSha,
      }).selectWriterSchemaVersion({ existingNamespace: false }),
    ).toBe(v4);
  });
});
