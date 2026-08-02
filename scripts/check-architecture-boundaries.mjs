#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const root = process.env.REVIEWROUTER_ARCHITECTURE_ROOT
  ? resolve(process.env.REVIEWROUTER_ARCHITECTURE_ROOT)
  : new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const boundaryRoots = [
  join(root, "packages", "features"),
  join(root, "packages", "subscription-runtime"),
].filter((directory) => existsSync(directory));

const forbiddenImports = [
  {
    pattern: /^@prisma\/client(?:\/.*)?$/,
    reason: "Prisma is an infrastructure adapter",
  },
  {
    pattern: /^@octokit(?:\/.*)?$/,
    reason: "Octokit is a GitHub adapter",
  },
  {
    pattern: /^fastify(?:\/.*)?$/,
    reason: "Fastify belongs in API/interface adapters",
  },
  {
    pattern: /^@trpc(?:\/.*)?$/,
    reason: "tRPC belongs in API/interface adapters",
  },
  {
    pattern: /^next(?:\/.*)?$/,
    reason: "Next.js belongs in web/interface adapters",
  },
  {
    pattern: /^next-auth(?:\/.*)?$/,
    reason: "Auth.js belongs behind auth ports",
  },
  {
    pattern: /^@reviewrouter\/protocol-review-action-v2(?:\/.*)?$/,
    reason:
      "generated transport DTOs are allowed only in action-control-plane v2 interface adapters",
  },
];

const allowedLayerSegments = new Set(["domain", "application"]);
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);

const files = (
  await Promise.all(
    boundaryRoots.map((directory) =>
      collectBoundaryFiles(directory, directory),
    ),
  )
).flat();
const violations = [];

for (const file of files) {
  const source = readFileSync(file, "utf8");
  for (const imported of extractImportSpecifiers(source)) {
    const match = forbiddenImports.find((item) => item.pattern.test(imported));
    if (match) {
      violations.push({ file, imported, reason: match.reason });
    }
  }
}

const wrapperSyncPath = join(root, "scripts", "sync-public-action-runtime.mjs");
if (
  existsSync(wrapperSyncPath) &&
  readFileSync(wrapperSyncPath, "utf8").includes(
    "src/control-plane/generated/review-action-v2",
  )
) {
  violations.push({
    file: wrapperSyncPath,
    imported: "src/control-plane/generated/review-action-v2",
    reason:
      "wrapper sync must remain separate from the branch-aware v2 contract handoff",
  });
}

await checkReviewActionV2ProtocolBoundaries(violations);
await checkRevisionAwareReviewRatchet(violations);

if (violations.length > 0) {
  console.error("Architecture boundary violations found:");
  for (const violation of violations) {
    console.error(
      `- ${relative(root, violation.file)} imports ${violation.imported}: ${violation.reason}`,
    );
  }
  console.error(
    "Move framework/SDK/database code to infrastructure or interface adapters and expose a port to application code.",
  );
  process.exit(1);
}

console.log(
  `Architecture boundary check passed for ${files.length} domain/application files.`,
);

async function collectBoundaryFiles(directory, boundaryRoot) {
  const entries = await readdir(directory, { withFileTypes: true });
  const collected = [];

  for (const entry of entries) {
    if (entry.name === "dist" || entry.name === "node_modules") {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      collected.push(...(await collectBoundaryFiles(path, boundaryRoot)));
      continue;
    }
    if (!entry.isFile() || !isSourceFile(entry.name)) {
      continue;
    }
    if (isDomainOrApplicationFile(path, boundaryRoot)) {
      collected.push(path);
    }
  }

  return collected.sort();
}

function isSourceFile(fileName) {
  return [...sourceExtensions].some((extension) =>
    fileName.endsWith(extension),
  );
}

function isDomainOrApplicationFile(path, boundaryRoot) {
  const segments = relative(boundaryRoot, path).split(/[\\/]/);
  const srcIndex = segments.indexOf("src");
  if (srcIndex === -1) {
    return false;
  }
  return allowedLayerSegments.has(segments[srcIndex + 1]);
}

function extractImportSpecifiers(source) {
  const specifiers = new Set();
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:type\s+)?[^'";]+?\s+from\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const value = match[1]?.trim();
      if (value) {
        specifiers.add(value);
      }
    }
  }

  return specifiers;
}

