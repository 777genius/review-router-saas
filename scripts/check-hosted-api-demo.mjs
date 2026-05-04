const apiUrl = normalizeUrl(
  process.env.REVIEW_ROUTER_PUBLIC_API_URL ??
    process.env.REVIEW_ROUTER_API_URL ??
    "https://reviewrouter-api.onrender.com",
);

async function fetchJson(path) {
  const response = await fetch(`${apiUrl}${path}`, {
    headers: { accept: "application/json" },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${path} did not return JSON: ${text.slice(0, 120)}`);
  }
  if (!response.ok) {
    throw new Error(
      `${path} failed ${response.status}: ${JSON.stringify(body)}`,
    );
  }
  return body;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeUrl(url) {
  return url.replace(/\/+$/, "");
}

const health = await fetchJson("/health");
assert(health.service === "review-router-api", "health service mismatch");
assert(health.status === "ok", `health is not ok: ${health.status}`);
assert(
  Array.isArray(health.dependencies) &&
    health.dependencies.some(
      (dependency) =>
        dependency.name === "database" && dependency.status === "ok",
    ),
  "database dependency is not ok",
);

const ready = await fetchJson("/ready");
assert(ready.status === "ready", "ready endpoint is not ready");

const demo = await fetchJson("/demo");
assert(demo.product === "ReviewRouter", "demo product mismatch");
assert(demo.status === "demo_ready", "demo status mismatch");
assert(
  demo.executionModel?.reviewRunsIn === "customer_github_actions",
  "demo must state that reviews run in customer GitHub Actions",
);
assert(
  demo.executionModel?.controlPlaneDoesNotStore?.includes(
    "repository source code",
  ),
  "demo must state source code is not stored",
);
assert(
  demo.executionModel?.controlPlaneDoesNotStore?.includes(
    "Codex OAuth auth.json",
  ),
  "demo must state Codex OAuth auth is not stored",
);
assert(
  demo.providers?.every((provider) => provider.sentToSaas === false),
  "demo provider secrets must not be sent to SaaS",
);
assert(
  demo.endpoints?.some(
    (endpoint) => endpoint.path === "/api/action/v1/session/exchange",
  ),
  "demo missing action OIDC exchange endpoint",
);

console.log(
  JSON.stringify(
    {
      apiUrl,
      health: health.status,
      ready: ready.status,
      demo: demo.status,
      model: demo.defaultReviewRuntime?.model,
      effort: demo.defaultReviewRuntime?.effort,
    },
    null,
    2,
  ),
);
