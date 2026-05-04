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
  return { body, response };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeUrl(url) {
  return url.replace(/\/+$/, "");
}

const { body: index, response: indexResponse } = await fetchJson("/");
assert(index.product === "ReviewRouter", "index product mismatch");
assert(index.status === "ok", "index status mismatch");
assert(
  indexResponse.headers.get("access-control-allow-origin") === "*",
  "index missing public CORS header",
);
assert(
  indexResponse.headers.get("cache-control") === "no-store",
  "index missing no-store cache header",
);
assert(
  index.links?.demo === `${apiUrl}/demo`,
  "index demo link must point at the configured API URL",
);
assert(
  index.links?.openapi === `${apiUrl}/openapi.json`,
  "index OpenAPI link must point at the configured API URL",
);
assert(
  index.links?.apiDocs === `${apiUrl}/docs`,
  "index API docs link must point at the configured API URL",
);

const { body: health, response: healthResponse } = await fetchJson("/health");
assert(health.service === "review-router-api", "health service mismatch");
assert(health.status === "ok", `health is not ok: ${health.status}`);
assert(
  healthResponse.headers.get("access-control-allow-origin") === "*",
  "health missing public CORS header",
);
assert(
  Array.isArray(health.dependencies) &&
    health.dependencies.some(
      (dependency) =>
        dependency.name === "database" && dependency.status === "ok",
    ),
  "database dependency is not ok",
);

const { body: ready } = await fetchJson("/ready");
assert(ready.status === "ready", "ready endpoint is not ready");

const { body: demo, response: demoResponse } = await fetchJson("/demo");
assert(demo.product === "ReviewRouter", "demo product mismatch");
assert(demo.contractVersion === "2026-05-04", "demo contract mismatch");
assert(demo.status === "demo_ready", "demo status mismatch");
assert(
  demoResponse.headers.get("x-reviewrouter-demo") === "true",
  "demo missing x-reviewrouter-demo header",
);
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
  demo.quickStart?.some(
    (step) =>
      step.title === "Choose provider credentials" &&
      step.description.includes("does not receive"),
  ),
  "demo missing provider credential quick start boundary",
);
assert(
  demo.securityBoundaries?.some(
    (boundary) =>
      boundary.topic === "Runtime access" &&
      boundary.guarantee.includes("OIDC"),
  ),
  "demo missing OIDC runtime access security boundary",
);
assert(
  demo.sampleRequests?.some((request) =>
    request.command.includes(`${apiUrl}/openapi.json`),
  ),
  "demo missing OpenAPI sample request",
);
assert(
  demo.sampleRequests?.some((request) =>
    request.command.includes(`${apiUrl}/docs`),
  ),
  "demo missing browser docs sample request",
);
assert(
  demo.endpoints?.some(
    (endpoint) => endpoint.path === "/api/action/v1/session/exchange",
  ),
  "demo missing action OIDC exchange endpoint",
);

const optionsResponse = await fetch(`${apiUrl}/demo`, { method: "OPTIONS" });
assert(optionsResponse.status === 204, "demo OPTIONS must return 204");
assert(
  optionsResponse.headers.get("access-control-allow-origin") === "*",
  "demo OPTIONS missing public CORS header",
);
assert(
  optionsResponse.headers.get("access-control-allow-methods")?.includes("GET"),
  "demo OPTIONS missing GET allow-method",
);

const { body: openapi } = await fetchJson("/openapi.json");
assert(openapi.openapi === "3.1.0", "OpenAPI version mismatch");
assert(openapi.info?.title === "ReviewRouter API", "OpenAPI title mismatch");
assert(openapi.info?.version === "2026-05-04", "OpenAPI version mismatch");
assert(
  openapi.servers?.[0]?.url === apiUrl,
  "OpenAPI server URL must match configured API URL",
);
assert(openapi.paths?.["/demo"], "OpenAPI missing /demo path");
assert(
  openapi.paths?.["/api/action/v1/session/exchange"],
  "OpenAPI missing action exchange path",
);
assert(openapi.paths?.["/docs"], "OpenAPI missing /docs path");
assert(openapi.components?.schemas?.ApiDemo, "OpenAPI missing ApiDemo schema");
assert(
  openapi.paths?.["/demo"]?.get?.responses?.["200"]?.content?.[
    "application/json"
  ]?.schema?.$ref === "#/components/schemas/ApiDemo",
  "OpenAPI /demo response must reference ApiDemo schema",
);

const docsResponse = await fetch(`${apiUrl}/docs`, {
  headers: { accept: "text/html" },
});
const docsBody = await docsResponse.text();
assert(docsResponse.ok, `/docs failed ${docsResponse.status}`);
assert(
  docsResponse.headers.get("content-type")?.includes("text/html"),
  "/docs must return text/html",
);
assert(
  docsResponse.headers.get("access-control-allow-origin") === "*",
  "/docs missing public CORS header",
);
assert(
  docsBody.includes("<title>ReviewRouter API Demo</title>"),
  "/docs missing page title",
);
assert(docsBody.includes("Quick start"), "/docs missing quick start section");
assert(
  docsBody.includes("Security boundaries"),
  "/docs missing security boundaries section",
);

console.log(
  JSON.stringify(
    {
      apiUrl,
      index: index.status,
      health: health.status,
      ready: ready.status,
      demo: demo.status,
      openapi: openapi.info?.version,
      docs: "ok",
      model: demo.defaultReviewRuntime?.model,
      effort: demo.defaultReviewRuntime?.effort,
    },
    null,
    2,
  ),
);