async function checkReviewActionV2ProtocolBoundaries(violations) {
  const protocolPackageRoot = join(
    root,
    "packages",
    "protocol-review-action-v2",
  );
  const actionControlPlaneRoot = join(
    root,
    "packages",
    "features",
    "action-control-plane",
  );
  if (!existsSync(protocolPackageRoot)) {
    return;
  }

  const featureFiles = await collectAllSourceFiles(
    join(root, "packages", "features"),
  );
  for (const file of featureFiles) {
    const source = readFileSync(file, "utf8");
    const repositoryPath = relative(root, file).replaceAll("\\", "/");
    for (const imported of extractImportSpecifiers(source)) {
      if (
        imported === "@reviewrouter/protocol-review-action-v2" &&
        !repositoryPath.startsWith(
          "packages/features/action-control-plane/src/v2/interface/",
        ) &&
        !repositoryPath.startsWith(
          "packages/features/action-control-plane/src/tests/",
        )
      ) {
        violations.push({
          file,
          imported,
          reason:
            "generated Review Action v2 protocol is only consumed by the action-control-plane v2 interface",
        });
      }
    }
  }

  const protocolFiles = await collectAllSourceFiles(
    join(protocolPackageRoot, "src"),
  );
  for (const file of protocolFiles) {
    for (const imported of extractImportSpecifiers(
      readFileSync(file, "utf8"),
    )) {
      if (imported.startsWith("@reviewrouter/features-")) {
        violations.push({
          file,
          imported,
          reason:
            "generated protocol packages cannot depend on feature packages",
        });
      }
    }
  }

  const contractSourcePath = join(
    actionControlPlaneRoot,
    "src",
    "v2",
    "contract-source",
    "index.ts",
  );
  if (existsSync(contractSourcePath)) {
    const source = readFileSync(contractSourcePath, "utf8");
    if (
      extractImportSpecifiers(source).size > 0 ||
      /\b(?:process|fetch|Deno|Bun)\b|node:/.test(source)
    ) {
      violations.push({
        file: contractSourcePath,
        imported: "side effect or runtime dependency",
        reason: "contract-source must remain declarative and side-effect-free",
      });
    }
  }

  const packageJson = JSON.parse(
    readFileSync(join(actionControlPlaneRoot, "package.json"), "utf8"),
  );
  const publicExports = Object.keys(packageJson.exports ?? {}).sort();
  const expectedExports = [".", "./v2", "./v2/contract-source"];
  if (JSON.stringify(publicExports) !== JSON.stringify(expectedExports)) {
    violations.push({
      file: join(actionControlPlaneRoot, "package.json"),
      imported: publicExports.join(","),
      reason:
        "action-control-plane exports must keep the v1 root plus only the deliberate v2 interface and contract-source subpaths",
    });
  }
}

async function collectAllSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const collected = [];
  for (const entry of entries) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      collected.push(...(await collectAllSourceFiles(path)));
    } else if (entry.isFile() && isSourceFile(entry.name)) {
      collected.push(path);
    }
  }
  return collected.sort();
}

