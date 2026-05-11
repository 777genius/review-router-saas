// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { safeDefaultReviewConfiguration } from "@reviewrouter/features-review-config";
import { ReviewConfigForm } from "./repository-policy-editor";

const modelOptions = [
  {
    value: "gpt-5.5",
    label: "gpt-5.5",
    provider: "codex" as const,
    description: "Codex default model.",
  },
  {
    value: "poolside/laguna-m.1:free",
    label: "Poolside: Laguna M.1",
    provider: "openrouter" as const,
    description: "poolside/laguna-m.1:free - $0/$0 per 1M - 131K context",
    badge: "FREE" as const,
  },
  {
    value: "anthropic/claude-sonnet-4.5",
    label: "Anthropic: Claude Sonnet 4.5",
    provider: "openrouter" as const,
    description:
      "anthropic/claude-sonnet-4.5 - $3.00/$15.00 per 1M input/output",
    badge: "PAID" as const,
    disabled: true,
  },
];

afterEach(() => {
  cleanup();
});

describe("ReviewConfigForm", () => {
  it("keeps at least one provider and adds an OpenRouter provider", () => {
    renderReviewConfigForm();

    expect(
      (screen.getByRole("button", { name: "Remove" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));

    expect(screen.getByText("Provider 2")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Poolside: Laguna M\.1/ }),
    ).toBeTruthy();
    expect(screen.getAllByText("FREE").length).toBeGreaterThan(0);
    expect(
      (
        screen.getAllByRole("button", {
          name: "Remove",
        })[1] as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("filters model options by selected provider and disables paid options", () => {
    renderReviewConfigForm();

    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    fireEvent.click(screen.getByRole("button", { name: /gpt-5\.5/ }));

    expect(screen.getByRole("option", { name: /gpt-5\.5/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Poolside/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /gpt-5\.5/ }));
    fireEvent.click(screen.getByRole("button", { name: /Poolside/ }));

    const listbox = screen.getByRole("listbox");
    expect(
      within(listbox).getByRole("option", { name: /Poolside/ }),
    ).toBeTruthy();
    expect(
      within(listbox).getByRole("option", { name: /Anthropic: Claude/ }),
    ).toHaveProperty("disabled", true);
  });
});

function renderReviewConfigForm(): void {
  render(
    <ReviewConfigForm
      action={() => undefined}
      config={safeDefaultReviewConfiguration}
      modelOptions={modelOptions}
      hiddenFields={[{ name: "workspaceId", value: "workspace_1" }]}
      mutationsEnabled={true}
      submitLabel="Save workspace default"
    />,
  );
}
