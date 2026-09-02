import { CodexRotatingWriterSchemaPolicy } from "./codex-rotating-writer-schema-policy";

type CodexRotatingWriterSchemaPolicyEnv = Readonly<{
  REVIEW_ROUTER_ENABLE_CODEX_ROTATING_V5_WRITES?: string;
  REVIEW_ROUTER_CODEX_ROTATING_V5_READER_RELEASE_COMMIT_SHA?: string;
  REVIEW_ROUTER_RUNTIME_RELEASE_COMMIT_SHA?: string;
  readonly [key: string]: string | undefined;
}>;

export function createCodexRotatingWriterSchemaPolicy(
  env: CodexRotatingWriterSchemaPolicyEnv = process.env,
): CodexRotatingWriterSchemaPolicy {
  return new CodexRotatingWriterSchemaPolicy({
    v5WritingEnabled: env.REVIEW_ROUTER_ENABLE_CODEX_ROTATING_V5_WRITES === "1",
    configuredReaderReleaseCommitSha:
      env.REVIEW_ROUTER_CODEX_ROTATING_V5_READER_RELEASE_COMMIT_SHA,
    runtimeReleaseCommitSha: env.REVIEW_ROUTER_RUNTIME_RELEASE_COMMIT_SHA,
  });
}
