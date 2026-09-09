import { describe, expect, it } from "vitest";
import {
  captureReviewRouterComments,
  certifiedForkPlan,
  certifiedForkRoute,
  validateCertifiedForkEvidence,
} from "./certified-fork-e2e-evidence.mjs";

const sha = "a".repeat(40);
const hash = "b".repeat(64);
function fixture() {
  const binding = {
    tuple: {
      baseRepository: "test/base",
      baseRepositoryId: "1",
      sourceRepository: "test/fork",
      sourceRepositoryId: "2",
      pullRequestNumber: 3,
      baseSha: sha,
      reviewHeadSha: "c".repeat(40),
      trustDomain: "fork",
    },
    identity: {
      installationId: "4",
      providerInstanceId: "provider-5",
      appId: "6",
      appSlug: "reviewrouter-test",
    },
    workflow: {
      saasCommit: sha,
      actionRepository: "test/action",
      actionSha: sha,
      runtimeRepository: "test/runtime",
      runtimeSha: sha,
      runtimePath: ".github/workflows/reviewrouter-t0-reusable.yml",
      workflowPath: ".github/workflows/reviewrouter-codex.yml",
      workflowCommit: sha,
      workflowBlob: sha,
      contentSha256: hash,
      semanticSha256: hash,
      observedSchema: 5,
      executionMode: "client-triggered-t0",
    },
    runId: "7",
    runAttempt: 2,
    contextHash: hash,
    outputHash: hash,
  };
  const witness = (reference: string) => ({
    reference,
    sha256: hash,
    binding: structuredClone(binding),
  });
  return {
    evidenceVersion: 1,
    scenario: "certified-fork",
    binding,
    witnesses: {
      preparation: witness("preparation"),
      prepublication: witness("prepublication"),
      command: witness("command"),
      receipt: witness("receipt"),
      effect: witness("effect"),
      trustedExecution: witness("trusted-execution"),
    },
    reconciliation: {
      outcome: "confirmed",
      witness: witness("reconciliation"),
    },
    zeroEffects: {
      scope: "fork-content-execution",
      observation: witness("zero-effects"),
    },
    disposable: {
      baseRepositoryId: "1",
      sourceRepositoryId: "2",
      provenance: witness("disposable"),
      cleanup: "completed",
      cleanupWitness: witness("cleanup"),
    },
    comments: [
      {
        id: 8,
        surface: "inline",
        author: "reviewrouter-test[bot]",
        appId: "6",
        reviewedCommit: binding.tuple.reviewHeadSha,
        observation: witness("comment-8"),
      },
    ],
  };
}

describe("certified fork candidate evidence (data validation only)", () => {
  it("never certifies even a structurally complete fixture", () => {
    expect(validateCertifiedForkEvidence(fixture())).toMatchObject({
      status: "blocked",
      dataStatus: "valid",
      authenticity: "unverified",
      unmetGates: certifiedForkPlan().unmetGates,
    });
    expect(validateCertifiedForkEvidence(certifiedForkPlan()).dataStatus).toBe(
      "invalid",
    );
  });

  it.each([
    null,
    [],
    {},
    true,
    "pass",
    { status: "pass", authenticated: true },
  ])("rejects malformed envelopes %j", (e) => {
    expect(validateCertifiedForkEvidence(e).dataStatus).toBe("invalid");
  });

  it("requires every top-level field and every witness", () => {
    const e = fixture();
    for (const key of Object.keys(e)) {
      const copy: any = structuredClone(e);
      delete copy[key];
      expect(validateCertifiedForkEvidence(copy).dataStatus, key).toBe(
        "invalid",
      );
    }
    for (const key of Object.keys(e.witnesses)) {
      const copy: any = structuredClone(e);
      delete copy.witnesses[key];
      expect(validateCertifiedForkEvidence(copy).dataStatus, key).toBe(
        "invalid",
      );
    }
  });

  it("rejects every missing or mixed tuple, identity, workflow and run/context field", () => {
    const original = fixture();
    const paths = [
      ...["tuple", "identity", "workflow"].flatMap((group) =>
        Object.keys((original.binding as any)[group]).map((key) => [
          group,
          key,
        ]),
      ),
      ...["runId", "runAttempt", "contextHash", "outputHash"].map((key) => [
        key,
      ]),
    ];
    for (const path of paths) {
      for (const operation of ["missing", "mixed"]) {
        const e = fixture();
        let target: any = e.witnesses.prepublication.binding;
        for (const key of path.slice(0, -1)) target = target[key];
        const key = path.at(-1)!;
        if (operation === "missing") delete target[key];
        else
          target[key] =
            typeof target[key] === "number"
              ? target[key] + 1
              : `${target[key]}x`;
        expect(
          validateCertifiedForkEvidence(e).dataStatus,
          `${operation}:${path}`,
        ).toBe("invalid");
      }
    }
  });

  it.each([
    [
      "mixed attempt",
      (e: any) => {
        e.witnesses.receipt.binding.runAttempt = 3;
      },
    ],
    [
      "mixed valid SHA",
      (e: any) => {
        e.witnesses.prepublication.binding.tuple.baseSha = "d".repeat(40);
      },
    ],
    [
      "missing context",
      (e: any) => {
        delete e.binding.contextHash;
      },
    ],
    [
      "mutable runtime",
      (e: any) => {
        e.binding.workflow.runtimeSha = "v1";
      },
    ],
    [
      "unsupported schema",
      (e: any) => {
        e.binding.workflow.observedSchema = 6;
      },
    ],
    [
      "legacy workflow",
      (e: any) => {
        e.binding.workflow.workflowPath = ".github/workflows/reviewrouter.yml";
      },
    ],
    [
      "same repo ID",
      (e: any) => {
        e.binding.tuple.sourceRepositoryId = "1";
      },
    ],
    [
      "Actions is not the configured App",
      (e: any) => {
        Object.assign(
          e,
          JSON.parse(
            JSON.stringify(e).replaceAll("reviewrouter-test", "github-actions"),
          ),
        );
      },
    ],
    [
      "wrong App login",
      (e: any) => {
        e.comments[0].author = "github-actions[bot]";
      },
    ],
    [
      "wrong App ID",
      (e: any) => {
        e.comments[0].appId = "999";
      },
    ],
    [
      "stale comment",
      (e: any) => {
        e.comments[0].reviewedCommit = sha;
      },
    ],
    [
      "duplicate comment",
      (e: any) => {
        e.comments.push(e.comments[0]);
      },
    ],
    [
      "reused witness",
      (e: any) => {
        e.witnesses.receipt.reference = "command";
      },
    ],
    [
      "no comments",
      (e: any) => {
        e.comments = [];
      },
    ],
    [
      "unscoped absence",
      (e: any) => {
        e.zeroEffects.scope = "all";
      },
    ],
    [
      "wrong cleanup repo",
      (e: any) => {
        e.disposable.sourceRepositoryId = "99";
      },
    ],
    [
      "caller attestation",
      (e: any) => {
        e.authenticated = true;
      },
    ],
    [
      "secret payload",
      (e: any) => {
        e.witnesses.command.payload = "not-allowed";
      },
    ],
    [
      "unknown retry",
      (e: any) => {
        e.reconciliation.outcome = "retryable";
      },
    ],
    [
      "caller retry permission",
      (e: any) => {
        e.reconciliation.retryable = true;
      },
    ],
  ])("rejects %s", (_label, mutate) => {
    const e = fixture();
    mutate(e);
    expect(validateCertifiedForkEvidence(e).dataStatus).toBe("invalid");
  });

  it("keeps unknown effects reconciliation-required even with no comments", () => {
    const e = fixture();
    e.comments = [];
    e.reconciliation.outcome = "reconciliation-required";
    const result = validateCertifiedForkEvidence(e);
    expect(result).toMatchObject({ status: "blocked", dataStatus: "valid" });
    expect(result.unmetGates).toContain("effect-reconciliation");
    e.reconciliation.outcome = "refused";
    expect(validateCertifiedForkEvidence(e)).toMatchObject({
      status: "blocked",
      dataStatus: "valid",
    });
    delete (e as any).zeroEffects;
    expect(validateCertifiedForkEvidence(e).dataStatus).toBe("invalid");
  });
});

