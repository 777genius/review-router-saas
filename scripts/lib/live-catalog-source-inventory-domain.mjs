import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import { posix } from "node:path";
import ts from "typescript";

export const LIVE_CATALOG_SOURCE_INVENTORY_SCHEMA =
  "reviewrouter.live-catalog.source-inventory.v1";
export const LIVE_CATALOG_SOURCE_SELECTOR =
  "reviewrouter.live-catalog.source-selector.v2";
export const LIVE_CATALOG_SOURCE_CLOSURE_SCHEMA =
  "reviewrouter.live-catalog.source-closure.v2";

export const LIVE_CATALOG_SOURCE_INVENTORY_LIMITS = Object.freeze({
  canonicalBytes: 4 * 1024 * 1024,
  entries: 8192,
  logicalBytes: 256 * 1024 * 1024,
  blobBytes: 128 * 1024 * 1024,
});

export const LIVE_CATALOG_SOURCE_FETCH_LIMITS = Object.freeze({
  files: 512,
  fileBytes: 4 * 1024 * 1024,
  retainedBytes: 24 * 1024 * 1024,
});

/** Aggregate adapter-fetch budget. A failed lease releases every reservation. */
export function createLiveCatalogSourceFetchBudget() {
  let retainedBytes = 0;
  let inFlightBytes = 0;
  let requestedFiles = 0;
  const reserve = (sizes) => {
    if (
      !Array.isArray(sizes) ||
      !sizes.length ||
      sizes.some(
        (size) =>
          !Number.isSafeInteger(size) ||
          size < 0 ||
          size > LIVE_CATALOG_SOURCE_FETCH_LIMITS.fileBytes,
      )
    )
      throw new Error("live_catalog_source_closure_limit_exceeded");
    const bytes = sizes.reduce((total, size) => total + size, 0);
    if (
      requestedFiles + sizes.length > LIVE_CATALOG_SOURCE_FETCH_LIMITS.files ||
      retainedBytes + inFlightBytes + bytes >
        LIVE_CATALOG_SOURCE_FETCH_LIMITS.retainedBytes
    )
      throw new Error("live_catalog_source_closure_limit_exceeded");
    requestedFiles += sizes.length;
    inFlightBytes += bytes;
    let active = true;
    return Object.freeze({
      commit(actualBytes) {
        if (!active || actualBytes !== bytes)
          throw new Error("live_catalog_source_closure_reservation_mismatch");
        active = false;
        inFlightBytes -= bytes;
        retainedBytes += actualBytes;
      },
      release() {
        if (!active) return;
        active = false;
        inFlightBytes -= bytes;
        requestedFiles -= sizes.length;
      },
    });
  };
  return Object.freeze({
    reserve,
    facts: () =>
      Object.freeze({ retainedBytes, inFlightBytes, requestedFiles }),
  });
}

const sha1Pattern = /^[a-f0-9]{40}$/u;
const forbiddenDosName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const textSourcePattern = /\.(?:[cm]?[jt]s|tsx?)$/u;
const builtinSpecifiers = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);
const validatedInventories = new WeakSet();
const byteCompare = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined)
        throw new Error("live_catalog_source_inventory_noncanonical");
      result[key] = canonicalize(value[key]);
    }
    return result;
  }
  throw new Error("live_catalog_source_inventory_noncanonical");
}

export const canonicalSourceInventoryJson = (value) =>
  `${JSON.stringify(canonicalize(value), null, 2)}\n`;

const sha256Digest = (bytes) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export function gitBlobSha(bytes) {
  const value = Buffer.from(bytes);
  return createHash("sha1")
    .update(`blob ${value.length}\0`)
    .update(value)
    .digest("hex");
}

function safePath(path) {
  if (
    typeof path !== "string" ||
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    Buffer.from(path, "utf8").toString("utf8") !== path ||
    path !== path.normalize("NFC") ||
    posix.normalize(path) !== path
  )
    return false;
  const segments = path.split("/");
  return segments.every(
    (segment) =>
      segment &&
      segment !== "." &&
      segment !== ".." &&
      ![...segment].some((character) => character.codePointAt(0) < 32) &&
      !/[<>:"|?*]/u.test(segment) &&
      !segment.endsWith(".") &&
      !segment.endsWith(" ") &&
      !forbiddenDosName.test(segment),
  );
}

function exactKeys(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...keys].sort())
  );
}

