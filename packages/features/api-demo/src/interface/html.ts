import type {
  ApiDemoDocument,
  ApiDemoIndexDocument,
} from "../domain/api-demo.js";

export function renderApiDemoHtml(input: {
  readonly index: ApiDemoIndexDocument;
  readonly demo: ApiDemoDocument;
}): string {
  const { index, demo } = input;
  const quickStart = demo.quickStart
    .map(
      (step) => `
        <li>
          <span class="step">${step.order}</span>
          <div>
            <strong>${escapeHtml(step.title)}</strong>
            <p>${escapeHtml(step.description)}</p>
          </div>
        </li>`,
    )
    .join("");
  const boundaries = demo.securityBoundaries
    .map(
      (boundary) => `
        <article class="card">
          <h3>${escapeHtml(boundary.topic)}</h3>
          <p>${escapeHtml(boundary.guarantee)}</p>
        </article>`,
    )
    .join("");
  const samples = demo.sampleRequests
    .map(
      (sample) => `
        <article class="command-card">
          <h3>${escapeHtml(sample.title)}</h3>
          <pre><code>${escapeHtml(sample.command)}</code></pre>
          <p>${escapeHtml(sample.expectedSignal)}</p>
        </article>`,
    )
    .join("");
  const limitations = demo.maturity.knownLimitations
    .map((limitation) => `<li>${escapeHtml(limitation)}</li>`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ReviewRouter API Demo</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #06070d;
      --panel: rgba(16, 24, 39, 0.78);
      --panel-strong: rgba(20, 32, 54, 0.94);
      --line: rgba(125, 249, 255, 0.24);
      --text: #edf7ff;
      --muted: #9eb3c7;
      --cyan: #79f7ff;
      --green: #8bffb0;
      --pink: #ff5ec4;
      font-family: "Space Grotesk", "Sora", ui-sans-serif, system-ui, sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(121, 247, 255, 0.20), transparent 34rem),
        radial-gradient(circle at bottom right, rgba(255, 94, 196, 0.18), transparent 30rem),
        linear-gradient(135deg, #05060b 0%, #0a1020 55%, #05060b 100%);
    }
    main { width: min(1120px, calc(100% - 32px)); margin: 0 auto; padding: 64px 0; }
    .hero {
      border: 1px solid var(--line);
      background: linear-gradient(135deg, rgba(16, 24, 39, 0.86), rgba(6, 7, 13, 0.76));
      border-radius: 28px;
      padding: clamp(28px, 5vw, 56px);
      box-shadow: 0 24px 90px rgba(0, 0, 0, 0.45);
      position: relative;
      overflow: hidden;
    }
    .hero:after {
      content: "";
      position: absolute;
      inset: auto -20% -55% 24%;
      height: 240px;
      background: linear-gradient(90deg, transparent, rgba(121, 247, 255, 0.20), transparent);
      transform: rotate(-8deg);
    }
    .eyebrow { color: var(--green); letter-spacing: .18em; text-transform: uppercase; font-size: 12px; }
    h1 { font-size: clamp(42px, 8vw, 92px); line-height: .9; margin: 16px 0; max-width: 900px; }
    h2 { font-size: clamp(28px, 4vw, 44px); margin: 0 0 18px; }
    h3 { margin: 0 0 10px; }
    p { color: var(--muted); line-height: 1.65; }
    a { color: var(--cyan); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .pill-row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 26px; }
    .pill {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 9px 13px;
      background: rgba(121, 247, 255, 0.08);
      color: var(--text);
      font-size: 14px;
    }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; margin-top: 22px; }
    .card, .command-card, .panel {
      border: 1px solid var(--line);
      border-radius: 22px;
      background: var(--panel);
      padding: 22px;
      backdrop-filter: blur(12px);
    }
    section { margin-top: 28px; }
    ol { list-style: none; padding: 0; margin: 0; display: grid; gap: 14px; }
    li { display: flex; gap: 14px; align-items: flex-start; }
    .step {
      width: 34px;
      height: 34px;
      border-radius: 12px;
      display: inline-grid;
      place-items: center;
      flex: 0 0 auto;
      color: #061017;
      background: var(--cyan);
      font-weight: 800;
    }
    pre {
      overflow-x: auto;
      margin: 0 0 12px;
      padding: 16px;
      border-radius: 16px;
      background: #050810;
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    code { color: var(--green); font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 13px; }
    .links { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 20px; }
    .button {
      display: inline-flex;
      align-items: center;
      border-radius: 14px;
      padding: 12px 16px;
      background: var(--panel-strong);
      border: 1px solid var(--line);
      font-weight: 700;
    }
    .warning { border-color: rgba(255, 94, 196, 0.35); }
    @media (max-width: 760px) {
      main { padding: 28px 0; }
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <div class="eyebrow">${escapeHtml(index.status)} - ${escapeHtml(demo.maturity.stage)}</div>
      <h1>ReviewRouter API Demo</h1>
      <p>${escapeHtml(demo.summary)}</p>
      <div class="pill-row">
        <span class="pill">Model: ${escapeHtml(demo.defaultReviewRuntime.model)}</span>
        <span class="pill">Effort: ${escapeHtml(demo.defaultReviewRuntime.effort)}</span>
        <span class="pill">Runtime: ${escapeHtml(demo.executionModel.reviewRunsIn)}</span>
        <span class="pill">Contract: ${escapeHtml(demo.contractVersion)}</span>
      </div>
      <div class="links">
        <a class="button" href="${escapeAttribute(index.links.dashboard)}">Dashboard</a>
        <a class="button" href="${escapeAttribute(index.links.demo)}">JSON demo</a>
        <a class="button" href="${escapeAttribute(index.links.openapi)}">OpenAPI</a>
        <a class="button" href="${escapeAttribute(index.links.health)}">Health</a>
      </div>
    </section>

    <section class="panel">
      <h2>Quick start</h2>
      <ol>${quickStart}</ol>
    </section>

    <section>
      <h2>Security boundaries</h2>
      <div class="grid">${boundaries}</div>
    </section>

    <section>
      <h2>Try the API</h2>
      <div class="grid">${samples}</div>
    </section>

    <section class="panel warning">
      <h2>Known beta limits</h2>
      <ul>${limitations}</ul>
    </section>
  </main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}
