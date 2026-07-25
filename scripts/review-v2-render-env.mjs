export const reviewV2ContextApiEnvKeys = Object.freeze([
  "REVIEW_ROUTER_REVIEW_V2_CONTEXT_SESSION_SECRET_BASE64",
  "REVIEW_ROUTER_REVIEW_V2_CONTEXT_REPLAY_ACTIVE_KEY_ID",
  "REVIEW_ROUTER_REVIEW_V2_CONTEXT_REPLAY_KEYS_JSON",
]);

export const reviewV2ContextWorkerEnvKeys = Object.freeze([]);

export function reviewV2ContextEnvForRole(env, role) {
  const keys =
    role === "api"
      ? reviewV2ContextApiEnvKeys
      : role === "worker"
        ? reviewV2ContextWorkerEnvKeys
        : [];
  return Object.fromEntries(
    keys.flatMap((key) => {
      const value = env[key];
      return value === undefined || String(value).trim() === ""
        ? []
        : [[key, String(value)]];
    }),
  );
}
