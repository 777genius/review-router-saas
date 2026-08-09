import { describe, expect, it } from "vitest";
import {
  assertCodexRotatingNewWorkAdmitted,
  normalizeApprovedRepositories,
} from "../domain/codex-rotating-new-work-admission.js";

describe("Codex rotating new-work admission", () => {
  it.each([undefined, "", "0", "true", "01", " 1"])(
    "fails closed for non-exact enabled value %s",
    (enabledValue) => {
      expect(() =>
        assertCodexRotatingNewWorkAdmitted({
          enabledValue,
          approvedRepositories: ["owner/repo"],
          repositoryFullName: "owner/repo",
        }),
      ).toThrow("codex_rotating_new_work_admission_closed");
    },
  );

  it("requires a nonempty explicit approved cohort", () => {
    expect(() =>
      assertCodexRotatingNewWorkAdmitted({
        enabledValue: "1",
        approvedRepositories: [],
        repositoryFullName: "owner/repo",
      }),
    ).toThrow("codex_rotating_new_work_cohort_required");
  });

  it("admits only an exact normalized cohort member", () => {
    expect(() =>
      assertCodexRotatingNewWorkAdmitted({
        enabledValue: "1",
        approvedRepositories: normalizeApprovedRepositories([
          " Owner/Repo ",
          "owner/repo",
        ]),
        repositoryFullName: "OWNER/REPO",
      }),
    ).not.toThrow();
    expect(() =>
      assertCodexRotatingNewWorkAdmitted({
        enabledValue: "1",
        approvedRepositories: ["owner/other"],
        repositoryFullName: "owner/repo",
      }),
    ).toThrow("codex_rotating_new_work_repository_not_approved");
  });
});
