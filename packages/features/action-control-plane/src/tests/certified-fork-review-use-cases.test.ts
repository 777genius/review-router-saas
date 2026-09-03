import { describe, expect, it } from "vitest";

import {
  certifiedForkReviewModelOutputHash,
  certifiedForkReviewPromptContextHash,
  parseCertifiedForkReviewFile,
  parseCertifiedForkReviewModelOutput,
  parseCertifiedForkReviewPromptPacket,
  serializeCertifiedForkReviewModelOutput,
} from "../application/use-cases/certified-fork-review-packet.js";
import { prepareCertifiedForkReview } from "../application/use-cases/prepare-certified-fork-review.js";
import { publishCertifiedForkReview } from "../application/use-cases/publish-certified-fork-review.js";

const binding = () => ({
  sourceRepository: "fork-owner/source",
  sourceRepositoryId: "10",
  baseRepository: "777genius/agent-teams-ai",
  baseRepositoryId: "20",
  pullRequestNumber: 42,
  reviewHeadSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  trustDomain: "fork" as const,
});
const file = (path = "src/review.ts") => ({
  path,
  status: "modified" as const,
  additions: 3,
  deletions: 1,
  patch: "@@ -1 +1 @@\n+review\n",
});
const files = () => [
  file(),
  { ...file("README.md"), status: "added" as const },
];
const prepare = () =>
  prepareCertifiedForkReview({ binding: binding(), files: files() });
const output = (overrides: Record<string, unknown> = {}) => ({
  protocolVersion: 1,
  summaryMarkdown: "Looks good",
  findings: [
    {
      severity: "minor" as const,
      title: "Naming",
      body: "Consider a clearer name.",
      path: "src/review.ts",
      startLine: 2,
      endLine: 3,
    },
  ],
  ...overrides,
});
const expectCode = (action: () => unknown, code: string) =>
  expect(action).toThrow(code);
const parseModel = (
  paths: readonly string[],
  changes: Record<string, unknown> = {},
) => parseCertifiedForkReviewModelOutput({ ...output(), ...changes }, paths);

