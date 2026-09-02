import { CodexRotatingT0WorkflowSchemaVersion } from "@reviewrouter/features-workflow-provisioning";

export type CodexRotatingVersionedWriterSchemaVersion =
  | CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV4
  | CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV5;

export type CodexRotatingWriterSchemaPolicyConfiguration = Readonly<{
  v5WritingEnabled: boolean;
  configuredReaderReleaseCommitSha?: string | undefined;
  runtimeReleaseCommitSha?: string | undefined;
}>;

export class CodexRotatingWriterSchemaPolicy {
  readonly #v5WritingAuthorized: boolean;

  constructor(configuration: CodexRotatingWriterSchemaPolicyConfiguration) {
    this.#v5WritingAuthorized =
      configuration.v5WritingEnabled &&
      isFullCommitSha(configuration.configuredReaderReleaseCommitSha) &&
      isFullCommitSha(configuration.runtimeReleaseCommitSha) &&
      configuration.configuredReaderReleaseCommitSha ===
        configuration.runtimeReleaseCommitSha;
  }

  selectWriterSchemaVersion(
    input: Readonly<{
      existingNamespace: boolean;
      existingWorkflowSchemaVersion?: number | null;
    }>,
  ): CodexRotatingVersionedWriterSchemaVersion {
    if (
      input.existingWorkflowSchemaVersion ===
      CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV5
    ) {
      return CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV5;
    }
    if (
      input.existingNamespace &&
      input.existingWorkflowSchemaVersion !==
        CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV4
    ) {
      throw new Error("codex_rotating_writer_schema_state_invalid");
    }
    return this.#v5WritingAuthorized
      ? CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV5
      : CodexRotatingT0WorkflowSchemaVersion.VersionedSecretNamespaceV4;
  }
}

function isFullCommitSha(value: string | undefined): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/iu.test(value);
}