function inventoryEntry(raw) {
  if (!safePath(raw?.path) || !sha1Pattern.test(raw?.sha ?? ""))
    throw new Error("live_catalog_source_inventory_entry_invalid");
  if (raw.type === "blob") {
    if (
      (raw.mode !== "100644" && raw.mode !== "100755") ||
      !Number.isSafeInteger(raw.size) ||
      raw.size < 0 ||
      raw.size > LIVE_CATALOG_SOURCE_INVENTORY_LIMITS.blobBytes
    )
      throw new Error("live_catalog_source_inventory_entry_invalid");
    return Object.freeze({
      path: raw.path,
      mode: raw.mode,
      type: "blob",
      sha: raw.sha,
      size: raw.size,
    });
  }
  if (raw.type !== "tree" || raw.mode !== "040000")
    throw new Error("live_catalog_source_inventory_entry_invalid");
  return Object.freeze({
    path: raw.path,
    mode: "040000",
    type: "tree",
    sha: raw.sha,
  });
}

/** Convert GitHub's complete recursive tree response into canonical policy input. */
export function createLiveCatalogSourceInventory(
  treeResponse,
  expectedTreeSha,
) {
  if (
    !treeResponse ||
    typeof treeResponse !== "object" ||
    Array.isArray(treeResponse) ||
    treeResponse.truncated !== false ||
    treeResponse.sha !== expectedTreeSha ||
    !sha1Pattern.test(expectedTreeSha ?? "") ||
    !Array.isArray(treeResponse.tree)
  )
    throw new Error("live_catalog_source_tree_inventory_invalid");
  if (treeResponse.tree.length > LIVE_CATALOG_SOURCE_INVENTORY_LIMITS.entries)
    throw new Error("live_catalog_source_inventory_limit_exceeded");
  const entries = treeResponse.tree
    .map(inventoryEntry)
    .sort((a, b) => byteCompare(a.path, b.path));
  const paths = new Set();
  let logicalBytes = 0;
  for (const entry of entries) {
    if (paths.has(entry.path))
      throw new Error("live_catalog_source_inventory_duplicate_path");
    paths.add(entry.path);
    if (entry.type === "blob") logicalBytes += entry.size;
    const parent = posix.dirname(entry.path);
    if (parent !== ".") {
      const parentEntry = entries.find(
        (candidate) => candidate.path === parent,
      );
      if (!parentEntry || parentEntry.type !== "tree")
        throw new Error("live_catalog_source_inventory_parent_missing");
    }
  }
  if (logicalBytes > LIVE_CATALOG_SOURCE_INVENTORY_LIMITS.logicalBytes)
    throw new Error("live_catalog_source_inventory_limit_exceeded");
  const inventory = Object.freeze({
    schemaVersion: LIVE_CATALOG_SOURCE_INVENTORY_SCHEMA,
    treeSha: expectedTreeSha,
    entries: Object.freeze(entries),
  });
  const canonicalBytes = Buffer.from(canonicalSourceInventoryJson(inventory));
  if (
    canonicalBytes.length > LIVE_CATALOG_SOURCE_INVENTORY_LIMITS.canonicalBytes
  )
    throw new Error("live_catalog_source_inventory_limit_exceeded");
  validatedInventories.add(inventory);
  try {
    reconstructLiveCatalogTree(inventory);
  } catch (error) {
    validatedInventories.delete(inventory);
    throw error;
  }
  return inventory;
}

export function parseLiveCatalogSourceInventory(value) {
  if (validatedInventories.has(value)) return value;
  if (
    !exactKeys(value, ["schemaVersion", "treeSha", "entries"]) ||
    value.schemaVersion !== LIVE_CATALOG_SOURCE_INVENTORY_SCHEMA ||
    !Array.isArray(value.entries)
  )
    throw new Error("live_catalog_source_inventory_invalid");
  const response = {
    sha: value.treeSha,
    url: "",
    truncated: false,
    tree: value.entries.map((entry) => {
      const keys =
        entry?.type === "blob"
          ? ["path", "mode", "type", "sha", "size"]
          : ["path", "mode", "type", "sha"];
      if (!exactKeys(entry, keys))
        throw new Error("live_catalog_source_inventory_entry_invalid");
      return entry;
    }),
  };
  const parsed = createLiveCatalogSourceInventory(response, value.treeSha);
  if (
    canonicalSourceInventoryJson(parsed) !== canonicalSourceInventoryJson(value)
  )
    throw new Error("live_catalog_source_inventory_not_canonical");
  return parsed;
}

