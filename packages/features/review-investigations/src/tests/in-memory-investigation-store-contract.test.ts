import { defineInvestigationStoreContract } from "../testing/investigation-store-contract";
import { InMemoryInvestigationStore } from "../infrastructure/memory/in-memory-investigation-store";

defineInvestigationStoreContract("InMemoryInvestigationStore", async () => {
  const store = new InMemoryInvestigationStore();
  return {
    store,
    async restart() {
      return InMemoryInvestigationStore.fromSnapshot(store.exportSnapshot());
    },
    async dispose() {},
  };
});
