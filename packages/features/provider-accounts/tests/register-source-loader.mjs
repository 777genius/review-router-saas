import { registerHooks } from "node:module";

// Node 24 strips types. Resolve RR's extensionless source imports without an
// install. Isolate the actual exported auth use-case from unrelated auth adapters
// (crypto/SCM dependencies); no auth implementation is mocked or reimplemented.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@reviewrouter/features-auth") {
      return nextResolve(
        new URL(
          "../../auth/src/application/use-cases/assert-workspace-admin-allowed.ts",
          import.meta.url,
        ).href,
        context,
      );
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error.code === "ERR_MODULE_NOT_FOUND" &&
        specifier.startsWith(".") &&
        !/\.[a-z]+$/.test(specifier)
      ) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});