function gitTreeSha(children) {
  const pieces = [];
  for (const child of children) {
    pieces.push(Buffer.from(`${child.mode} ${child.name}\0`, "utf8"));
    pieces.push(Buffer.from(child.sha, "hex"));
  }
  const body = Buffer.concat(pieces);
  return createHash("sha1")
    .update(`tree ${body.length}\0`)
    .update(body)
    .digest("hex");
}

/** Rebuild every tree object bottom-up and return the authenticated root SHA. */
export function reconstructLiveCatalogTree(inventoryValue) {
  const inventory = validatedInventories.has(inventoryValue)
    ? inventoryValue
    : parseLiveCatalogSourceInventory(inventoryValue);
  const byPath = new Map(inventory.entries.map((entry) => [entry.path, entry]));
  const directories = [
    "",
    ...inventory.entries
      .filter((entry) => entry.type === "tree")
      .map((entry) => entry.path),
  ].sort(
    (a, b) =>
      (b ? b.split("/").length : 0) - (a ? a.split("/").length : 0) ||
      byteCompare(b, a),
  );
  const computed = new Map();
  for (const directory of directories) {
    const children = inventory.entries
      .filter((entry) => posix.dirname(entry.path) === (directory || "."))
      .map((entry) => ({
        mode: entry.type === "tree" ? "40000" : entry.mode,
        name: posix.basename(entry.path),
        sha: entry.type === "tree" ? computed.get(entry.path) : entry.sha,
        tree: entry.type === "tree",
      }));
    if (children.some((entry) => !entry.sha))
      throw new Error("live_catalog_source_tree_reconstruction_invalid");
    children.sort((a, b) =>
      Buffer.compare(
        Buffer.from(`${a.name}${a.tree ? "/" : ""}`, "utf8"),
        Buffer.from(`${b.name}${b.tree ? "/" : ""}`, "utf8"),
      ),
    );
    const sha = gitTreeSha(children);
    if (directory && byPath.get(directory)?.sha !== sha)
      throw new Error("live_catalog_source_tree_sha_mismatch");
    computed.set(directory, sha);
  }
  if (computed.get("") !== inventory.treeSha)
    throw new Error("live_catalog_source_tree_root_mismatch");
  return inventory.treeSha;
}

export function liveCatalogSourceInventoryFacts(inventoryValue) {
  const inventory = parseLiveCatalogSourceInventory(inventoryValue);
  const bytes = Buffer.from(canonicalSourceInventoryJson(inventory));
  const blobs = inventory.entries.filter((entry) => entry.type === "blob");
  return Object.freeze({
    schemaVersion: LIVE_CATALOG_SOURCE_INVENTORY_SCHEMA,
    treeSha: inventory.treeSha,
    digest: sha256Digest(bytes),
    canonicalBytes: bytes.length,
    entryCount: inventory.entries.length,
    blobCount: blobs.length,
    logicalBytes: blobs.reduce((total, entry) => total + entry.size, 0),
  });
}

export const LIVE_CATALOG_SELECTOR_ROOTS = Object.freeze([
  ".github/workflows/attest-live-catalog-digest.yml",
  ".github/workflows/capture-live-catalog.yml",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts/attest-live-catalog-digest.mjs",
  "scripts/install-private-dependencies.mjs",
  "scripts/run-with-env.mjs",
  "scripts/rehearse-private-pg17-rollout.mjs",
  "scripts/package-live-catalog-capture-evidence.mjs",
  "scripts/capture-private-pg17-activation-catalog-policy.mjs",
  "scripts/run-codex-rotating-release-migration.mjs",
  "scripts/run-codex-rotating-role-bootstrap.mjs",
  "scripts/run-private-pg17-copy-bootstrap.ts",
  "scripts/activate-private-pg17-generation.mjs",
  "scripts/install-release-authority-db.mjs",
  "scripts/lib/live-catalog-capture-contract.mjs",
  "scripts/lib/live-catalog-source-inventory-domain.mjs",
  "packages/features/release-rollout/src/adapters/live-v70-v72-catalog-digest.mjs",
  "packages/platform/db/prisma.config.ts",
  "packages/platform/db/prisma/schema.prisma",
]);

