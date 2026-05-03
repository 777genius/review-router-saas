import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type SourceLayer = "domain" | "application";

type SourceFile = {
  layer: SourceLayer;
  path: string;
};

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const featuresRoot = path.join(repoRoot, "packages/features");
const forbiddenRuntimeImports = [
  "@octokit/",
  "@octokit/app",
  "@octokit/rest",
  "@prisma/client",
  "@trpc/",
  "fastify",
  "fastify-raw-body",
  "next",
  "next/",
  "next-auth",
  "pg-boss",
  "react",
  "react-dom",
];

const walk = (directory: string): string[] => {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((entry) => {
    const absolute = path.join(directory, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) return walk(absolute);
    if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".d.ts"))
      return [absolute];
    return [];
  });
};

const listLayerFiles = (): SourceFile[] =>
  readdirSync(featuresRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((feature) => {
      const srcRoot = path.join(featuresRoot, feature.name, "src");
      return (["domain", "application"] as const).flatMap((layer) =>
        walk(path.join(srcRoot, layer)).map((filePath) => ({
          layer,
          path: filePath,
        })),
      );
    });

const importPattern =
  /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

const extractImports = (source: string): string[] =>
  [...source.matchAll(importPattern)].flatMap((match) => {
    const specifier = match[1] ?? match[2];
    return specifier ? [specifier] : [];
  });

const isForbiddenRuntimeImport = (specifier: string): boolean =>
  forbiddenRuntimeImports.some(
    (forbidden) =>
      specifier === forbidden.replace(/\/$/, "") ||
      specifier.startsWith(forbidden),
  );

const resolveRelativeImport = (
  fromFile: string,
  specifier: string,
): string | null => {
  if (!specifier.startsWith(".")) return null;
  return path
    .resolve(path.dirname(fromFile), specifier)
    .replaceAll(path.sep, "/");
};

const toRelative = (absolutePath: string): string =>
  path.relative(repoRoot, absolutePath).replaceAll(path.sep, "/");

describe("feature architecture boundaries", () => {
  it("keeps domain/application independent from framework and adapter layers", () => {
    const violations: string[] = [];

    for (const file of listLayerFiles()) {
      const source = readFileSync(file.path, "utf8");
      for (const specifier of extractImports(source)) {
        if (isForbiddenRuntimeImport(specifier)) {
          violations.push(
            `${toRelative(file.path)} imports runtime adapter package ${specifier}`,
          );
        }

        const resolved = resolveRelativeImport(file.path, specifier);
        if (!resolved) continue;

        if (
          file.layer === "domain" &&
          (/\/src\/application\//.test(resolved) ||
            /\/src\/infrastructure\//.test(resolved) ||
            /\/src\/interface\//.test(resolved))
        ) {
          violations.push(
            `${toRelative(file.path)} has domain dependency on ${specifier}`,
          );
        }

        if (
          file.layer === "application" &&
          (/\/src\/infrastructure\//.test(resolved) ||
            /\/src\/interface\//.test(resolved))
        ) {
          violations.push(
            `${toRelative(file.path)} has application dependency on ${specifier}`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