const advisory = (id: number, login = "reviewrouter-test[bot]") => ({
  id,
  user: { login },
  body: "<!-- reviewrouter:codex-oauth-rotating -->",
});
const inline = (id: number, login = "reviewrouter-test[bot]") => ({
  ...advisory(id, login),
  body: "<!-- review-router-inline:fixture -->",
  commit_id: sha,
});
const capture = (advisories: any[], inlines: any[] = []) =>
  captureReviewRouterComments({
    advisory: advisories,
    inline: inlines,
    expectedAuthor: "reviewrouter-test[bot]",
  });

describe("ordinary PR observation capture", () => {
  it("retains every matching comment, with no bodies or invented advisory commit", () => {
    expect(capture([advisory(1), advisory(2)], [inline(3)])).toEqual([
      {
        id: 1,
        surface: "advisory",
        author: "reviewrouter-test[bot]",
        reviewedCommit: null,
      },
      {
        id: 2,
        surface: "advisory",
        author: "reviewrouter-test[bot]",
        reviewedCommit: null,
      },
      {
        id: 3,
        surface: "inline",
        author: "reviewrouter-test[bot]",
        reviewedCommit: sha,
      },
    ]);
  });
  it("rejects a wrong second advisory or inline author, including later pages", () => {
    expect(() =>
      capture([advisory(1), advisory(2, "github-actions[bot]")]),
    ).toThrow();
    expect(() => capture([], [inline(1), inline(2, "other[bot]")])).toThrow();
    expect(() =>
      capture([
        ...Array.from({ length: 100 }, (_, i) => advisory(i + 1)),
        advisory(101, "other[bot]"),
      ]),
    ).toThrow();
  });
  it("ignores unrelated human comments but rejects malformed/duplicate observations", () => {
    expect(capture([{ ...advisory(1, "human"), body: "hello" }])).toEqual([]);
    expect(() => capture([advisory(1), advisory(1)])).toThrow();
    expect(() => capture([{ ...advisory(1), body: null }])).toThrow();
    expect(() => capture([], [{ ...inline(1), commit_id: null }])).toThrow();
  });
});

it("routes only the isolated plan, refuses certified live and preserves ordinary arguments", () => {
  expect(certifiedForkRoute(["--certified-fork-plan"])).toMatchObject({
    exitCode: 0,
    evidence: { status: "blocked" },
  });
  for (const args of [
    ["--certified-fork"],
    ["--certified-fork-plan", "--check-only"],
    ["--certified-fork-plan=true"],
    ["--certified-fork-plan", "--certified-fork-plan"],
  ]) {
    expect(certifiedForkRoute(args)).toMatchObject({
      exitCode: 1,
      evidence: { status: "blocked" },
    });
  }
  for (const args of [[], ["--check-only"], ["--unknown-existing-option"]])
    expect(certifiedForkRoute(args)).toBeNull();
});