function parseModuleSpecifiers(path, bytes) {
  if (!textSourcePattern.test(path)) return [];
  const source = ts.createSourceFile(
    path,
    Buffer.from(bytes).toString("utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  if (source.parseDiagnostics.length)
    throw new Error("live_catalog_source_selector_syntax_invalid");
  const result = [];
  const requireAliases = new Set(["require"]);
  const requireResolveAliases = new Set();
  const createRequireAliases = new Set();
  const moduleNamespaceAliases = new Set();
  const importMetaResolve = (node) =>
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "resolve" &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.expression.name.text === "meta";
  const importMetaUrl = (node) =>
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "url" &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.expression.name.text === "meta";
  const staticSpecifier = (call) => {
    if (call.arguments.length !== 1 || !ts.isStringLiteral(call.arguments[0]))
      throw new Error("live_catalog_source_selector_dynamic_resolution");
    result.push(call.arguments[0].text);
  };
  const createRequireExpression = (node) =>
    (ts.isIdentifier(node) && createRequireAliases.has(node.text)) ||
    (ts.isPropertyAccessExpression(node) &&
      node.name.text === "createRequire" &&
      ts.isIdentifier(node.expression) &&
      moduleNamespaceAliases.has(node.expression.text));

  // Establish only simple, immutable aliases whose meaning is statically
  // reliable. Shadowing or reassignment is denied below.
  const collectAliases = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      (node.moduleSpecifier.text === "node:module" ||
        node.moduleSpecifier.text === "module")
    ) {
      if (ts.isNamespaceImport(node.importClause?.namedBindings))
        moduleNamespaceAliases.add(node.importClause.namedBindings.name.text);
      for (const element of node.importClause?.namedBindings?.elements ?? [])
        if (
          element.propertyName?.text === "createRequire" ||
          (!element.propertyName && element.name.text === "createRequire")
        )
          createRequireAliases.add(element.name.text);
    }
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer)
          continue;
        const name = declaration.name.text;
        const initializer = declaration.initializer;
        const resolverAlias =
          (ts.isIdentifier(initializer) &&
            (requireAliases.has(initializer.text) ||
              requireResolveAliases.has(initializer.text) ||
              createRequireAliases.has(initializer.text))) ||
          (ts.isPropertyAccessExpression(initializer) &&
            initializer.name.text === "resolve" &&
            ts.isIdentifier(initializer.expression) &&
            requireAliases.has(initializer.expression.text)) ||
          (ts.isCallExpression(initializer) &&
            createRequireExpression(initializer.expression));
        if (resolverAlias && !(node.declarationList.flags & ts.NodeFlags.Const))
          throw new Error(
            "live_catalog_source_selector_mutable_resolution_alias",
          );
        if (
          (requireAliases.has(name) ||
            requireResolveAliases.has(name) ||
            createRequireAliases.has(name)) &&
          !resolverAlias
        )
          throw new Error("live_catalog_source_selector_resolution_shadowed");
        if (
          ts.isIdentifier(initializer) &&
          requireAliases.has(initializer.text)
        )
          requireAliases.add(name);
        else if (
          ts.isIdentifier(initializer) &&
          requireResolveAliases.has(initializer.text)
        )
          requireResolveAliases.add(name);
        else if (
          ts.isIdentifier(initializer) &&
          createRequireAliases.has(initializer.text)
        )
          createRequireAliases.add(name);
        else if (
          ts.isPropertyAccessExpression(initializer) &&
          initializer.name.text === "resolve" &&
          ts.isIdentifier(initializer.expression) &&
          requireAliases.has(initializer.expression.text)
        )
          requireResolveAliases.add(name);
        else if (
          ts.isCallExpression(initializer) &&
          createRequireExpression(initializer.expression)
        ) {
          if (
            initializer.arguments.length !== 1 ||
            !importMetaUrl(initializer.arguments[0])
          )
            throw new Error("live_catalog_source_selector_dynamic_resolution");
          requireAliases.add(name);
        }
      }
    }
    if (
      ts.isParameter(node) &&
      ts.isIdentifier(node.name) &&
      (requireAliases.has(node.name.text) ||
        requireResolveAliases.has(node.name.text) ||
        createRequireAliases.has(node.name.text) ||
        moduleNamespaceAliases.has(node.name.text))
    )
      throw new Error("live_catalog_source_selector_resolution_shadowed");
    ts.forEachChild(node, collectAliases);
  };
  collectAliases(source);
  const declarationIdentifier = (node) =>
    (ts.isVariableDeclaration(node.parent) && node.parent.name === node) ||
    (ts.isImportSpecifier(node.parent) &&
      (node.parent.name === node || node.parent.propertyName === node)) ||
    (ts.isNamespaceImport(node.parent) && node.parent.name === node);
  const aliasedInitializer = (node) =>
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name) &&
    node.parent.initializer === node;
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      if (!ts.isStringLiteral(node.moduleSpecifier))
        throw new Error("live_catalog_source_selector_dynamic_resolution");
      result.push(node.moduleSpecifier.text);
    }
    if (ts.isImportEqualsDeclaration(node)) {
      if (
        !ts.isExternalModuleReference(node.moduleReference) ||
        !node.moduleReference.expression ||
        !ts.isStringLiteral(node.moduleReference.expression)
      )
        throw new Error("live_catalog_source_selector_dynamic_resolution");
      result.push(node.moduleReference.expression.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      staticSpecifier(node);
    } else if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (
        (ts.isIdentifier(expression) &&
          (requireAliases.has(expression.text) ||
            requireResolveAliases.has(expression.text))) ||
        (ts.isPropertyAccessExpression(expression) &&
          expression.name.text === "resolve" &&
          ts.isIdentifier(expression.expression) &&
          requireAliases.has(expression.expression.text)) ||
        importMetaResolve(expression)
      )
        staticSpecifier(node);
      else if (createRequireExpression(expression)) {
        if (node.arguments.length !== 1 || !importMetaUrl(node.arguments[0]))
          throw new Error("live_catalog_source_selector_dynamic_resolution");
        if (ts.isCallExpression(node.parent) && node.parent.expression === node)
          staticSpecifier(node.parent);
        else if (
          !ts.isVariableDeclaration(node.parent) ||
          node.parent.initializer !== node
        )
          throw new Error(
            "live_catalog_source_selector_unsupported_resolution",
          );
      } else if (
        ts.isElementAccessExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        requireAliases.has(expression.expression.text)
      )
        throw new Error("live_catalog_source_selector_unsupported_resolution");
    }
    if (
      ts.isBinaryExpression(node) &&
      ts.isIdentifier(node.left) &&
      (requireAliases.has(node.left.text) ||
        requireResolveAliases.has(node.left.text) ||
        createRequireAliases.has(node.left.text))
    )
      throw new Error("live_catalog_source_selector_mutable_resolution_alias");
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "resolve" &&
      ts.isIdentifier(node.expression) &&
      requireAliases.has(node.expression.text) &&
      !(
        (ts.isCallExpression(node.parent) && node.parent.expression === node) ||
        (ts.isVariableDeclaration(node.parent) &&
          node.parent.initializer === node)
      )
    )
      throw new Error("live_catalog_source_selector_unsupported_resolution");
    if (
      importMetaResolve(node) &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node)
    )
      throw new Error("live_catalog_source_selector_unsupported_resolution");
    if (ts.isIdentifier(node)) {
      const resolver =
        requireAliases.has(node.text) ||
        requireResolveAliases.has(node.text) ||
        createRequireAliases.has(node.text);
      const namespace = moduleNamespaceAliases.has(node.text);
      const recognizedResolverUse =
        declarationIdentifier(node) ||
        aliasedInitializer(node) ||
        (ts.isCallExpression(node.parent) && node.parent.expression === node) ||
        (ts.isPropertyAccessExpression(node.parent) &&
          node.parent.expression === node &&
          ((requireAliases.has(node.text) &&
            node.parent.name.text === "resolve") ||
            (namespace && node.parent.name.text === "createRequire")));
      if ((resolver || namespace) && !recognizedResolverUse)
        throw new Error("live_catalog_source_selector_unsupported_resolution");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...new Set(result)].sort(byteCompare);
}

