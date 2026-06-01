#!/usr/bin/env node
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const packageSpecs = [
  {
    id: "core",
    dir: "packages/subscription-runtime/core",
    repo: "subscription-runtime-core",
    description: "Provider-neutral subscription runtime core.",
  },
  {
    id: "provider-codex",
    dir: "packages/subscription-runtime/provider-codex",
    repo: "subscription-runtime-provider-codex",
    description: "Codex provider adapter for Subscription Runtime.",
  },
  {
    id: "store-local-file",
    dir: "packages/subscription-runtime/store-local-file",
    repo: "subscription-runtime-store-local-file",
    description: "Local encrypted file store for Subscription Runtime.",
  },
  {
    id: "worker-core",
    dir: "packages/subscription-runtime/worker-core",
    repo: "subscription-runtime-worker-core",
    description: "Provider-neutral worker pool for Subscription Runtime.",
  },
  {
    id: "worker-codex",
    dir: "packages/subscription-runtime/worker-codex",
    repo: "subscription-runtime-worker-codex",
    description: "Codex file-backend worker for Subscription Runtime.",
  },
  {
    id: "queue-core",
    dir: "packages/subscription-runtime/queue-core",
    repo: "subscription-runtime-queue-core",
    description:
      "Provider-neutral task queue contracts for Subscription Runtime.",
  },
  {
    id: "queue-bull",
    dir: "packages/subscription-runtime/queue-bull",
    repo: "subscription-runtime-queue-bull",
    description: "Bull/BullMQ adapter for Subscription Runtime.",
  },
  {
    id: "runner-github-action",
    dir: "packages/subscription-runtime/runner-github-action",
    repo: "subscription-runtime-runner-github-action",
    description: "GitHub Actions runner adapter for Subscription Runtime.",
  },
  {
    id: "store-github-actions-secret",
    dir: "packages/subscription-runtime/store-github-actions-secret",
    repo: "subscription-runtime-store-github-actions-secret",
    description:
      "GitHub Actions secret store adapter for Subscription Runtime.",
  },
];

const packageToRepo = new Map(
  packageSpecs.map((spec) => [packageJsonAt(spec.dir).name, spec.repo]),
);

