import { describe, expect, it } from "vitest";
import type { AuditLogRepositoryPort } from "../application/ports/audit-log-repository-port.js";
import { recordAuditEvent } from "../application/use-cases/record-audit-event.js";
import type { AuditEventInput } from "../domain/audit-event.js";

class InMemoryAuditLog implements AuditLogRepositoryPort {
  public readonly events: AuditEventInput[] = [];

  async append(event: AuditEventInput): Promise<void> {
    this.events.push(event);
  }
}

describe("audit log", () => {
  it("records sanitized audit metadata", async () => {
    const auditLog = new InMemoryAuditLog();

    await recordAuditEvent(
      {
        workspaceId: "workspace_1",
        actor: "system:workflow-provisioning",
        action: "workflow.setup_pr_opened",
        targetType: "repository",
        targetId: "repo_1",
        metadata: { pullRequestNumber: 1, branch: "reviewrouter/setup" },
      },
      { auditLog },
    );

    expect(auditLog.events).toHaveLength(1);
    expect(auditLog.events[0]).toMatchObject({
      action: "workflow.setup_pr_opened",
      metadata: { pullRequestNumber: 1 },
    });
  });

  it("rejects secret-like and code-like metadata", async () => {
    const auditLog = new InMemoryAuditLog();

    await expect(
      recordAuditEvent(
        {
          workspaceId: "workspace_1",
          actor: "support:agent",
          action: "support.viewed_repository",
          targetType: "repository",
          targetId: "repo_1",
          metadata: { value: "OPENAI_API_KEY=sk-secretsecretsecretsecret" },
        },
        { auditLog },
      ),
    ).rejects.toThrow("audit_metadata_contains_secret");

    await expect(
      recordAuditEvent(
        {
          workspaceId: "workspace_1",
          actor: "support:agent",
          action: "support.viewed_repository",
          targetType: "repository",
          targetId: "repo_1",
          metadata: { value: "```ts\nconsole.log('code')\n```" },
        },
        { auditLog },
      ),
    ).rejects.toThrow("audit_metadata_contains_code_or_diff");
  });
});
