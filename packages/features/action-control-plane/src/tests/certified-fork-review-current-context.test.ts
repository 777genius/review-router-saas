import { describe, expect, it, vi } from "vitest";

import type { CertifiedForkReviewGatewayPort } from "../application/ports/certified-fork-review-port.js";
import {
  prepareCertifiedForkReview,
  prepareCurrentCertifiedForkReview,
} from "../application/use-cases/prepare-certified-fork-review.js";
import {
  publishCertifiedForkReview,
  validateCurrentCertifiedForkReviewOutput,
} from "../application/use-cases/publish-certified-fork-review.js";

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
const file = () => ({
  path: "src/review.ts",
  status: "modified" as const,
  additions: 3,
  deletions: 1,
  patch: "@@ -1 +1 @@\n+review\n",
});
const prepare = (changes = {}) =>
  prepareCertifiedForkReview({
    binding: { ...binding(), ...changes },
    files: [file()],
  });
const output = () => ({
  protocolVersion: 1,
  summaryMarkdown: "Looks good",
  findings: [
    {
      severity: "minor",
      title: "Naming",
      body: "Consider a clearer name.",
      path: "src/review.ts",
      startLine: 2,
      endLine: 3,
    },
  ],
});
const prepareInput = () => ({
  githubInstallationId: "123",
  binding: binding(),
});
const publishInput = () => ({
  ...prepareInput(),
  prepared: prepare(),
  modelOutput: output(),
});
const mutations = [
  ["sourceRepository", "fork-owner/other"],
  ["sourceRepositoryId", "11"],
  ["baseRepository", "777genius/other"],
  ["baseRepositoryId", "21"],
  ["pullRequestNumber", 43],
  ["reviewHeadSha", "c".repeat(40)],
  ["baseSha", "d".repeat(40)],
] as const;
const gateway = () => ({
  prepareContext: vi
    .fn<CertifiedForkReviewGatewayPort["prepareContext"]>()
    .mockResolvedValue({
      contextHash: prepare().contextHash,
      promptPacket: prepare(),
    }),
  assertContextCurrent: vi
    .fn<CertifiedForkReviewGatewayPort["assertContextCurrent"]>()
    .mockResolvedValue({ promptPacket: prepare() }),
  assertBindingCurrent:
    vi.fn<CertifiedForkReviewGatewayPort["assertBindingCurrent"]>(),
});
const calls = (
  g: ReturnType<typeof gateway>,
  prepares: number,
  asserts: number,
) => {
  expect(g.prepareContext).toHaveBeenCalledTimes(prepares);
  expect(g.assertContextCurrent).toHaveBeenCalledTimes(asserts);
  expect(g.assertBindingCurrent).not.toHaveBeenCalled();
};
const frozen = (value: unknown): void => {
  if (value !== null && typeof value === "object") {
    expect(Object.isFrozen(value)).toBe(true);
    for (const child of Object.values(value)) frozen(child);
  }
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const hostile = (value: object, callback: () => never): object[] => {
  const revoked = Proxy.revocable(value, {});
  revoked.revoke();
  return [
    new Proxy(value, {
      // Native Promise resolution probes `then` before the use case receives
      // a gateway envelope. Keep that transport probe inert.
      get: (_target, key) => (key === "then" ? undefined : callback()),
      getPrototypeOf: callback,
      ownKeys: callback,
      getOwnPropertyDescriptor: callback,
    }),
    revoked.proxy,
    ...Object.keys(value).map((key) =>
      Object.defineProperty({ ...value }, key, {
        enumerable: true,
        get: callback,
      }),
    ),
  ];
};

describe("gateway-backed certified fork current context", () => {
  it("returns detached immutable packets and the existing ready shape with one call", async () => {
    const g = gateway();
    const source = { ...prepare(), binding: binding(), files: [file()] };
    g.prepareContext.mockResolvedValue({
      contextHash: source.contextHash,
      promptPacket: source,
    });
    const packet = await prepareCurrentCertifiedForkReview(prepareInput(), {
      gateway: g,
    });
    expect(packet).toEqual(prepare());
    expect(packet).not.toBe(source);
    expect(packet.files).not.toBe(source.files);
    frozen(packet);
    calls(g, 1, 0);
    const input = publishInput();
    const ready = await validateCurrentCertifiedForkReviewOutput(input, {
      gateway: g,
    });
    expect(ready).toEqual(
      publishCertifiedForkReview(inputWithoutInstallation(input)),
    );
    frozen(ready);
    expect(g.assertContextCurrent).toHaveBeenCalledWith({
      githubInstallationId: "123",
      binding: binding(),
      expectedContextHash: packet.contextHash,
    });
    calls(g, 1, 1);
  });

  it.each(mutations)(
    "preserves stale-before-poison for %s with no calls",
    async (key, value) => {
      const g = gateway();
      const callback = vi.fn((): never => {
        throw new Error("callback");
      });
      for (const poison of hostile(output(), callback)) {
        const input = {
          ...publishInput(),
          binding: { ...binding(), [key]: value },
          modelOutput: poison,
        };
        const result = await validateCurrentCertifiedForkReviewOutput(input, {
          gateway: g,
        });
        expect(result).toEqual(
          publishCertifiedForkReview(inputWithoutInstallation(input)),
        );
        expect(result.status).toBe("stale");
        frozen(result);
      }
      expect(callback).not.toHaveBeenCalled();
      calls(g, 0, 0);
    },
  );

  it.each(mutations)(
    "rejects another valid gateway binding at %s",
    async (key, value) => {
      const g = gateway();
      const packet = prepare({ [key]: value });
      g.prepareContext.mockResolvedValue({
        contextHash: packet.contextHash,
        promptPacket: packet,
      });
      g.assertContextCurrent.mockResolvedValue({ promptPacket: packet });
      await expect(
        prepareCurrentCertifiedForkReview(prepareInput(), { gateway: g }),
      ).rejects.toThrow("certified_fork_review_binding_mismatch");
      await expect(
        validateCurrentCertifiedForkReviewOutput(publishInput(), {
          gateway: g,
        }),
      ).rejects.toThrow("certified_fork_review_binding_mismatch");
      calls(g, 1, 1);
    },
  );

  it("accepts the maximum safe installation ID with one call per entry point", async () => {
    const g = gateway();
    const githubInstallationId = String(Number.MAX_SAFE_INTEGER);
    await expect(
      prepareCurrentCertifiedForkReview(
        { ...prepareInput(), githubInstallationId },
        { gateway: g },
      ),
    ).resolves.toEqual(prepare());
    expect(g.prepareContext).toHaveBeenCalledWith({
      githubInstallationId,
      binding: binding(),
    });
    calls(g, 1, 0);
    const input = { ...publishInput(), githubInstallationId };
    await expect(
      validateCurrentCertifiedForkReviewOutput(input, { gateway: g }),
    ).resolves.toEqual(
      publishCertifiedForkReview(inputWithoutInstallation(input)),
    );
    expect(g.assertContextCurrent).toHaveBeenCalledWith({
      githubInstallationId,
      binding: binding(),
      expectedContextHash: input.prepared.contextHash,
    });
    calls(g, 1, 1);
  });

  it.each([String(Number.MAX_SAFE_INTEGER + 1), "9".repeat(400)])(
    "rejects oversized installation ID %s before any gateway call",
    async (githubInstallationId) => {
      const g = gateway();
      await expect(
        prepareCurrentCertifiedForkReview(
          { ...prepareInput(), githubInstallationId },
          { gateway: g },
        ),
      ).rejects.toThrow("certified_fork_review_installation_invalid");
      calls(g, 0, 0);
      await expect(
        validateCurrentCertifiedForkReviewOutput(
          { ...publishInput(), githubInstallationId },
          { gateway: g },
        ),
      ).rejects.toThrow("certified_fork_review_installation_invalid");
      calls(g, 0, 0);
    },
  );

  it("rejects invalid identities and all malformed binding fields locally", async () => {
    const g = gateway();
    const callback = vi.fn((): never => {
      throw new Error("coercion");
    });
    for (const githubInstallationId of [
      undefined,
      null,
      "",
      " ",
      " 123",
      "123\n",
      "0",
      "01",
      "-1",
      "1.2",
      "1e3",
      123,
      1n,
      Symbol("id"),
      { toString: callback, [Symbol.toPrimitive]: callback },
      new Proxy({}, { get: callback }),
    ]) {
      await expect(
        prepareCurrentCertifiedForkReview(
          { ...prepareInput(), githubInstallationId },
          { gateway: g },
        ),
      ).rejects.toThrow("certified_fork_review_installation_invalid");
      await expect(
        validateCurrentCertifiedForkReviewOutput(
          { ...publishInput(), githubInstallationId },
          { gateway: g },
        ),
      ).rejects.toThrow("certified_fork_review_installation_invalid");
    }
    for (const key of Object.keys(binding())) {
      for (const value of [undefined, null, {}, "invalid"]) {
        const badBinding = { ...binding(), [key]: value };
        await expect(
          prepareCurrentCertifiedForkReview(
            { ...prepareInput(), binding: badBinding },
            { gateway: g },
          ),
        ).rejects.toThrow("certified_fork_review_binding_invalid");
        await expect(
          validateCurrentCertifiedForkReviewOutput(
            { ...publishInput(), binding: badBinding },
            { gateway: g },
          ),
        ).rejects.toThrow("certified_fork_review_binding_invalid");
      }
    }
    expect(callback).not.toHaveBeenCalled();
    calls(g, 0, 0);
  });

  it("rejects hostile envelopes and nested values without callbacks or calls", async () => {
    const g = gateway();
    const callback = vi.fn((): never => {
      throw new Error("callback");
    });
    for (const [run, input] of [
      [prepareCurrentCertifiedForkReview, prepareInput()],
      [validateCurrentCertifiedForkReviewOutput, publishInput()],
    ] as const) {
      const invalid: unknown[] = [
        null,
        [],
        new Date(),
        { ...input, extra: true },
        { ...input, files: [file()] },
        { ...input, [Symbol("extra")]: true },
        ...hostile(input, callback),
      ];
      for (const key of Object.keys(input)) {
        const missing: Record<string, unknown> = { ...input };
        delete missing[key];
        invalid.push(missing);
      }
      for (const bad of hostile(binding(), callback))
        invalid.push({ ...input, binding: bad });
      for (const bad of invalid)
        await expect(run(bad, { gateway: g })).rejects.toThrow();
    }
    for (const prepared of hostile(prepare(), callback))
      await expect(
        validateCurrentCertifiedForkReviewOutput(
          { ...publishInput(), prepared },
          { gateway: g },
        ),
      ).rejects.toThrow();
    const badOutputs = [
      ...hostile(output(), callback),
      ...hostile(output().findings, callback).map((findings) => ({
        ...output(),
        findings,
      })),
      ...hostile(output().findings[0]!, callback).map((finding) => ({
        ...output(),
        findings: [finding],
      })),
    ];
    for (const modelOutput of badOutputs)
      await expect(
        validateCurrentCertifiedForkReviewOutput(
          { ...publishInput(), modelOutput },
          { gateway: g },
        ),
      ).rejects.toThrow();
    expect(callback).not.toHaveBeenCalled();
    calls(g, 0, 0);
  });

  it("validates output strictly before consulting the gateway", async () => {
    const g = gateway();
    const finding = output().findings[0]!;
    const badOutputs = [
      { ...output(), extra: true },
      { ...output(), protocolVersion: "1" },
      { ...output(), summaryMarkdown: "🙂".repeat(15001) },
      { ...output(), findings: Array.from({ length: 51 }, () => finding) },
      ...[
        { path: "unknown.ts" },
        { path: "../bad" },
        { title: "🙂".repeat(51) },
        { body: "🙂".repeat(2001) },
        { severity: "urgent" },
        { startLine: "2" },
        { endLine: 1 },
        { extra: true },
      ].map((change) => ({
        ...output(),
        findings: [{ ...finding, ...change }],
      })),
    ];
    for (const modelOutput of badOutputs)
      await expect(
        validateCurrentCertifiedForkReviewOutput(
          { ...publishInput(), modelOutput },
          { gateway: g },
        ),
      ).rejects.toThrow();
    calls(g, 0, 0);
  });

  it("independently rejects malformed gateway envelopes, packets and content", async () => {
    const callback = vi.fn((): never => {
      throw new Error("callback");
    });
    const packet = prepare();
    const badPackets = [
      null,
      { ...packet, extra: true },
      { ...packet, protocolVersion: 2 },
      { ...packet, binding: { ...binding(), trustDomain: "internal" } },
      { ...packet, contextHash: "0".repeat(64) },
      { ...packet, files: [{ ...file(), patch: "changed" }] },
      { ...packet, files: [{ ...file(), patch: "🙂".repeat(50001) }] },
      { ...packet, files: [{ ...file(), path: "../bad" }] },
      { ...packet, files: [file(), file()] },
      { ...packet, files: Array.from({ length: 501 }, file) },
      {
        ...packet,
        files: [
          { ...file(), patch: "x".repeat(160000) },
          { ...file(), path: "other.ts", patch: "x".repeat(160000) },
        ],
      },
      ...hostile(packet, callback),
      ...hostile(binding(), callback).map((binding) => ({
        ...packet,
        binding,
      })),
      ...hostile(packet.files, callback).map((files) => ({ ...packet, files })),
      ...hostile(file(), callback).map((entry) => ({
        ...packet,
        files: [entry],
      })),
    ];
    for (const bad of badPackets) {
      const g = gateway();
      // Deliberately violate the typed port to verify the runtime boundary.
      g.prepareContext.mockResolvedValue({
        contextHash: packet.contextHash,
        promptPacket: bad,
      } as never);
      g.assertContextCurrent.mockResolvedValue({ promptPacket: bad } as never);
      await expect(
        prepareCurrentCertifiedForkReview(prepareInput(), { gateway: g }),
      ).rejects.toThrow();
      await expect(
        validateCurrentCertifiedForkReviewOutput(publishInput(), {
          gateway: g,
        }),
      ).rejects.toThrow();
      calls(g, 1, 1);
      const local = gateway();
      await expect(
        validateCurrentCertifiedForkReviewOutput(
          { ...publishInput(), prepared: bad },
          { gateway: local },
        ),
      ).rejects.toThrow();
      calls(local, 0, 0);
    }
    for (const mode of ["prepare", "validate"] as const) {
      const valid =
        mode === "prepare"
          ? { promptPacket: packet, contextHash: packet.contextHash }
          : { promptPacket: packet };
      for (const bad of [
        null,
        {},
        { ...valid, extra: true },
        ...hostile(valid, callback),
      ]) {
        const g = gateway();
        g.prepareContext.mockResolvedValue(bad as never);
        g.assertContextCurrent.mockResolvedValue(bad as never);
        await expect(
          mode === "prepare"
            ? prepareCurrentCertifiedForkReview(prepareInput(), { gateway: g })
            : validateCurrentCertifiedForkReviewOutput(publishInput(), {
                gateway: g,
              }),
        ).rejects.toThrow();
        calls(g, mode === "prepare" ? 1 : 0, mode === "validate" ? 1 : 0);
      }
    }
    expect(callback).not.toHaveBeenCalled();
  });

  it("rejects inconsistent returned hashes and canonically valid changed context", async () => {
    const g = gateway();
    for (const contextHash of [
      "0".repeat(64),
      undefined,
      123,
      { toString: () => prepare().contextHash },
    ]) {
      g.prepareContext.mockResolvedValue({
        contextHash,
        promptPacket: prepare(),
      } as never);
      await expect(
        prepareCurrentCertifiedForkReview(prepareInput(), { gateway: g }),
      ).rejects.toThrow("certified_fork_review_context_hash_mismatch");
    }
    const changed = prepareCertifiedForkReview({
      binding: binding(),
      files: [{ ...file(), patch: "changed" }],
    });
    g.assertContextCurrent.mockResolvedValue({ promptPacket: changed });
    await expect(
      validateCurrentCertifiedForkReviewOutput(publishInput(), { gateway: g }),
    ).rejects.toThrow("certified_fork_review_context_hash_mismatch");
    calls(g, 4, 1);
  });

  it("snapshots all local data before pending promises and detaches gateway packets", async () => {
    const g = gateway();
    const pendingPrepare =
      deferred<
        Awaited<ReturnType<CertifiedForkReviewGatewayPort["prepareContext"]>>
      >();
    g.prepareContext.mockReturnValue(pendingPrepare.promise);
    const input = prepareInput();
    const preparing = prepareCurrentCertifiedForkReview(input, { gateway: g });
    const request = g.prepareContext.mock.calls[0]![0];
    expect(request.binding).not.toBe(input.binding);
    frozen(request);
    input.githubInstallationId = "999";
    input.binding.reviewHeadSha = "c".repeat(40);
    expect(request).toEqual(prepareInput());
    const source = { ...prepare(), binding: binding(), files: [file()] };
    pendingPrepare.resolve({
      contextHash: source.contextHash,
      promptPacket: source,
    });
    const prepared = await preparing;
    source.files[0]!.patch = "changed after return";
    expect(prepared).toEqual(prepare());

    const pendingValidate =
      deferred<
        Awaited<
          ReturnType<CertifiedForkReviewGatewayPort["assertContextCurrent"]>
        >
      >();
    g.assertContextCurrent.mockReturnValue(pendingValidate.promise);
    const publish = {
      ...publishInput(),
      prepared: { ...prepare(), binding: binding(), files: [file()] },
    };
    const expected = publishCertifiedForkReview(
      inputWithoutInstallation(publish),
    );
    let settled = false;
    const validating = validateCurrentCertifiedForkReviewOutput(publish, {
      gateway: g,
    }).then((result) => {
      settled = true;
      return result;
    });
    const assertion = g.assertContextCurrent.mock.calls[0]![0];
    frozen(assertion);
    expect(assertion.binding).not.toBe(publish.binding);
    publish.githubInstallationId = "999";
    publish.binding.baseSha = "c".repeat(40);
    publish.prepared.binding.reviewHeadSha = "d".repeat(40);
    publish.prepared.files[0]!.patch = "changed";
    publish.prepared.contextHash = "0".repeat(64);
    publish.modelOutput.summaryMarkdown = "changed";
    publish.modelOutput.findings[0]!.title = "changed";
    publish.modelOutput.findings.push({ ...publish.modelOutput.findings[0]! });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(assertion).toEqual({
      ...prepareInput(),
      expectedContextHash: prepare().contextHash,
    });
    pendingValidate.resolve({ promptPacket: prepare() });
    expect(await validating).toEqual(expected);
    calls(g, 1, 1);
  });

  it.each(["gateway rejected", "gateway timeout"])(
    "propagates %s with no retry or fallback",
    async (message) => {
      const g = gateway();
      const error = new Error(message);
      g.prepareContext.mockRejectedValue(error);
      const pending =
        deferred<
          Awaited<
            ReturnType<CertifiedForkReviewGatewayPort["assertContextCurrent"]>
          >
        >();
      g.assertContextCurrent.mockReturnValue(pending.promise);
      await expect(
        prepareCurrentCertifiedForkReview(prepareInput(), { gateway: g }),
      ).rejects.toBe(error);
      const result = validateCurrentCertifiedForkReviewOutput(publishInput(), {
        gateway: g,
      });
      pending.reject(error);
      await expect(result).rejects.toBe(error);
      calls(g, 1, 1);
    },
  );
});

function inputWithoutInstallation<T extends { githubInstallationId: string }>(
  input: T,
) {
  const { githubInstallationId: _installation, ...local } = input;
  void _installation;
  return local;
}
