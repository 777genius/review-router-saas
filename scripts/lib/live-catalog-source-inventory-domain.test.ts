import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createLiveCatalogSourceInventory,
  createLiveCatalogSourceFetchBudget,
  deriveLiveCatalogSourceClosure,
  gitBlobSha,
  LIVE_CATALOG_SELECTOR_ROOTS,
  LIVE_CATALOG_SOURCE_FETCH_LIMITS,
  LIVE_CATALOG_SOURCE_INVENTORY_LIMITS,
  liveCatalogSourceInventoryFacts,
  parseLiveCatalogSourceInventory,
  reconstructLiveCatalogTree,
} from "./live-catalog-source-inventory-domain.mjs";

function treeResponse(files: Map<string, Buffer>) {
  const directories = new Set<string>();
  for (const path of files.keys()) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1)
      directories.add(parts.slice(0, index).join("/"));
  }
  const shas = new Map<string, string>();
  const depth = (value: string) => (value ? value.split("/").length : 0);
  for (const directory of ["", ...directories].sort(
    (a, b) => depth(b) - depth(a),
  )) {
    const children: Array<{
      mode: string;
      name: string;
      sha: string;
      tree: boolean;
    }> = [];
    for (const [path, bytes] of files)
      if (
        (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "") ===
        directory
      )
        children.push({
          mode: "100644",
          name: path.split("/").at(-1)!,
          sha: gitBlobSha(bytes),
          tree: false,
        });
    for (const child of directories)
      if (
        (child.includes("/") ? child.slice(0, child.lastIndexOf("/")) : "") ===
        directory
      )
        children.push({
          mode: "40000",
          name: child.split("/").at(-1)!,
          sha: shas.get(child)!,
          tree: true,
        });
    children.sort((a, b) =>
      Buffer.compare(
        Buffer.from(`${a.name}${a.tree ? "/" : ""}`),
        Buffer.from(`${b.name}${b.tree ? "/" : ""}`),
      ),
    );
    const body = Buffer.concat(
      children.flatMap((child) => [
        Buffer.from(`${child.mode} ${child.name}\0`),
        Buffer.from(child.sha, "hex"),
      ]),
    );
    shas.set(
      directory,
      createHash("sha1")
        .update(`tree ${body.length}\0`)
        .update(body)
        .digest("hex"),
    );
  }
  return {
    sha: shas.get("")!,
    url: "https://api.github.test/tree",
    truncated: false,
    tree: [
      ...[...directories].map((path) => ({
        path,
        mode: "040000",
        type: "tree",
        sha: shas.get(path)!,
      })),
      ...[...files].map(([path, bytes]) => ({
        path,
        mode: "100644",
        type: "blob",
        sha: gitBlobSha(bytes),
        size: bytes.length,
      })),
    ],
  };
}

function selectedFiles() {
  const empty = Buffer.from("export {};\n");
  const files = new Map(
    LIVE_CATALOG_SELECTOR_ROOTS.map((path) => [path, empty]),
  );
  files.set(
    "package.json",
    Buffer.from(
      JSON.stringify({
        name: "review-router",
        scripts: {
          postinstall: "pnpm db:generate",
          "db:generate":
            "node scripts/run-with-env.mjs pnpm --filter @reviewrouter/platform-db db:generate",
        },
      }),
    ),
  );
  files.set(
    "packages/platform/db/package.json",
    Buffer.from(
      JSON.stringify({
        name: "@reviewrouter/platform-db",
        scripts: { "db:generate": "prisma generate --config prisma.config.ts" },
      }),
    ),
  );
  files.set("pnpm-lock.yaml", Buffer.from("lockfileVersion: '9.0'\n"));
  files.set("pnpm-workspace.yaml", Buffer.from("packages: []\n"));
  files.set(
    "tsconfig.json",
    Buffer.from('{"extends":"./tsconfig.base.json"}\n'),
  );
  files.set("tsconfig.base.json", Buffer.from('{"compilerOptions":{}}\n'));
  files.set(
    "packages/platform/db/prisma/migrations/current/migration.sql",
    Buffer.from("SELECT 1;\n"),
  );
  files.set(
    "packages/platform/release-authority-db/migrations/current/migration.sql",
    Buffer.from("SELECT 2;\n"),
  );
  files.set(
    "packages/platform/release-authority-db/legacy-catalog/legacy/migration.sql",
    Buffer.from("SELECT 3;\n"),
  );
  return files;
}