const args = parseArgs(process.argv.slice(2));
const owner = args.owner ?? "777genius";
const branch = args.branch ?? "main";
const push = args.push === true;
const selected = new Set(
  (args.packages ?? packageSpecs.map((spec) => spec.id).join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

const specs = packageSpecs.filter((spec) => selected.has(spec.id));
if (specs.length === 0) {
  throw new Error("No subscription-runtime packages selected.");
}

console.log(
  `Syncing ${specs.length} public mirror package(s) for ${owner}#${branch}${push ? "" : " (dry run)"}.`,
);

for (const spec of specs) {
  await buildPackage(spec);
}
run("node", ["scripts/rewrite-dist-esm-imports.mjs"], { cwd: rootDir });

const outputRoot = await mkdtemp(
  join(tmpdir(), "subscription-runtime-mirror-"),
);
console.log(`Mirror staging root: ${outputRoot}`);

try {
  for (const spec of specs) {
    await syncPackage(spec, { owner, branch, outputRoot, push });
  }
  if (!push) {
    console.log(
      "Dry run complete. Re-run with --push to create/update public repos.",
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  throw error;
} finally {
  if (push) {
    await rm(outputRoot, { recursive: true, force: true });
  }
}

async function syncPackage(spec, options) {
  const sourceDir = resolve(rootDir, spec.dir);
  const targetDir = join(options.outputRoot, spec.repo);
  await cp(sourceDir, targetDir, {
    recursive: true,
    filter: (source) => shouldCopy(source),
  });

  const packageJsonPath = join(targetDir, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const rewritten = rewritePackageJson(packageJson, spec, options);
  await writeFile(packageJsonPath, `${JSON.stringify(rewritten, null, 2)}\n`);
  await writeFile(join(targetDir, "README.md"), mirrorReadme(spec, rewritten));
  await writeFile(
    join(targetDir, ".gitignore"),
    "node_modules\ncoverage\n*.log\n.env\n.env.*\n",
  );

  run("git", ["init", "-b", "main"], { cwd: targetDir });
  run("git", ["add", "."], { cwd: targetDir });
  run("git", ["commit", "-m", `sync ${rewritten.name} from review-router`], {
    cwd: targetDir,
  });

  console.log(`${rewritten.name}: staged at ${targetDir}`);
  if (!options.push) return;

  const fullRepo = `${options.owner}/${spec.repo}`;
  ensurePublicRepo(fullRepo, spec.description);
  run(
    "git",
    ["remote", "add", "origin", `https://github.com/${fullRepo}.git`],
    {
      cwd: targetDir,
    },
  );
  run("git", ["push", "--force", "origin", "main"], { cwd: targetDir });
  console.log(`${rewritten.name}: pushed to https://github.com/${fullRepo}`);
}

function rewritePackageJson(packageJson, spec, options) {
  const result = {
    name: packageJson.name,
    version:
      packageJson.version === "0.0.0" ? "0.0.0-main.0" : packageJson.version,
    description: spec.description,
    license: packageJson.license ?? "UNLICENSED",
    type: packageJson.type ?? "module",
    repository: {
      type: "git",
      url: `git+https://github.com/${options.owner}/${spec.repo}.git`,
    },
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
        default: "./dist/index.js",
      },
      "./package.json": "./package.json",
    },
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    files: ["dist", "src", "README.md"],
    dependencies: rewriteDependencies(packageJson.dependencies ?? {}, options),
    scripts: {
      build: packageJson.scripts?.build ?? "tsc -p tsconfig.build.json",
      typecheck:
        packageJson.scripts?.typecheck ?? "tsc --noEmit -p tsconfig.json",
    },
    engines: {
      node: ">=20",
    },
  };

  if (Object.keys(result.dependencies).length === 0) {
    delete result.dependencies;
  }
  return result;
}

function rewriteDependencies(dependencies, options) {
  return Object.fromEntries(
    Object.entries(dependencies).map(([name, version]) => {
      const repo = packageToRepo.get(name);
      if (!repo) return [name, version];
      return [
        name,
        `git+https://github.com/${options.owner}/${repo}.git#${options.branch}`,
      ];
    }),
  );
}

function shouldCopy(source) {
  const relative = source.slice(rootDir.length + 1);
  if (relative.includes("node_modules")) return false;
  if (relative.includes(`${pathSep()}dist${pathSep()}`)) return true;
  if (relative.endsWith(`${pathSep()}dist`)) return true;
  if (relative.includes(`${pathSep()}src${pathSep()}tests${pathSep()}`))
    return false;
  if (relative.endsWith(".test.ts")) return false;
  if (relative.endsWith(".tsbuildinfo")) return false;
  return true;
}

function mirrorReadme(spec, packageJson) {
  return `# ${packageJson.name}

${spec.description}

This repository is a generated public mirror of \`${spec.dir}\` from
\`777genius/review-router\`.

Do not edit this repository directly. Changes should land in review-router and
then be synced here.

## Install from GitHub main

\`\`\`json
{
  "dependencies": {
    "${packageJson.name}": "git+https://github.com/777genius/${spec.repo}.git#main"
  }
}
\`\`\`
`;
}

async function buildPackage(spec) {
  const packageJson = packageJsonAt(spec.dir);
  run("pnpm", ["--filter", packageJson.name, "build"], { cwd: rootDir });
}

function packageJsonAt(dir) {
  const path = resolve(rootDir, dir, "package.json");
  return JSON.parse(readFileSyncUtf8(path));
}

function ensurePublicRepo(fullRepo, description) {
  const view = spawnSync("gh", ["repo", "view", fullRepo], {
    cwd: rootDir,
    stdio: "ignore",
  });
  if (view.status === 0) return;

  run("gh", [
    "repo",
    "create",
    fullRepo,
    "--public",
    "--disable-issues",
    "--disable-wiki",
    "--description",
    description,
  ]);
}

function parseArgs(values) {
  const parsed = {};
  for (const value of values) {
    if (value === "--push") {
      parsed.push = true;
      continue;
    }
    const match = value.match(/^--([^=]+)=(.*)$/);
    if (match) parsed[match[1]] = match[2];
  }
  return parsed;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? rootDir,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status}`,
    );
  }
}

function readFileSyncUtf8(path) {
  return readFileSync(path, "utf8");
}

function pathSep() {
  return "/";
}
