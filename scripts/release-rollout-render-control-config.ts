import { parseSourceWriterServiceIds } from "./lib/source-writer-service-ids";

export const parseFreezeSourceWriterServiceIds = (
  encoded: string,
): readonly string[] => parseSourceWriterServiceIds(encoded);
