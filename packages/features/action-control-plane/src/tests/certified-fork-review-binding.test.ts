import { describe, expect, it } from "vitest";

import {
  assertCertifiedForkReviewBindingMatches,
  certifiedForkReviewBindingHash,
  certifiedForkReviewLeaseBindingKey,
  certifiedForkReviewWorkflowSchemaVersion,
  parseCertifiedForkReviewBinding,
  serializeCertifiedForkReviewBinding,
} from "../application/use-cases/certified-fork-review-binding.js";

const invalidBindingCode = "certified_fork_review_binding_invalid";
const bindingMismatchCode = "certified_fork_review_binding_mismatch";
const invalidLeaseBindingCode = "certified_fork_lease_binding_invalid";

function validInput() {
  return {
    sourceRepository: "octo-head/widget",
    sourceRepositoryId: "101",
    baseRepository: "octo-base/widget",
    baseRepositoryId: "202",
    pullRequestNumber: 42,
    reviewHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    baseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    trustDomain: "fork" as const,
  };
}

function withField(fieldName: string, value: unknown): unknown {
  return {
    ...validInput(),
    [fieldName]: value,
  };
}

function expectInvalid(input: unknown): void {
  expect(() => parseCertifiedForkReviewBinding(input)).toThrowError(
    invalidBindingCode,
  );
}

function proxyWithThrowingTraps() {
  const calls = {
    getPrototypeOf: 0,
    ownKeys: 0,
    getOwnPropertyDescriptor: 0,
    get: 0,
  };

  function fail(trap: keyof typeof calls): never {
    calls[trap] += 1;
    throw new Error(`attacker_${trap}`);
  }

  const proxy = new Proxy(validInput(), {
    getPrototypeOf() {
      return fail("getPrototypeOf");
    },
    ownKeys() {
      return fail("ownKeys");
    },
    getOwnPropertyDescriptor() {
      return fail("getOwnPropertyDescriptor");
    },
    get() {
      return fail("get");
    },
  });

  return { calls, proxy };
}

const bindingConsumers = [
  [
    "serialize",
    (binding: unknown) => serializeCertifiedForkReviewBinding(binding),
  ],
  ["hash", (binding: unknown) => certifiedForkReviewBindingHash(binding)],
  [
    "compare",
    (binding: unknown) =>
      assertCertifiedForkReviewBindingMatches(validInput(), binding),
  ],
] as const;

