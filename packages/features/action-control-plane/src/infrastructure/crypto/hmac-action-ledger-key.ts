import { createHmac } from "node:crypto";
import type {
  ActionLedgerKeyInput,
  ActionLedgerKeyPort,
} from "../../application/ports/action-ledger-key-port.js";

export class HmacActionLedgerKey implements ActionLedgerKeyPort {
  constructor(private readonly secret: string) {
    if (secret.length < 32) {
      throw new Error("action_ledger_key_secret_too_short");
    }
  }

  deriveLedgerKey(input: ActionLedgerKeyInput): string {
    return createHmac("sha256", this.secret)
      .update("reviewrouter-ledger:v1")
      .update("\0")
      .update(input.workspaceId)
      .update("\0")
      .update(input.repositoryId)
      .update("\0")
      .update(input.githubRepositoryId)
      .update("\0")
      .update(input.repositoryFullName)
      .digest("hex");
  }
}
