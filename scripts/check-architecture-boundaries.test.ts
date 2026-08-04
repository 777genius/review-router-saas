import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const checker = resolve("scripts/check-architecture-boundaries.mjs");
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("review-investigations architecture ratchet", () => {
  it("accepts a strict package with domain-only dependencies", () => {
    const root = createFixture(
      'export enum InvestigationState { Open = "open" }\n',
    );

    expect(runChecker(root)).toContain("Architecture boundary check passed");
  });

  it("rejects domain imports from another feature context", () => {
    const root = createFixture(
      'import type { Foreign } from "@reviewrouter/features-review-evidence";\nexport type Local = Foreign;\n',
    );

    expect(() => runChecker(root)).toThrow(
      /strict review contexts communicate through consuming ports/,
    );
  });

  it("rejects domain imports from infrastructure", () => {
    const root = createFixture(
      'import type { Adapter } from "../infrastructure/adapter";\nexport type Local = Adapter;\n',
    );
    writeFile(
      root,
      "packages/features/review-investigations/src/infrastructure/adapter.ts",
      "export type Adapter = { readonly value: string };\n",
    );

    expect(() => runChecker(root)).toThrow(
      /strict domain code may depend only on its own domain/,
    );
  });
});

function createFixture(domainSource: string): string {
  const root = mkdtempSync(join(tmpdir(), "reviewrouter-architecture-"));
  fixtureRoots.push(root);
  writeFile(
    root,
    "packages/features/review-investigations/package.json",
    JSON.stringify({
      exports: {
        ".": {},
        "./composition": {},
        "./contract-source": {},
        "./testing": {},
      },
    }),
  );
  writeFile(
    root,
    "packages/features/review-investigations/src/index.ts",
    'export * from "./domain/review-investigation";\n',
  );
  writeFile(
    root,
    "packages/features/review-investigations/src/domain/review-investigation.ts",
    domainSource,
  );
  return root;
}

function writeFile(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, content);
}

function runChecker(root: string): string {
  return execFileSync(process.execPath, [checker], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      REVIEWROUTER_ARCHITECTURE_ROOT: root,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