function packageNameFromSpecifier(specifier) {
  return specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
}

function assertSupportedSpecifier(specifier) {
  if (
    typeof specifier !== "string" ||
    !specifier ||
    specifier.startsWith("/") ||
    (/^[a-z][a-z0-9+.-]*:/iu.test(specifier) &&
      !specifier.startsWith("node:")) ||
    specifier.startsWith("#") ||
    specifier.includes("\\") ||
    specifier.includes("\0")
  )
    throw new Error(
      `live_catalog_source_selector_unsupported_specifier:${specifier}`,
    );
}

function resolveRelative(importer, specifier, blobs) {
  const base = posix.normalize(posix.join(posix.dirname(importer), specifier));
  if (!safePath(base))
    throw new Error("live_catalog_source_selector_unresolved_import");
  const mapped = base.endsWith(".js")
    ? [`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`]
    : [];
  const candidates = [
    base,
    ...mapped,
    `${base}.mjs`,
    `${base}.js`,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.json`,
    posix.join(base, "index.mjs"),
    posix.join(base, "index.js"),
    posix.join(base, "index.ts"),
  ];
  const matches = candidates.filter((candidate) => blobs.has(candidate));
  if (matches.length !== 1)
    throw new Error("live_catalog_source_selector_unresolved_import");
  return matches[0];
}

function parseManifest(bytes, label) {
  let manifest;
  try {
    manifest = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error(`live_catalog_source_selector_${label}_invalid`);
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    throw new Error(`live_catalog_source_selector_${label}_invalid`);
  return manifest;
}

function packageDirectories(blobs) {
  return [...blobs.keys()]
    .filter((path) => path.endsWith("/package.json"))
    .map((path) => posix.dirname(path));
}

function governingManifests(path, blobs) {
  const manifests = [];
  let directory = posix.dirname(path);
  while (directory !== ".") {
    const manifest = `${directory}/package.json`;
    if (blobs.has(manifest)) manifests.push(manifest);
    directory = posix.dirname(directory);
  }
  if (blobs.has("package.json")) manifests.push("package.json");
  return manifests;
}

function resolveWorkspacePackage(specifier, blobs, getBytes) {
  const packageName = packageNameFromSpecifier(specifier);
  const matches = [];
  let matchingPackages = 0;
  for (const directory of packageDirectories(blobs)) {
    const manifestPath = `${directory}/package.json`;
    const manifest = parseManifest(getBytes(manifestPath), "manifest");
    if (manifest.name === packageName) {
      matchingPackages += 1;
      const subpath = specifier.slice(packageName.length).replace(/^\//u, "");
      const exported = manifest.exports
        ? subpath
          ? manifest.exports[`./${subpath}`]
          : (manifest.exports["."] ?? manifest.exports)
        : undefined;
      const targets = [];
      const collectTargets = (value) => {
        if (typeof value === "string") targets.push(value);
        else if (value && typeof value === "object" && !Array.isArray(value))
          for (const key of ["source", "types", "import", "node", "default"])
            if (Object.hasOwn(value, key)) collectTargets(value[key]);
      };
      collectTargets(exported);
      if (!targets.length)
        targets.push(
          subpath ||
            manifest.source ||
            manifest.module ||
            manifest.main ||
            "src/index.ts",
        );
      let resolved;
      try {
        resolved = [
          ...new Set(
            targets.map((target) =>
              resolveRelative(
                manifestPath,
                target.startsWith(".") ? target : `./${target}`,
                blobs,
              ),
            ),
          ),
        ];
      } catch {
        throw new Error(
          `live_catalog_source_selector_workspace_ambiguous:${specifier}`,
        );
      }
      matches.push(...resolved);
      matches.push(manifestPath);
    }
  }
  if (!matches.length) return [];
  if (matchingPackages !== 1)
    throw new Error(
      `live_catalog_source_selector_workspace_ambiguous:${specifier}`,
    );
  return [...new Set(matches)].sort(byteCompare);
}

function assertDeclaredExternal(importer, specifier, blobs, getBytes) {
  const packageName = packageNameFromSpecifier(specifier);
  let declaration;
  for (const manifestPath of governingManifests(importer, blobs)) {
    const manifestBytes = getBytes(manifestPath);
    if (!manifestBytes)
      throw new Error("live_catalog_source_selector_manifest_unavailable");
    const manifest = parseManifest(manifestBytes, "manifest");
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      const dependencies = manifest[field];
      if (
        dependencies &&
        typeof dependencies === "object" &&
        !Array.isArray(dependencies) &&
        typeof dependencies[packageName] === "string"
      )
        declaration = dependencies[packageName];
    }
  }
  if (!declaration)
    throw new Error(
      `live_catalog_source_selector_undeclared_package:${specifier}`,
    );
  if (/^(?:workspace|file|link):/u.test(declaration))
    throw new Error(
      `live_catalog_source_selector_workspace_unresolved:${specifier}`,
    );
}

function assertSafeManifest(path, bytes) {
  const manifest = parseManifest(bytes, "manifest");
  const scripts = manifest.scripts ?? {};
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts))
    throw new Error("live_catalog_source_selector_manifest_invalid");
  const lifecycle = Object.keys(scripts).filter((name) =>
    /^(?:preinstall|install|postinstall|prepare|prepack|postpack|prepublish|postpublish)$/u.test(
      name,
    ),
  );
  if (
    path === "package.json"
      ? lifecycle.length !== 1 ||
        lifecycle[0] !== "postinstall" ||
        scripts.postinstall !== "pnpm db:generate" ||
        scripts["db:generate"] !==
          "node scripts/run-with-env.mjs pnpm --filter @reviewrouter/platform-db db:generate"
      : lifecycle.length !== 0
  )
    throw new Error("live_catalog_source_selector_lifecycle_hook_denied");
  if (
    path === "packages/platform/db/package.json" &&
    scripts["db:generate"] !== "prisma generate --config prisma.config.ts"
  )
    throw new Error("live_catalog_source_selector_script_chain_invalid");
  for (const command of [
    ...(path === "package.json"
      ? [scripts.postinstall, scripts["db:generate"]]
      : []),
    ...(path === "packages/platform/db/package.json"
      ? [scripts["db:generate"]]
      : []),
  ])
    if (
      typeof command !== "string" ||
      /(?:&&|\|\||[|;&<>`]|\$\{|\$\()/u.test(command)
    )
      throw new Error("live_catalog_source_selector_script_operator_denied");
  return path;
}

