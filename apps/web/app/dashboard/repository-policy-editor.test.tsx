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
    badge: "FREE RECOMMENDED" as const,
  },
  {
    value: "anthropic/claude-sonnet-4.5",
    label: "Anthropic: Claude Sonnet 4.5",
    provider: "openrouter" as const,
    description:
      "anthropic/claude-sonnet-4.5 - $3.00/$15.00 per 1M input/output",
    badge: "PAID" as const,
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
      screen.getAllByRole("combobox", { name: "Provider auth" }),
    ).toHaveLength(2);
    expect(
      (screen.getAllByRole("textbox", { name: "Model" })[1] as HTMLInputElement)
        .value,
    ).toBe("poolside/laguna-m.1:free");
    expect(screen.getAllByText("FREE RECOMMENDED").length).toBeGreaterThan(0);
    expect(
      (
        screen.getAllByRole("button", {
          name: "Remove",
        })[1] as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("filters model options by selected provider", () => {
    renderReviewConfigForm();

    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    fireEvent.click(
      screen.getAllByRole("button", { name: "Open model options" })[0]!,
    );

    expect(screen.getByRole("option", { name: /gpt-5\.5/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Poolside/ })).toBeNull();
  });

  it("allows paid model options when they match the typed search", () => {
    renderReviewConfigForm();

    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    const modelInput = screen.getAllByRole("textbox", {
      name: "Model",
    })[1] as HTMLInputElement;
    modelInput.focus();
    fireEvent.change(modelInput, { target: { value: "anthropic" } });

    const listbox = screen.getByRole("listbox");
    const paidOption = within(listbox).getByRole("option", {
      name: /Anthropic: Claude/,
    });
    expect(paidOption).toHaveProperty("disabled", false);
    expect(
      within(listbox).queryByRole("option", { name: /Poolside/ }),
    ).toBeNull();

    fireEvent.click(paidOption);
    expect(
      (screen.getAllByRole("textbox", { name: "Model" })[1] as HTMLInputElement)
        .value,
    ).toBe("anthropic/claude-sonnet-4.5");
  });

  it("filters model options by typed model text while keeping custom input", () => {
    renderReviewConfigForm();

    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    const modelInput = screen.getAllByRole("textbox", {
      name: "Model",
    })[1] as HTMLInputElement;
    modelInput.focus();
    fireEvent.change(modelInput, { target: { value: "anthropic" } });

    const listbox = screen.getByRole("listbox");
    expect(
      within(listbox).getByRole("option", { name: /Anthropic: Claude/ }),
    ).toBeTruthy();
    expect(
      within(listbox).queryByRole("option", { name: /Poolside/ }),
    ).toBeNull();

    fireEvent.change(modelInput, { target: { value: "custom/new-model" } });

    expect(modelInput.value).toBe("custom/new-model");
    expect(screen.getByText(/custom model value will be saved/i)).toBeTruthy();
  });

  it("allows custom model text", () => {
    renderReviewConfigForm();

    const modelInput = screen.getByRole("textbox", {
      name: "Model",
    }) as HTMLInputElement;
    modelInput.focus();
    fireEvent.change(modelInput, { target: { value: "custom/model-1" } });

    const updatedModelInput = screen.getByRole("textbox", {
      name: "Model",
    }) as HTMLInputElement;
    expect(document.activeElement).toBe(updatedModelInput);

    fireEvent.change(updatedModelInput, {
      target: { value: "custom/model-123" },
    });

    expect(updatedModelInput.value).toBe("custom/model-123");
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
