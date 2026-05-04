import type { Clock } from "@reviewrouter/shared";
import {
  buildApiDemoIndex,
  buildApiDemoDocument,
  buildApiDemoOpenApiDocument,
  type ApiDemoDocument,
  type ApiDemoIndexDocument,
} from "../domain/api-demo.js";

export type GetApiDemoInput = {
  readonly clock: Clock;
  readonly webUrl?: string;
  readonly apiUrl?: string;
  readonly actionVersion?: string;
  readonly model?: string;
  readonly effort?: string;
};

export function getApiDemoIndex(
  input: Pick<GetApiDemoInput, "webUrl" | "apiUrl">,
): ApiDemoIndexDocument {
  const urls = resolveUrls(input);
  return buildApiDemoIndex(urls);
}

export function getApiDemo(input: GetApiDemoInput): ApiDemoDocument {
  const urls = resolveUrls(input);
  return buildApiDemoDocument({
    checkedAt: input.clock.now(),
    webUrl: urls.webUrl,
    apiUrl: urls.apiUrl,
    actionVersion: input.actionVersion ?? "main",
    model: input.model ?? "gpt-5.5",
    effort: input.effort ?? "medium",
  });
}

export function getApiDemoOpenApi(
  input: Pick<GetApiDemoInput, "webUrl" | "apiUrl">,
): Record<string, unknown> {
  const urls = resolveUrls(input);
  return buildApiDemoOpenApiDocument({ apiUrl: urls.apiUrl });
}

function resolveUrls(input: Pick<GetApiDemoInput, "webUrl" | "apiUrl">): {
  readonly webUrl: string;
  readonly apiUrl: string;
} {
  return {
    webUrl: normalizeUrl(input.webUrl ?? "https://reviewrouter.site"),
    apiUrl: normalizeUrl(input.apiUrl ?? "https://api.reviewrouter.site"),
  };
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}