export function liveCatalogSourceDependencies(
  inventoryValue,
  path,
  bytes,
  getBytesInput,
) {
  const inventory = parseLiveCatalogSourceInventory(inventoryValue);
  const blobs = new Map(
    inventory.entries
      .filter((entry) => entry.type === "blob")
      .map((entry) => [entry.path, entry]),
  );
  const getBytes =
    typeof getBytesInput === "function"
      ? getBytesInput
      : (dependencyPath) =>
          getBytesInput instanceof Map
            ? getBytesInput.get(dependencyPath)
            : getBytesInput?.[dependencyPath];
  const additions = [...governingManifests(path, blobs)];
  for (const specifier of parseModuleSpecifiers(path, bytes)) {
    assertSupportedSpecifier(specifier);
    if (specifier.startsWith("."))
      additions.push(resolveRelative(path, specifier, blobs));
    else if (!builtinSpecifiers.has(specifier)) {
      const workspace = resolveWorkspacePackage(specifier, blobs, getBytes);
      if (workspace.length) additions.push(...workspace);
      else assertDeclaredExternal(path, specifier, blobs, getBytes);
    }
  }
  return [...new Set(additions)].sort(byteCompare);
}

function assertSourceSelectionBounds(selected, blobs) {
  if (selected.size > LIVE_CATALOG_SOURCE_FETCH_LIMITS.files)
    throw new Error("live_catalog_source_selector_limit_exceeded");
  let bytes = 0;
  for (const path of selected) {
    const size = blobs.get(path)?.size;
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > LIVE_CATALOG_SOURCE_FETCH_LIMITS.fileBytes
    )
      throw new Error("live_catalog_source_selector_limit_exceeded");
    bytes += size;
  }
  if (bytes > LIVE_CATALOG_SOURCE_FETCH_LIMITS.retainedBytes)
    throw new Error("live_catalog_source_selector_limit_exceeded");
}

