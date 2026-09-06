import { describe, expect, it } from "vitest";
import {
  renderCanonicalCodexRotatingT0WorkflowV1,
  renderCanonicalCodexRotatingT0WorkflowV2,
} from "@reviewrouter/features-codex-oauth-rotating";
import { renderCanonicalHostedPoolWorkflowV2 } from "@reviewrouter/features-workflow-provisioning";
import { classifyHostedPoolSetupSource } from "./hosted-pool-operator-setup-source";
const expected = {
  actionRef: `777genius/review-router@${"a".repeat(40)}`,
  apiUrl: "https://rr.invalid",
  providerInstanceId: "codex-hosted-42",
  bindingId: "binding",
  bindingRevision: 1,
};
describe("setup source migration classification", () => {
  it("recognizes canonical App-first repository-owned input for replacement", () => {
    expect(
      classifyHostedPoolSetupSource(
        renderCanonicalCodexRotatingT0WorkflowV2({
          ...expected,
          refreshScheduleCron: null,
        }),
        expected,
      ),
    ).toBe("repository_owned");
  });
  it("never adopts an old direct/durable-v1 flow", () => {
    expect(() =>
      classifyHostedPoolSetupSource(
        renderCanonicalCodexRotatingT0WorkflowV1({
          ...expected,
          refreshScheduleCron: null,
        }),
        expected,
      ),
    ).toThrow("conflict");
  });
  it("rejects a canonical Hosted workflow for another binding", () => {
    expect(() =>
      classifyHostedPoolSetupSource(
        renderCanonicalHostedPoolWorkflowV2({
          ...expected,
          bindingId: "other",
        }),
        expected,
      ),
    ).toThrow("conflict");
  });
  it("rejects modified repository-owned content and an untrusted old Action ref", () => {
    const native = renderCanonicalCodexRotatingT0WorkflowV2({
      ...expected,
      refreshScheduleCron: null,
    });
    expect(() =>
      classifyHostedPoolSetupSource(
        native.replace("id-token: write", "id-token: read"),
        expected,
      ),
    ).toThrow();
    expect(() =>
      classifyHostedPoolSetupSource(native, {
        ...expected,
        actionRef: `777genius/review-router@${"b".repeat(40)}`,
      }),
    ).toThrow("conflict");
  });
});