async function checkRevisionAwareReviewRatchet(violations) {
  const contexts = [
    strictContext("review-investigations", true),
    strictContext("review-run-control", true),
    strictContext("review-evidence", true),
    strictContext("review-executions", true),
    strictContext("review-processes", false),
    strictV2Context("review-publishing"),
    strictV2Context("review-snapshots"),
    {
      name: "signed-capabilities",
      packageRoot: join(root, "packages", "platform", "signed-capabilities"),
      sourceRoot: join(
        root,
        "packages",
        "platform",
        "signed-capabilities",
        "src",
      ),
      requiredExports: null,
      rootIndex: null,
    },
  ];

  for (const context of contexts) {
    if (!existsSync(context.sourceRoot)) continue;
    const sourceFiles = await collectAllSourceFiles(context.sourceRoot);
    for (const file of sourceFiles) {
      const source = readFileSync(file, "utf8");
      const layer = strictLayer(file, context.sourceRoot);
      for (const imported of extractImportSpecifiers(source)) {
        if (imported.startsWith("@reviewrouter/features-")) {
          violations.push({
            file,
            imported,
            reason:
              "strict review contexts communicate through consuming ports, Published Language, or app composition adapters",
          });
        }
        if (imported.startsWith(".")) {
          const resolved = new URL(imported, `file://${file}`).pathname;
          if (!isInside(resolved, context.sourceRoot)) {
            violations.push({
              file,
              imported,
              reason:
                "strict context relative imports cannot escape its source root",
            });
          }
          if (
            layer === "domain" &&
            !isInside(resolved, join(context.sourceRoot, "domain"))
          ) {
            violations.push({
              file,
              imported,
              reason: "strict domain code may depend only on its own domain",
            });
          }
          if (
            layer === "application" &&
            !isInside(resolved, join(context.sourceRoot, "domain")) &&
            !isInside(resolved, join(context.sourceRoot, "application"))
          ) {
            violations.push({
              file,
              imported,
              reason:
                "strict application code may depend only on its own domain and application ports/use cases",
            });
          }
          continue;
        }
        if (
          layer &&
          imported !== "@reviewrouter/shared" &&
          !imported.startsWith("@reviewrouter/shared/")
        ) {
          violations.push({
            file,
            imported,
            reason:
              "strict domain/application code cannot import frameworks, validation libraries, Node adapters, or another package",
          });
        }
      }

      if (
        layer &&
        /\bas\s+[A-Z][A-Za-z0-9]*(?:Kind|State|Type|Status|Reason|Mode|Capability|Outcome)\b/.test(
          source,
        )
      ) {
        violations.push({
          file,
          imported: "enum assertion cast",
          reason:
            "strict domain enums require an exhaustive anti-corruption mapper, not an assertion cast",
        });
      }
      if (
        layer &&
        /export\s+type\s+[A-Za-z0-9]*(?:Kind|State|Type|Status|Reason|Mode|Outcome)\s*=\s*["'][^"']+["']\s*\|/.test(
          source,
        )
      ) {
        violations.push({
          file,
          imported: "string-union discriminator",
          reason: "new domain/application discriminators must be strict enums",
        });
      }
    }

    if (context.requiredExports) {
      checkRequiredExportMap(context, violations);
    }
    if (context.rootIndex && existsSync(context.rootIndex)) {
      for (const imported of extractImportSpecifiers(
        readFileSync(context.rootIndex, "utf8"),
      )) {
        if (
          /(?:^|\/)(?:infrastructure|interface|composition|testing|contract-source)(?:\/|$)/.test(
            imported,
          )
        ) {
          violations.push({
            file: context.rootIndex,
            imported,
            reason:
              "strict package root exports only domain identifiers and application commands/ports",
          });
        }
      }
    }

    const contractSourceRoot = join(context.sourceRoot, "contract-source");
    if (existsSync(contractSourceRoot)) {
      for (const file of await collectAllSourceFiles(contractSourceRoot)) {
        const source = readFileSync(file, "utf8");
        for (const imported of extractImportSpecifiers(source)) {
          if (!imported.startsWith(".")) {
            violations.push({
              file,
              imported,
              reason:
                "contract-source may use only declarative local domain/canonicalizer input",
            });
          }
        }
        if (/\b(?:process|fetch|Deno|Bun)\b|node:/.test(source)) {
          violations.push({
            file,
            imported: "side effect or runtime dependency",
            reason: "contract-source must remain deterministic and I/O-free",
          });
        }
      }
    }
  }

  for (const legacy of ["review-publishing", "review-snapshots"]) {
    const legacyIndex = join(
      root,
      "packages",
      "features",
      legacy,
      "src",
      "index.ts",
    );
    if (
      existsSync(legacyIndex) &&
      readFileSync(legacyIndex, "utf8").includes("/v2")
    ) {
      violations.push({
        file: legacyIndex,
        imported: "v2",
        reason: "legacy package root must not re-export v2 symbols",
      });
    }
  }
}

function strictContext(name, protocolFacing) {
  const packageRoot = join(root, "packages", "features", name);
  return {
    name,
    packageRoot,
    sourceRoot: join(packageRoot, "src"),
    requiredExports: protocolFacing
      ? [".", "./composition", "./contract-source", "./testing"]
      : [".", "./composition", "./testing"],
    rootIndex: join(packageRoot, "src", "index.ts"),
  };
}

function strictV2Context(name) {
  const packageRoot = join(root, "packages", "features", name);
  return {
    name,
    packageRoot,
    sourceRoot: join(packageRoot, "src", "v2"),
    requiredExports: [
      ".",
      "./v2",
      "./v2/composition",
      "./v2/contract-source",
      "./v2/testing",
    ],
    rootIndex: join(packageRoot, "src", "v2", "index.ts"),
  };
}

function strictLayer(file, sourceRoot) {
  const first = relative(sourceRoot, file).split(/[\\/]/)[0];
  return first === "domain" || first === "application" ? first : null;
}

function isInside(candidate, directory) {
  const path = relative(directory, candidate);
  return path === "" || (!path.startsWith("..") && !path.startsWith("/"));
}

function checkRequiredExportMap(context, violations) {
  const packageJsonPath = join(context.packageRoot, "package.json");
  if (!existsSync(packageJsonPath)) return;
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const actual = Object.keys(packageJson.exports ?? {}).sort();
  const expected = [...context.requiredExports].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    violations.push({
      file: packageJsonPath,
      imported: actual.join(","),
      reason: `${context.name} export map must be exactly ${expected.join(",")}`,
    });
  }
}