describe("certified fork review pure use cases", () => {
  it("prepares a deterministic immutable schema-6 packet", () => {
    const sourceBinding = binding();
    const sourceFiles = files();
    const packet = prepareCertifiedForkReview({
      binding: sourceBinding,
      files: sourceFiles,
    });
    expect(Object.keys(packet)).toEqual([
      "protocolVersion",
      "binding",
      "contextHash",
      "files",
    ]);
    expect(packet.contextHash).toBe(
      certifiedForkReviewPromptContextHash(packet),
    );
    expect(Object.isFrozen(packet)).toBe(true);
    sourceBinding.reviewHeadSha = "c".repeat(40);
    sourceFiles[0]!.patch = "changed";
    expect(packet.binding.reviewHeadSha).toBe("a".repeat(40));
    expect(packet.files[0]!.patch).toContain("review");
    expect(
      prepareCertifiedForkReview({ binding: binding(), files: files() }),
    ).toEqual(packet);
  });

  it("rejects strict file and packet violations without invoking accessors", () => {
    const first = file();
    const assertFile = (value: unknown, code: string) =>
      expectCode(() => parseCertifiedForkReviewFile(value), code);
    assertFile({ ...first, extra: true }, "certified_fork_review_file_invalid");
    assertFile(
      { ...first, additions: "3" },
      "certified_fork_review_file_count_invalid",
    );
    assertFile(new Date(), "certified_fork_review_file_invalid");
    assertFile(new Proxy(first, {}), "certified_fork_review_file_invalid");
    let accessed = false;
    const accessor = { ...first };
    Object.defineProperty(accessor, "patch", {
      enumerable: true,
      get: () => {
        accessed = true;
        return "bad";
      },
    });
    assertFile(accessor, "certified_fork_review_file_invalid");
    expect(accessed).toBe(false);
    expectCode(
      () =>
        parseCertifiedForkReviewPromptPacket({
          protocolVersion: 1,
          binding: binding(),
          files: [first],
        }),
      "certified_fork_review_packet_invalid",
    );
  });

  it("rejects malformed prepare and publish envelopes without invoking getters", () => {
    const prepared = prepare();
    const validPublish = {
      prepared,
      binding: binding(),
      modelOutput: output(),
    };
    expectCode(
      () =>
        prepareCertifiedForkReview(
          new Proxy({ binding: binding(), files: files() }, {}),
        ),
      "certified_fork_review_prepare_input_invalid",
    );
    expectCode(
      () =>
        prepareCertifiedForkReview({
          binding: binding(),
          files: files(),
          extra: true,
        }),
      "certified_fork_review_prepare_input_invalid",
    );
    const prepareGetter = { binding: binding(), files: files() };
    Object.defineProperty(prepareGetter, "binding", {
      enumerable: true,
      get: () => {
        throw new Error("getter invoked");
      },
    });
    expectCode(
      () => prepareCertifiedForkReview(prepareGetter),
      "certified_fork_review_prepare_input_invalid",
    );
    expectCode(
      () => publishCertifiedForkReview(new Proxy(validPublish, {})),
      "certified_fork_review_publish_input_invalid",
    );
    expectCode(
      () => publishCertifiedForkReview({ ...validPublish, extra: true }),
      "certified_fork_review_publish_input_invalid",
    );
    const publishGetter = { ...validPublish };
    Object.defineProperty(publishGetter, "modelOutput", {
      enumerable: true,
      get: () => {
        throw new Error("getter invoked");
      },
    });
    expectCode(
      () => publishCertifiedForkReview(publishGetter),
      "certified_fork_review_publish_input_invalid",
    );
  });

  it("enforces UTF-8, safe paths, duplicate paths and bounded packet sizes", () => {
    const prepareFiles = (entries: unknown) =>
      prepareCertifiedForkReview({ binding: binding(), files: entries });
    for (const path of [
      "/tmp/a",
      "a\\b",
      "a//b",
      "a/../b",
      "a/./b",
      "a`b",
      "a\u202eb",
    ]) {
      expectCode(
        () => prepareFiles([{ ...file(), path }]),
        "certified_fork_review_file_path_invalid",
      );
    }
    expectCode(
      () => prepareFiles([file(), file()]),
      "certified_fork_review_duplicate_path",
    );
    expectCode(
      () => prepareFiles([{ ...file(), patch: "🙂".repeat(60_000) }]),
      "certified_fork_review_file_patch_invalid",
    );
    expectCode(
      () =>
        prepareFiles(
          Array.from({ length: 501 }, (_, index) => file(`src/${index}.ts`)),
        ),
      "certified_fork_review_files_too_many",
    );
    expectCode(
      () =>
        prepareFiles([
          { ...file(), patch: "x".repeat(150_000) },
          { ...file("README.md"), patch: "y".repeat(150_000) },
        ]),
      "certified_fork_review_packet_too_large",
    );
  });

  it("strictly parses model output and hashes exact accepted strings", () => {
    const packet = prepare();
    const paths = packet.files.map((entry) => entry.path);
    const parsed = parseCertifiedForkReviewModelOutput(output(), paths);
    expect(parsed.findings[0]!.title).toBe("Naming");
    expect(serializeCertifiedForkReviewModelOutput(parsed, paths)).toBe(
      '{"protocolVersion":1,"summaryMarkdown":"Looks good","findings":[{"severity":"minor","title":"Naming","body":"Consider a clearer name.","path":"src/review.ts","startLine":2,"endLine":3}]}',
    );
    expect(certifiedForkReviewModelOutputHash(parsed, paths)).toMatch(
      /^[a-f0-9]{64}$/u,
    );
  });

  it("rejects hostile model output, bad ranges, paths and sizes", () => {
    const paths = prepare().files.map((entry) => entry.path);
    const finding = output().findings[0]!;
    const assertModel = (changes: Record<string, unknown>, code: string) =>
      expectCode(() => parseModel(paths, changes), code);
    assertModel(
      { findings: "bad" },
      "certified_fork_review_model_findings_invalid",
    );
    assertModel({ extra: true }, "certified_fork_review_model_output_invalid");
    expectCode(
      () => parseCertifiedForkReviewModelOutput(new Proxy(output(), {}), paths),
      "certified_fork_review_model_output_invalid",
    );
    assertModel(
      { findings: [{ ...finding, severity: "urgent" }] },
      "certified_fork_review_finding_severity_invalid",
    );
    assertModel(
      { findings: [{ ...finding, startLine: 3, endLine: 2 }] },
      "certified_fork_review_finding_line_order_invalid",
    );
    assertModel(
      { findings: [{ ...finding, path: "unknown.ts" }] },
      "certified_fork_review_finding_path_unknown",
    );
    assertModel(
      { summaryMarkdown: "🙂".repeat(20_000) },
      "certified_fork_review_model_summary_invalid",
    );
    assertModel(
      { findings: Array.from({ length: 51 }, () => finding) },
      "certified_fork_review_model_findings_too_many",
    );
  });

  it("returns stale for changed fork binding fields and no model output", () => {
    const prepared = prepare();
    const stale = {
      status: "stale",
      code: "certified_fork_review_stale",
      binding: prepared.binding,
      contextHash: prepared.contextHash,
    };
    for (const [field, value] of [
      ["sourceRepository", "fork-owner/other"],
      ["sourceRepositoryId", "11"],
      ["baseRepository", "777genius/other"],
      ["baseRepositoryId", "21"],
      ["pullRequestNumber", 43],
      ["reviewHeadSha", "c".repeat(40)],
      ["baseSha", "d".repeat(40)],
    ] as const) {
      expect(
        publishCertifiedForkReview({
          prepared,
          binding: { ...binding(), [field]: value },
          modelOutput: output(),
        }),
      ).toEqual(stale);
    }
  });

  it("returns ready only for matching valid output and preserves snapshots", () => {
    const prepared = prepare();
    const source = output();
    const ready = publishCertifiedForkReview({
      prepared,
      binding: binding(),
      modelOutput: source,
    });
    expect(ready.status).toBe("ready");
    if (ready.status === "ready") {
      expect(ready.outputHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(Object.isFrozen(ready)).toBe(true);
      source.findings[0]!.title = "changed";
      expect(ready.modelOutput.findings[0]!.title).toBe("Naming");
    }
    expectCode(
      () =>
        publishCertifiedForkReview({
          prepared,
          binding: binding(),
          modelOutput: { ...output(), findings: "bad" },
        }),
      "certified_fork_review_model_findings_invalid",
    );
    expectCode(
      () =>
        publishCertifiedForkReview({
          prepared: { ...prepared, contextHash: "0".repeat(64) },
          binding: binding(),
          modelOutput: output(),
        }),
      "certified_fork_review_context_hash_mismatch",
    );
  });
});