export function initialLiveCatalogSourceSelection(inventoryValue) {
  const inventory = parseLiveCatalogSourceInventory(inventoryValue);
  const blobs = new Map(
    inventory.entries
      .filter((entry) => entry.type === "blob")
      .map((entry) => [entry.path, entry]),
  );
  for (const path of blobs.keys()) {
    const base = posix.basename(path).toLowerCase();
    if (
      base === ".env" ||
      base === ".env.local" ||
      base === ".npmrc" ||
      base === ".pnpmfile" ||
      base.startsWith(".pnpmfile.")
    )
      throw new Error("live_catalog_source_selector_sensitive_config_denied");
  }
  const selected = new Set(LIVE_CATALOG_SELECTOR_ROOTS);
  for (const path of blobs.keys())
    if (
      path === "package.json" ||
      path.endsWith("/package.json") ||
      path.startsWith("packages/platform/db/prisma/migrations/") ||
      path.startsWith("packages/platform/release-authority-db/migrations/") ||
      path.startsWith("packages/platform/release-authority-db/legacy-catalog/")
    )
      selected.add(path);
  for (const prefix of [
    "packages/platform/db/prisma/migrations/",
    "packages/platform/release-authority-db/migrations/",
    "packages/platform/release-authority-db/legacy-catalog/",
  ])
    if (![...blobs.keys()].some((path) => path.startsWith(prefix)))
      throw new Error("live_catalog_source_selector_migration_root_missing");
  for (const root of selected)
    if (!blobs.has(root))
      throw new Error("live_catalog_source_selector_root_missing");
  assertSourceSelectionBounds(selected, blobs);
  return Object.freeze([...selected].sort(byteCompare));
}

