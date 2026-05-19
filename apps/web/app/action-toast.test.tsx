// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { ActionToast } from "./action-toast";

vi.mock("sonner", () => ({
  toast: {
    custom: vi.fn(),
  },
}));

afterEach(() => {
  vi.clearAllMocks();
  cleanup();
});

describe("ActionToast", () => {
  it("keeps interactive secondary actions mounted until dismissed", async () => {
    render(
      <ActionToast
        tone="success"
        title="Setup PR ready"
        body="Setup PR is ready."
        secondaryAction={<button type="button">Enable review</button>}
      />,
    );

    await waitFor(() => {
      expect(toast.custom).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({ duration: Infinity }),
      );
    });
  });

  it("removes transient search params without a router navigation", async () => {
    window.history.replaceState(
      null,
      "",
      "/dashboard?notice=review_config_saved&version=9&workspace=workspace_1",
    );

    render(
      <ActionToast
        tone="success"
        title="Model settings saved"
        body="Review configuration was saved."
        clearUrlSearchParams={["notice", "version"]}
        setUrlSearchParams={{ section: "policy" }}
      />,
    );

    await waitFor(() => {
      expect(toast.custom).toHaveBeenCalled();
    });

    expect(window.location.pathname).toBe("/dashboard");
    expect(window.location.search).toBe(
      "?workspace=workspace_1&section=policy",
    );
  });
});