function inventory(files: Map<string, Buffer>) {
  const response = treeResponse(files);
  return createLiveCatalogSourceInventory(response, response.sha);
}

describe("live catalog source inventory and installed selector", () => {
  it("reserves aggregate bytes before fetch and releases a failed lease", () => {
    const budget = createLiveCatalogSourceFetchBudget();
    const lease = budget.reserve([4 * 1024 * 1024, 4 * 1024 * 1024]);
    expect(budget.facts()).toEqual({
      retainedBytes: 0,
      inFlightBytes: 8 * 1024 * 1024,
      requestedFiles: 2,
    });
    expect(() =>
      budget.reserve(Array.from({ length: 5 }, () => 4 * 1024 * 1024)),
    ).toThrow("closure_limit_exceeded");
    lease.release();
    expect(budget.facts()).toEqual({
      retainedBytes: 0,
      inFlightBytes: 0,
      requestedFiles: 0,
    });
  });
  it("derives the closure from the current checked-in repository sources", () => {
    const paths = execFileSync("git", ["ls-files", "-z"])
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    const files = new Map(paths.map((path) => [path, readFileSync(path)]));
    const closure = deriveLiveCatalogSourceClosure(inventory(files), files);
    expect(closure.entries.length).toBeGreaterThan(
      LIVE_CATALOG_SELECTOR_ROOTS.length,
    );
  });
  it("canonicalizes, reconstructs, selects both migration generations, and is deterministic across cycles", () => {
    const files = selectedFiles();
    files.set(
      "scripts/attest-live-catalog-digest.mjs",
      Buffer.from('import "./cycle-a.mjs";\n'),
    );
    files.set("scripts/cycle-a.mjs", Buffer.from('import "./cycle-b.mjs";\n'));
    files.set("scripts/cycle-b.mjs", Buffer.from('import "./cycle-a.mjs";\n'));
    const value = inventory(files);
    expect(reconstructLiveCatalogTree(value)).toBe(value.treeSha);
    expect(
      parseLiveCatalogSourceInventory(JSON.parse(JSON.stringify(value))),
    ).toEqual(value);
    const closure = deriveLiveCatalogSourceClosure(value, files);
    expect(closure.entries.map((entry) => entry.path)).toEqual(
      [...closure.entries.map((entry) => entry.path)].sort((a, b) =>
        Buffer.compare(Buffer.from(a), Buffer.from(b)),
      ),
    );
    expect(
      closure.entries.filter((entry) => entry.path.endsWith("migration.sql")),
    ).toHaveLength(3);
    expect(liveCatalogSourceInventoryFacts(value).treeSha).toBe(value.treeSha);
  });

  it("fails closed for missing roots/imports, tracked sensitive config, and lifecycle hooks", () => {
    const missingRoot = selectedFiles();
    missingRoot.delete("pnpm-lock.yaml");
    expect(() =>
      deriveLiveCatalogSourceClosure(inventory(missingRoot), missingRoot),
    ).toThrow("root_missing");

    for (const prefix of [
      "packages/platform/db/prisma/migrations/",
      "packages/platform/release-authority-db/migrations/",
      "packages/platform/release-authority-db/legacy-catalog/",
    ]) {
      const missingMigration = selectedFiles();
      for (const path of missingMigration.keys())
        if (path.startsWith(prefix)) missingMigration.delete(path);
      expect(() =>
        deriveLiveCatalogSourceClosure(
          inventory(missingMigration),
          missingMigration,
        ),
      ).toThrow("migration_root_missing");
    }

    const missingImport = selectedFiles();
    missingImport.set(
      "scripts/attest-live-catalog-digest.mjs",
      Buffer.from('import "./missing.mjs";\n'),
    );
    expect(() =>
      deriveLiveCatalogSourceClosure(inventory(missingImport), missingImport),
    ).toThrow("unresolved_import");

    const environmentRead = selectedFiles();
    environmentRead.set(
      "scripts/attest-live-catalog-digest.mjs",
      Buffer.from("require(process.env.REVIEWROUTER_SOURCE);\n"),
    );
    expect(() =>
      deriveLiveCatalogSourceClosure(
        inventory(environmentRead),
        environmentRead,
      ),
    ).toThrow("dynamic_resolution");

    const dotenv = selectedFiles();
    dotenv.set(".env.local", Buffer.from("SECRET=x\n"));
    expect(() =>
      deriveLiveCatalogSourceClosure(inventory(dotenv), dotenv),
    ).toThrow("sensitive_config_denied");

    const hook = selectedFiles();
    const manifest = JSON.parse(
      hook.get("packages/platform/db/package.json")!.toString(),
    );
    manifest.scripts.prepare = "node decoy.mjs";
    hook.set(
      "packages/platform/db/package.json",
      Buffer.from(JSON.stringify(manifest)),
    );
    expect(() => deriveLiveCatalogSourceClosure(inventory(hook), hook)).toThrow(
      "lifecycle_hook_denied",
    );

    const operator = selectedFiles();
    const rootManifest = JSON.parse(operator.get("package.json")!.toString());
    rootManifest.scripts.postinstall = "pnpm db:generate && node decoy.mjs";
    operator.set("package.json", Buffer.from(JSON.stringify(rootManifest)));
    expect(() =>
      deriveLiveCatalogSourceClosure(inventory(operator), operator),
    ).toThrow(/(?:lifecycle_hook|script_operator)/u);
  });

  it("derives every supported static executable-resolution form, including named, computed, aliased, destructured, JSX, MTS, CTS, and CJS loaders", () => {
    const files = selectedFiles();
    files.set(
      "scripts/attest-live-catalog-digest.mjs",
      Buffer.from(`
        import { createRequire as makeRequire } from "node:module";
        import { register as namedRegister } from "node:module";
        import Module from "node:module";
        import * as moduleApi from "node:module";
        import equal = require("./selector-dependency.mjs");
        const req = require;
        const reqResolve = require.resolve;
        const computedResolve = require["resolve"];
        const reqResolveAgain = reqResolve;
        const makeRequireAgain = makeRequire;
        const moduleAlias = moduleApi;
        const { createRequire: destructuredRequire, register: destructuredRegister } = moduleAlias;
        const local = makeRequire(import.meta.url);
        const namespacedLocal = moduleAlias["createRequire"](import.meta["url"]);
        const destructuredLocal = destructuredRequire(import.meta["url"]);
        const defaultLocal = Module["createRequire"](import.meta["url"]);
        const directRegister = require("module")["register"];
        req("./selector-dependency.mjs");
        reqResolve("./selector-dependency.mjs");
        computedResolve("./selector-dependency.mjs");
        reqResolveAgain("./selector-dependency.mjs");
        makeRequireAgain(import.meta.url)("./selector-dependency.mjs");
        local.resolve("./selector-dependency.mjs");
        namespacedLocal("./selector-dependency.mjs");
        destructuredLocal("./selector-dependency.mjs");
        defaultLocal("./selector-dependency.mjs");
        require("node:module")["createRequire"](import.meta.url)("./selector-dependency.mjs");
        import.meta["resolve"]("./selector-dependency.mjs");
        moduleApi["register"]("./selector-dependency.mjs", import.meta.url);
        namedRegister("./selector-dependency.mjs", import.meta.url);
        destructuredRegister("./selector-dependency.mjs", import.meta.url);
        directRegister("./selector-dependency.mjs", import.meta.url);
        import("./selector-dependency.mjs");
        import("./nested.tsx");
        import("./nested-jsx");
        import("./nested-mts");
        import("./nested-cts");
        import("./nested-cjs");
        import("./mapped.mjs");
        import("./mapped.cjs");
      `),
    );
    files.set("scripts/selector-dependency.mjs", Buffer.from("export {}\n"));
    files.set(
      "scripts/nested.tsx",
      Buffer.from(
        'import "./selector-dependency.mjs"; export const view = <section>{<span>nested</span>}</section>;\n',
      ),
    );
    for (const extension of ["jsx", "mts", "cts", "cjs"])
      files.set(
        `scripts/nested-${extension}.${extension}`,
        Buffer.from(
          extension === "jsx"
            ? 'import "./selector-dependency.mjs"; export const view = <span />;\n'
            : 'import "./selector-dependency.mjs"; export {};\n',
        ),
      );
    files.set("scripts/mapped.mts", Buffer.from("export {};\n"));
    files.set("scripts/mapped.cts", Buffer.from("export {};\n"));
    const closure = deriveLiveCatalogSourceClosure(inventory(files), files);
    expect(closure.entries.map((entry) => entry.path)).toContain(
      "scripts/selector-dependency.mjs",
    );
  });

  it("retains root tsconfig extends and a complete newly owning package root", () => {
    const files = selectedFiles();
    files.set(
      "scripts/attest-live-catalog-digest.mjs",
      Buffer.from('import "../packages/new-owner/src/entry.mts";\n'),
    );
    files.set(
      "packages/new-owner/package.json",
      Buffer.from('{"name":"@reviewrouter/new-owner","scripts":{}}\n'),
    );
    files.set(
      "packages/new-owner/src/entry.mts",
      Buffer.from('import "./nested.cjs";\n'),
    );
    files.set(
      "packages/new-owner/src/nested.cjs",
      Buffer.from("module.exports = {};\n"),
    );
    files.set(
      "packages/new-owner/src/retained.jsx",
      Buffer.from("export const view = <span />;\n"),
    );
    const closure = deriveLiveCatalogSourceClosure(inventory(files), files);
    const paths = closure.entries.map((entry) => entry.path);
    expect(paths).toContain("tsconfig.json");
    expect(paths).toContain("tsconfig.base.json");
    expect(paths).toContain("packages/new-owner/src/retained.jsx");
  });

  it.each([
    [
      "unknown dynamic import",
      "import(process.env.MODULE);",
      "dynamic_resolution",
    ],
    [
      "aliased dynamic require",
      "const req = require; req(value);",
      "dynamic_resolution",
    ],
    ["absolute path", 'require("/tmp/x.mjs");', "unsupported_specifier"],
    ["file URL", 'import("file:///tmp/x.mjs");', "unsupported_specifier"],
    ["data URL", 'import("data:text/javascript,1");', "unsupported_specifier"],
    [
      "HTTP URL",
      'import("https://example.test/x.mjs");',
      "unsupported_specifier",
    ],
    ["package imports", 'import("#private");', "unsupported_specifier"],
    ["undeclared package", 'import("left-pad");', "undeclared_package"],
    [
      "mutable alias",
      'let req = require; req("./x.mjs");',
      "mutable_resolution_alias",
    ],
    [
      "mutable module loader",
      'import * as moduleApi from "node:module"; moduleApi["register"] = consume;',
      "mutable_resolution_alias",
    ],
    [
      "destructured require primitive",
      "const { resolve } = require; resolve('./x.mjs');",
      "unsupported_resolution",
    ],
    [
      "escaped require primitive",
      "consume(require);",
      "unsupported_resolution",
    ],
    [
      "escaped createRequire primitive",
      'import { createRequire } from "node:module"; consume(createRequire);',
      "unsupported_resolution",
    ],
    [
      "default Module._load",
      'import Module from "node:module"; const load = Module["_load"]; load("./x.mjs");',
      "module_load_denied",
    ],
    [
      "required Module._load",
      'require("node:module")._load("./x.mjs");',
      "module_load_denied",
    ],
    [
      "named registerHooks",
      'import { registerHooks } from "node:module"; registerHooks({});',
      "module_load_denied",
    ],
    [
      "dynamic node module namespace",
      'const moduleApi = await import("node:module"); moduleApi.register("./x.mjs", import.meta.url);',
      "unsupported_resolution",
    ],
    ["direct eval", 'eval("require(\\"./x.mjs\\")");', "evaluator_denied"],
    [
      "aliased eval",
      'const evaluate = globalThis["eval"]; evaluate("require(\\"./x.mjs\\")");',
      "evaluator_denied",
    ],
    [
      "global alias eval",
      'const runtimeGlobal = globalThis; const evaluate = runtimeGlobal["eval"]; evaluate("require(\\"./x.mjs\\")");',
      "evaluator_denied",
    ],
    [
      "Function constructor",
      'Function("return require(\\"./x.mjs\\")")();',
      "evaluator_denied",
    ],
    [
      "unsupported module namespace property",
      'import * as moduleApi from "node:module"; moduleApi.isBuiltin("fs");',
      "unsupported_resolution",
    ],
    ["unsupported URL scheme", 'import("bun:test");', "unsupported_specifier"],
  ])("rejects %s without silently omitting it", (_name, source, error) => {
    const files = selectedFiles();
    files.set(
      "scripts/attest-live-catalog-digest.mjs",
      Buffer.from(`${source}\n`),
    );
    expect(() =>
      deriveLiveCatalogSourceClosure(inventory(files), files),
    ).toThrow(error);
  });

  it("retains the owning workspace package for wildcard unknown-subpath exports", () => {
    const files = selectedFiles();
    files.set(
      "scripts/attest-live-catalog-digest.mjs",
      Buffer.from('export * from "@reviewrouter/platform-db/not-exported";\n'),
    );
    files.set(
      "packages/platform/db/src/unknown.jsx",
      Buffer.from("export const value = <span />;\n"),
    );
    const closure = deriveLiveCatalogSourceClosure(inventory(files), files);
    expect(closure.entries.map((entry) => entry.path)).toContain(
      "packages/platform/db/src/unknown.jsx",
    );
  });

  it("preserves builtins and declared external packages without fetching them", () => {
    const files = selectedFiles();
    const manifest = JSON.parse(files.get("package.json")!.toString());
    manifest.devDependencies = { typescript: "5.9.2" };
    files.set("package.json", Buffer.from(JSON.stringify(manifest)));
    files.set(
      "scripts/attest-live-catalog-digest.mjs",
      Buffer.from('import "node:fs"; import "typescript";\n'),
    );
    expect(() =>
      deriveLiveCatalogSourceClosure(inventory(files), files),
    ).not.toThrow();
  });

  it("rejects inventory tamper, root mismatch, DOS paths, symlinks, and declared bounds", () => {
    const files = selectedFiles();
    const response: any = treeResponse(files);
    expect(() =>
      createLiveCatalogSourceInventory(
        { ...response, sha: "0".repeat(40) },
        response.sha,
      ),
    ).toThrow("tree_inventory_invalid");
    const tampered = structuredClone(response);
    tampered.tree.find((entry: any) => entry.type === "blob").sha = "1".repeat(
      40,
    );
    expect(() =>
      createLiveCatalogSourceInventory(tampered, response.sha),
    ).toThrow(/tree_.*mismatch/u);
    for (const path of ["CON", "dir/aux.txt", "trailing. ", "../escape"])
      expect(() =>
        createLiveCatalogSourceInventory(
          {
            sha: "0".repeat(40),
            url: "",
            truncated: false,
            tree: [
              {
                path,
                mode: "100644",
                type: "blob",
                sha: "1".repeat(40),
                size: 0,
              },
            ],
          },
          "0".repeat(40),
        ),
      ).toThrow("entry_invalid");
    expect(() =>
      createLiveCatalogSourceInventory(
        {
          sha: "0".repeat(40),
          url: "",
          truncated: false,
          tree: [
            {
              path: "link",
              mode: "120000",
              type: "blob",
              sha: "1".repeat(40),
              size: 1,
            },
          ],
        },
        "0".repeat(40),
      ),
    ).toThrow("entry_invalid");
    expect(() =>
      createLiveCatalogSourceInventory(
        {
          sha: "0".repeat(40),
          url: "",
          truncated: false,
          tree: Array.from(
            { length: LIVE_CATALOG_SOURCE_INVENTORY_LIMITS.entries + 1 },
            (_, index) => ({
              path: `f${index}`,
              mode: "100644",
              type: "blob",
              sha: "1".repeat(40),
              size: 0,
            }),
          ),
        },
        "0".repeat(40),
      ),
    ).toThrow("limit_exceeded");

    const closureOverflow = selectedFiles();
    for (
      let index = 0;
      index < LIVE_CATALOG_SOURCE_FETCH_LIMITS.files + 1;
      index += 1
    )
      closureOverflow.set(
        `packages/platform/db/prisma/migrations/m${index}/migration.sql`,
        Buffer.from("SELECT 1;\n"),
      );
    expect(() =>
      deriveLiveCatalogSourceClosure(
        inventory(closureOverflow),
        closureOverflow,
      ),
    ).toThrow("selector_limit_exceeded");
  });
});
