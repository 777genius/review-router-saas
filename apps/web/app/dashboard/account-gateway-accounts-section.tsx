import { loadAccountsBootstrap } from "../../src/server/account-gateway-accounts";
import { AccountGatewayControls } from "./account-gateway-account-controls";

export async function AccountGatewayAccountsSection({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const bootstrap = await loadAccountsBootstrap(workspaceId);
  return (
    <section
      className="space-y-4 border-b border-cyan-200/10 pb-6"
      aria-labelledby="gateway-accounts-title"
    >
      <div>
        <h3
          id="gateway-accounts-title"
          className="text-lg font-semibold text-cyan-50"
        >
          Workspace accounts
        </h3>
        <p className="mt-2 text-sm text-slate-400">
          Connect a MiMo or OpenRouter key, or enroll Codex when OAuth is
          enabled for this workspace. Workspace admins can manage these
          accounts. Credentials are stored on our server and are never returned
          here or copied to repository secrets.
        </p>
        <p className="mt-2 text-sm text-slate-400">
          Codex authorization opens once after a fresh enrollment. Enrollment
          remains pending until the gateway confirms an active account.
        </p>
      </div>
      <AccountGatewayControls
        key={bootstrap.context || workspaceId}
        bootstrap={bootstrap}
      />
    </section>
  );
}
