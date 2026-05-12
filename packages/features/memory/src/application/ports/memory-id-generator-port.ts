export interface MemoryIdGeneratorPort {
  newId(prefix: "mem" | "mem_suggestion" | "mem_usage"): string;
}
