import type {
  ApiDemoDocument,
  ApiDemoIndexDocument,
} from "../domain/api-demo.js";

export function renderApiDemoMarkdown(input: {
  readonly index: ApiDemoIndexDocument;
  readonly demo: ApiDemoDocument;
}): string {
  const { index, demo } = input;
  const quickStart = demo.quickStart
    .map(
      (step) =>
        `${step.order}. **${escapeMarkdown(step.title)}** - ${escapeMarkdown(step.description)}`,
    )
    .join("\n");
  const boundaries = demo.securityBoundaries
    .map(
      (boundary) =>
        `- **${escapeMarkdown(boundary.topic)}**: ${escapeMarkdown(boundary.guarantee)}`,
    )
    .join("\n");
  const samples = demo.sampleRequests
    .map(
      (sample) => `### ${escapeMarkdown(sample.title)}

\`\`\`bash
${sample.command}
\`\`\`

Expected: ${escapeMarkdown(sample.expectedSignal)}`,
    )
    .join("\n\n");
  const limitations = demo.maturity.knownLimitations
    .map((limitation) => `- ${escapeMarkdown(limitation)}`)
    .join("\n");

  return `# ReviewRouter API Demo

${escapeMarkdown(demo.summary)}

## Runtime

- Status: \`${demo.status}\`
- Contract: \`${demo.contractVersion}\`
- Model: \`${demo.defaultReviewRuntime.model}\`
- Effort: \`${demo.defaultReviewRuntime.effort}\`
- Review execution: \`${demo.executionModel.reviewRunsIn}\`

## Quick start

${quickStart}

## Security boundaries

${boundaries}

## API links

- Browser demo: ${index.links.apiDocs}
- JSON demo: ${index.links.demo}
- OpenAPI: ${index.links.openapi}
- Health: ${index.links.health}
- Dashboard: ${index.links.dashboard}

## Try it

${samples}

## Known beta limits

${limitations}
`;
}

function escapeMarkdown(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}
