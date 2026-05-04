import type { Clock } from "@reviewrouter/shared";
import {
  buildApiDemoDocument,
  type ApiDemoDocument,
} from "../domain/api-demo.js";

export type GetApiDemoInput = {
  readonly clock: Clock;
  readonly webUrl?: string;
  readonly apiUrl?: string;
  readonly actionVersion?: string;
  readonly model?: string;
  readonly effort?: string;
};

export function getApiDemo(input: GetApiDemoInput): ApiDemoDocument {
  return buildApiDemoDocument({
    checkedAt: input.clock.now(),
    webUrl: normalizeUrl(
      input.webUrl ?? "https://reviewrouter-web.onrender.com",
    ),
    apiUrl: normalizeUrl(
      input.apiUrl ?? "https://reviewrouter-api.onrender.com",
    ),
    actionVersion: input.actionVersion ?? "main",
    model: input.model ?? "gpt-5.5",
    effort: input.effort ?? "medium",
  });
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}
