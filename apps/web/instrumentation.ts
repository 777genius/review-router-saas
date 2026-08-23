/** Next.js invokes this once while booting the server runtime. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertHostedCodexProductionReadiness } =
    await import("@reviewrouter/platform-config");
  assertHostedCodexProductionReadiness(process.env, "web");
}