/** Rerunnable installed selection policy. getBytes must return bytes by immutable blob path. */
export function deriveLiveCatalogSourceClosure(inventoryValue, getBytesInput) {
  const inventory = parseLiveCatalogSourceInventory(inventoryValue);
  const blobs = new Map(
    inventory.entries
      .filter((entry) => entry.type === "blob")
      .map((entry) => [entry.path, entry]),
  );
  const getBytes =
    typeof getBytesInput === "function"
      ? getBytesInput
      : (path) =>
          getBytesInput instanceof Map
            ? getBytesInput.get(path)
            : getBytesInput?.[path];
  const selected = new Set(initialLiveCatalogSourceSelection(inventory));
  const queue = [...selected].sort(byteCompare);
  const processed = new Set();
  while (queue.length) {
    const path = queue.shift();
    if (processed.has(path)) continue;
    processed.add(path);
    const bytes = getBytes(path);
    if (
      !bytes ||
      Buffer.from(bytes).length !== blobs.get(path)?.size ||
      gitBlobSha(bytes) !== blobs.get(path)?.sha
    )
      throw new Error("live_catalog_source_selector_blob_invalid");
    if (path.endsWith("package.json")) assertSafeManifest(path, bytes);
    const additions = liveCatalogSourceDependencies(
      inventory,
      path,
      bytes,
      getBytes,
    );
    for (const addition of additions.sort(byteCompare))
      if (!selected.has(addition)) {
        selected.add(addition);
        queue.push(addition);
      }
    assertSourceSelectionBounds(selected, blobs);
  }
  const entries = [...selected].sort(byteCompare).map((path) => {
    const entry = blobs.get(path);
    const bytes = Buffer.from(getBytes(path));
    return Object.freeze({
      path,
      mode: entry.mode,
      gitBlobSha: entry.sha,
      size: entry.size,
      sha256: sha256Digest(bytes),
    });
  });
  const inventoryFacts = liveCatalogSourceInventoryFacts(inventory);
  const closurePayload = {
    selector: LIVE_CATALOG_SOURCE_SELECTOR,
    inventoryDigest: inventoryFacts.digest,
    entries,
  };
  return Object.freeze({
    schemaVersion: LIVE_CATALOG_SOURCE_CLOSURE_SCHEMA,
    ...closurePayload,
    digest: sha256Digest(
      Buffer.from(
        canonicalSourceInventoryJson({
          domain: LIVE_CATALOG_SOURCE_CLOSURE_SCHEMA,
          ...closurePayload,
        }),
      ),
    ),
  });
}
