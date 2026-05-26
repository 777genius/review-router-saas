#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const boundaryRoots = [
  join(root, "packages", "features"),
  join(root, "packages", "subscription-runtime"),
];

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
];

const allowedLayerSegments = new Set(["domain", "application"]);
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);

const files = (
  await Promise.all(
    boundaryRoots.map((directory) => collectBoundaryFiles(directory, directory)),
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