describe("certified fork review binding", () => {
  it("parses an exact binding without retaining the caller object", () => {
    const input = validInput();
    const binding = parseCertifiedForkReviewBinding(input);

    expect(binding).toEqual(input);
    expect(binding).not.toBe(input);
    expect(Object.isFrozen(binding)).toBe(true);

    input.sourceRepository = "changed/repository";
    expect(binding.sourceRepository).toBe("octo-head/widget");
  });

  it("accepts a plain object with a null prototype", () => {
    const input = Object.assign(
      Object.create(null) as Record<string, unknown>,
      validInput(),
    );

    expect(parseCertifiedForkReviewBinding(input)).toEqual(validInput());
  });

  it("uses workflow schema 6, not the incompatible schema 5", () => {
    expect(certifiedForkReviewWorkflowSchemaVersion).toBe(6);
    expect(certifiedForkReviewWorkflowSchemaVersion).not.toBe(5);
  });

  it("serializes in one exact order and hashes the canonical UTF-8 bytes", () => {
    const expectedSerialization =
      '{"sourceRepository":"octo-head/widget","sourceRepositoryId":"101","baseRepository":"octo-base/widget","baseRepositoryId":"202","pullRequestNumber":42,"reviewHeadSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","baseSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","trustDomain":"fork"}';
    const expectedDigest =
      "49cecf5e056cf51ba08010ff6b1ef299c0e44fa97e80fd3de1018408f937ddc7";
    const reversedInput = Object.fromEntries(
      Object.entries(validInput()).reverse(),
    );
    const binding = parseCertifiedForkReviewBinding(reversedInput);

    expect(serializeCertifiedForkReviewBinding(binding)).toBe(
      expectedSerialization,
    );
    expect(certifiedForkReviewBindingHash(binding)).toBe(expectedDigest);
  });

  it.each([
    ["sourceRepository", "renamed-head/widget"],
    ["sourceRepositoryId", "303"],
    ["baseRepository", "renamed-base/widget"],
    ["baseRepositoryId", "404"],
    ["pullRequestNumber", 43],
    ["reviewHeadSha", "cccccccccccccccccccccccccccccccccccccccc"],
    ["baseSha", "dddddddddddddddddddddddddddddddddddddddd"],
  ] as const)("rejects a mismatch in %s", (fieldName, replacement) => {
    const expected = parseCertifiedForkReviewBinding(validInput());
    const actual = {
      ...expected,
      [fieldName]: replacement,
    };

    expect(() =>
      assertCertifiedForkReviewBindingMatches(expected, actual),
    ).toThrowError(bindingMismatchCode);
  });

  it("rejects an invalid trust-domain comparison as an invalid binding", () => {
    const expected = parseCertifiedForkReviewBinding(validInput());
    const actual = {
      ...expected,
      trustDomain: "not-fork",
    };

    expect(() =>
      assertCertifiedForkReviewBindingMatches(expected, actual),
    ).toThrowError(invalidBindingCode);
  });

  it("accepts an exact binding comparison", () => {
    const expected = parseCertifiedForkReviewBinding(validInput());
    const actual = parseCertifiedForkReviewBinding({
      ...validInput(),
    });

    expect(() =>
      assertCertifiedForkReviewBindingMatches(expected, actual),
    ).not.toThrow();
  });

  it.each([
    "sourceRepository",
    "sourceRepositoryId",
    "baseRepository",
    "baseRepositoryId",
    "pullRequestNumber",
    "reviewHeadSha",
    "baseSha",
    "trustDomain",
  ])("rejects a missing %s field", (missingField) => {
    const input = Object.fromEntries(
      Object.entries(validInput()).filter(([key]) => key !== missingField),
    );

    expectInvalid(input);
  });

  it("rejects an extra field", () => {
    expectInvalid({
      ...validInput(),
      extra: true,
    });
  });

  it.each([
    ["empty source repository", "sourceRepository", ""],
    ["owner-only repository", "sourceRepository", "owner"],
    ["empty repository owner", "sourceRepository", "/repository"],
    ["empty repository name", "sourceRepository", "owner/"],
    ["multiple repository slashes", "sourceRepository", "owner/sub/repository"],
    ["repository whitespace", "sourceRepository", "owner/repo name"],
    ["repository control character", "sourceRepository", "owner/repo\n"],
    ["repository surrounding whitespace", "sourceRepository", " owner/repo"],
    ["zero repository ID", "sourceRepositoryId", "0"],
    ["leading-zero repository ID", "sourceRepositoryId", "0101"],
    ["signed repository ID", "sourceRepositoryId", "+101"],
    ["negative repository ID", "sourceRepositoryId", "-101"],
    ["decimal repository ID", "sourceRepositoryId", "101.0"],
    ["repository ID whitespace", "sourceRepositoryId", " 101"],
    ["numeric repository ID", "sourceRepositoryId", 101],
    ["zero PR number", "pullRequestNumber", 0],
    ["negative PR number", "pullRequestNumber", -1],
    ["fractional PR number", "pullRequestNumber", 1.5],
    ["unsafe PR number", "pullRequestNumber", Number.MAX_SAFE_INTEGER + 1],
    ["string PR number", "pullRequestNumber", "42"],
    ["short head SHA", "reviewHeadSha", "a".repeat(39)],
    ["uppercase head SHA", "reviewHeadSha", "A".repeat(40)],
    ["head SHA whitespace", "reviewHeadSha", `${"a".repeat(40)} `],
    ["non-hex base SHA", "baseSha", "g".repeat(40)],
    ["uppercase trust domain", "trustDomain", "Fork"],
    ["padded trust domain", "trustDomain", " fork"],
  ] as const)("rejects %s", (_label, fieldName, value) => {
    expectInvalid(withField(fieldName, value));
  });

  it("preserves repository case without normalization", () => {
    const binding = parseCertifiedForkReviewBinding(
      withField("sourceRepository", "Owner/Repository"),
    );

    expect(binding.sourceRepository).toBe("Owner/Repository");
  });

  it.each([
    ["null", null],
    ["array", []],
    ["date", new Date(0)],
    ["boxed primitive", new String("owner/repository")],
    [
      "custom prototype",
      Object.assign(Object.create({ inherited: true }) as object, validInput()),
    ],
  ] as const)("rejects %s input", (_label, input) => {
    expectInvalid(input);
  });

  it("rejects a non-enumerable declared field", () => {
    const input = validInput();
    Object.defineProperty(input, "sourceRepository", {
      configurable: true,
      enumerable: false,
      value: input.sourceRepository,
      writable: true,
    });

    expectInvalid(input);
  });

  it("rejects an accessor without invoking its getter", () => {
    let getterCalls = 0;
    const input = validInput();
    Object.defineProperty(input, "sourceRepository", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return "attacker/repository";
      },
    });

    expectInvalid(input);
    expect(getterCalls).toBe(0);
  });

  it("rejects a Proxy without invoking any of its traps", () => {
    const { calls, proxy } = proxyWithThrowingTraps();

    expectInvalid(proxy);
    expect(calls).toEqual({
      getPrototypeOf: 0,
      ownKeys: 0,
      getOwnPropertyDescriptor: 0,
      get: 0,
    });
  });

  it("rejects a revoked Proxy with the stable invalid-binding code", () => {
    const revocable = Proxy.revocable(validInput(), {});
    revocable.revoke();

    expectInvalid(revocable.proxy);
  });

  it.each(bindingConsumers)(
    "%s rejects forged NaN and extra-field bindings",
    (_label, consume) => {
      expect(() =>
        consume(withField("pullRequestNumber", Number.NaN)),
      ).toThrowError(invalidBindingCode);
      expect(() =>
        consume({
          ...validInput(),
          extra: true,
        }),
      ).toThrowError(invalidBindingCode);
    },
  );

  it.each(bindingConsumers)(
    "%s rejects an accessor binding without invoking its getter",
    (_label, consume) => {
      let getterCalls = 0;
      const binding = validInput();
      Object.defineProperty(binding, "sourceRepository", {
        configurable: true,
        enumerable: true,
        get() {
          getterCalls += 1;
          throw new Error("attacker_getter");
        },
      });

      expect(() => consume(binding)).toThrowError(invalidBindingCode);
      expect(getterCalls).toBe(0);
    },
  );

  it.each(bindingConsumers)(
    "%s rejects a Proxy binding without invoking its traps",
    (_label, consume) => {
      const { calls, proxy } = proxyWithThrowingTraps();

      expect(() => consume(proxy)).toThrowError(invalidBindingCode);
      expect(calls).toEqual({
        getPrototypeOf: 0,
        ownKeys: 0,
        getOwnPropertyDescriptor: 0,
        get: 0,
      });
    },
  );

  it("rejects a symbol key", () => {
    expectInvalid({
      ...validInput(),
      [Symbol("extra")]: true,
    });
  });

  it("rejects identical source and base repository IDs", () => {
    expectInvalid(withField("sourceRepositoryId", "202"));
  });

  it("rejects identical source and base repository full names", () => {
    expectInvalid(withField("sourceRepository", "octo-base/widget"));
  });

  it("uses exact repository-name comparison semantics", () => {
    const binding = parseCertifiedForkReviewBinding(
      withField("sourceRepository", "Octo-Base/Widget"),
    );

    expect(binding.sourceRepository).toBe("Octo-Base/Widget");
    expect(binding.baseRepository).toBe("octo-base/widget");
  });

  it("creates a checkpoint-compatible lease binding key", () => {
    const hash = "a".repeat(64);

    expect(certifiedForkReviewLeaseBindingKey(hash)).toBe(`fork:${hash}`);
  });

  it.each([
    "",
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(64),
    "g".repeat(64),
    ` ${"a".repeat(64)}`,
    `fork:${"a".repeat(64)}`,
    123,
    null,
  ])("rejects invalid lease binding hash %#", (hash) => {
    expect(() => certifiedForkReviewLeaseBindingKey(hash)).toThrowError(
      invalidLeaseBindingCode,
    );
  });
});
