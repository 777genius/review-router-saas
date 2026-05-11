export interface MemoryIdGeneratorPort {
  newId(prefix: "mem" | "mem_suggestion"): string;
}
