import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Codex rotating Action bundle reproducibility", () => {
  it("is byte-identical across clean hoisted and linked-store checkouts without path leakage", () => {
    const sourceRoot = process.cwd();
    const tempRoot = mkdtempSync(
      join(tmpdir(), "reviewrouter-action-reproducibility-"),
    );
    try {
      const checkouts = [
        {
          root: join(tempRoot, "ordinary-clean-checkout"),
          nodeLinker: "hoisted",
        },
        {
          root: join(tempRoot, "differently-named-linked-store-checkout"),
          nodeLinker: "isolated",
        },
      ];

      for (const checkout of checkouts) {
        copyBuildInputs(sourceRoot, checkout.root);
        execFileSync(
          "pnpm",
          [
            "install",
            "--frozen-lockfile",
            "--offline",
            "--ignore-scripts",
            `--node-linker=${checkout.nodeLinker}`,
          ],
          { cwd: checkout.root, stdio: "pipe" },
        );
        copyInstalledSubscriptionRuntime(sourceRoot, checkout.root);
        execFileSync(
          process.execPath,
          ["scripts/build-codex-rotating-action.mjs"],
          { cwd: checkout.root, stdio: "pipe" },
        );
      }

      const bundles = checkouts.map(({ root }) =>
        readFileSync(join(root, "action-dist/index.cjs")),
      );
      const hashes = bundles.map((bundle) =>
        createHash("sha256").update(bundle).digest("hex"),
      );
      expect(hashes[1]).toBe(hashes[0]);

      const bundleText = bundles[0].toString("utf8");
      for (const forbidden of [
        "/var/data",
        "/tmp",
        "node_modules/.pnpm",
        sourceRoot,
        tempRoot,
        ...checkouts.map(({ root }) => root),
      ]) {
        expect(bundleText).not.toContain(forbidden);
      }
      expect(bundleText).toContain("ReviewRouter Action third-party notices");
      expect(bundleText).not.toMatch(/^\/\/ .*node_modules\//mu);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 180_000);
});

function copyBuildInputs(sourceRoot: string, checkoutRoot: string) {
  const trackedFiles = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--",
      "packages/features/codex-oauth-rotating",
      "packages/shared",
    ],
    { cwd: sourceRoot },
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const files = [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.base.json",
    "scripts/build-codex-rotating-action.mjs",
    "scripts/codex-rotating-action-third-party-licenses.txt",
    "scripts/lib/codex-rotating-action-build.mjs",
    ...trackedFiles,
  ];
  for (const file of files) {
    const target = join(checkoutRoot, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(sourceRoot, file), target);
  }
}

function copyInstalledSubscriptionRuntime(
  sourceRoot: string,
  checkoutRoot: string,
) {
  const source = join(
    sourceRoot,
    "node_modules/@777genius/subscription-runtime",
  );
  const target = join(
    checkoutRoot,
    "node_modules/@777genius/subscription-runtime",
  );
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { dereference: true, recursive: true });
}
