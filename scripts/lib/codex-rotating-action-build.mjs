import { readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { build } from "esbuild";

const thirdPartyNotices = await readFile(
  new URL("../codex-rotating-action-third-party-licenses.txt", import.meta.url),
  "utf8",
);

export async function buildCodexRotatingAction({
  root = process.cwd(),
  outfile = join(root, "action-dist/index.cjs"),
} = {}) {
  await build({
    absWorkingDir: root,
    entryPoints: [
      "packages/features/codex-oauth-rotating/src/action/github-action.ts",
    ],
    outfile,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    // Keep YAML's CJS wrapper paths logical without changing identifier names
    // or symlink resolution for the rest of the dependency graph.
    plugins: [
      {
        name: "logical-yaml-paths",
        setup(actionBuild) {
          let yamlRoot = "";
          /** @param {import("esbuild").OnResolveArgs} args */
          const resolveYaml = async (args) => {
            if (args.pluginData === "physical-yaml-resolution") return;
            const resolved = await actionBuild.resolve(args.path, {
              resolveDir: args.resolveDir,
              kind: args.kind,
              pluginData: "physical-yaml-resolution",
            });
            if (resolved.errors.length > 0 || resolved.external) {
              return resolved;
            }
            if (args.namespace === "file") {
              // The locked YAML Node export is dist/index.js. Keep one physical
              // package identity; never merge distinct installations silently.
              const packageRoot = dirname(dirname(resolved.path));
              if (yamlRoot && yamlRoot !== packageRoot) {
                throw new Error(
                  "Action YAML imports resolved to distinct packages",
                );
              }
              yamlRoot = packageRoot;
            }
            const logicalPath = relative(yamlRoot, resolved.path);
            if (
              logicalPath === ".." ||
              logicalPath.startsWith(`..${sep}`) ||
              isAbsolute(logicalPath)
            ) {
              return resolved;
            }
            return {
              ...resolved,
              path: logicalPath.split(sep).join("/"),
              namespace: "yaml",
              pluginData: resolved.path,
            };
          };
          actionBuild.onResolve(
            { filter: /^yaml$/, namespace: "file" },
            resolveYaml,
          );
          actionBuild.onResolve(
            { filter: /.*/, namespace: "yaml" },
            resolveYaml,
          );
          actionBuild.onLoad(
            { filter: /.*/, namespace: "yaml" },
            async (args) => ({
              contents: await readFile(args.pluginData, "utf8"),
              loader: "js",
              resolveDir: dirname(args.pluginData),
            }),
          );
        },
      },
    ],
    legalComments: "none",
    banner: {
      js: `/*! ReviewRouter Action third-party notices\n${thirdPartyNotices.trimEnd()}\n*/`,
    },
  });
  const bundle = await readFile(outfile, "utf8");
  const reproducibleBundle = bundle.replace(
    /^\/\/ (?:.*\/)?node_modules\/[^\r\n]*(?:\r?\n|$)/gmu,
    "",
  );
  if (reproducibleBundle !== bundle) {
    await writeFile(outfile, reproducibleBundle);
  }
}
