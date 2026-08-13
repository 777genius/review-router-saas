import { parseSourceWriterServiceIds } from "./lib/source-writer-service-ids";

export const parseCompensationSourceWriterServiceIds = (
  encoded: string,
): readonly string[] => parseSourceWriterServiceIds(encoded);
