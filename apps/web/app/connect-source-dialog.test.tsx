// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@reviewrouter/ui", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
  DialogBackdrop: ({ children }: { readonly children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogClose: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  DialogDescription: ({ children }: { readonly children: React.ReactNode }) => (
    <p>{children}</p>
  ),
  DialogPopup: ({ children }: { readonly children: React.ReactNode }) => (
    <div role="dialog" aria-label="Add repositories from GitHub or GitLab">
      {children}
    </div>
  ),
  DialogPortal: ({ children }: { readonly children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogRoot: ({ children }: { readonly children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { readonly children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
  DialogTrigger: ({ children }: { readonly children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
  LinkButton: ({
    children,
    href,
    ...props
  }: React.ComponentProps<"a"> & { readonly href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { ConnectSourceDialog } from "./connect-source-dialog";

beforeEach(() => {
  class MockResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }

  vi.stubGlobal("ResizeObserver", MockResizeObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ConnectSourceDialog", () => {
  it("offers GitHub App and GitLab URL onboarding from one entrypoint", () => {
    render(
      <ConnectSourceDialog
        appInstallUrl="https://github.com/apps/reviewrouter/installations/new"
        workspaceId="workspace_1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Connect source" }));

    const dialog = screen.getByRole("dialog", {
      name: "Add repositories from GitHub or GitLab",
    });
    expect(within(dialog).getByText("GitHub")).toBeTruthy();
    expect(within(dialog).getByText("GitLab")).toBeTruthy();
    expect(
      within(dialog)
        .getByRole("link", { name: "Continue with GitHub App" })
        .getAttribute("href"),
    ).toBe("https://github.com/apps/reviewrouter/installations/new");
    expect(
      within(dialog)
        .getByRole("link", { name: "Continue with GitLab" })
        .getAttribute("href"),
    ).toBe("/setup/gitlab?workspaceId=workspace_1");
  });

  it("keeps GitLab available when the GitHub App URL is not configured", () => {
    render(<ConnectSourceDialog appInstallUrl={null} />);

    fireEvent.click(screen.getByRole("button", { name: "Connect source" }));

    const dialog = screen.getByRole("dialog", {
      name: "Add repositories from GitHub or GitLab",
    });
    expect(
      within(dialog).getByText("GitHub App URL is not configured"),
    ).toBeTruthy();
    expect(
      within(dialog)
        .getByRole("link", { name: "Continue with GitLab" })
        .getAttribute("href"),
    ).toBe("/setup/gitlab");
  });
});
