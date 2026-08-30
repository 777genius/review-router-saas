export const rehearsalSchemaOwnerIdentity = Object.freeze({
  roleName: "reviewrouter_release_schema_owner",
  login: false,
});

export function createRehearsalAuthorityContext({
  providerAdmin,
  bootstrap,
  permitInstaller,
  releaseMigration,
  runtime,
}) {
  const clients = {
    providerAdmin,
    bootstrap,
    permitInstaller,
    releaseMigration,
    api: runtime?.api,
    web: runtime?.web,
    worker: runtime?.worker,
    custody: runtime?.custody,
    effectAuthority: runtime?.effectAuthority,
  };
  for (const [name, client] of Object.entries(clients)) {
    if (!(client instanceof URL)) {
      throw new Error(`rehearsal_authority_client_invalid:${name}`);
    }
  }

  return Object.freeze({
    providerAdmin,
    bootstrap,
    permitInstaller,
    releaseMigration,
    runtime: Object.freeze({
      api: clients.api,
      web: clients.web,
      worker: clients.worker,
      custody: clients.custody,
      effectAuthority: clients.effectAuthority,
    }),
    schemaOwner: rehearsalSchemaOwnerIdentity,
  });
}
