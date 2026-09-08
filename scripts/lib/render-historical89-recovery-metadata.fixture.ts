// TEST ONLY. Call exclusively with catalog output from owned offline PG fixtures.
// Never import into production diagnostics: identities and ACL values are public
// only in this synthetic fixture. No query, command, URL, row or error is emitted.
import { canonicalJson } from "../../packages/features/release-rollout/src/domain/canonical-json";
import { recoveryMetadataDifference } from "./render-historical89-recovery";

export function disposableRecoveryMetadataValues(
  source: string,
  target: string,
) {
  const summary = recoveryMetadataDifference(source, target);
  const a = JSON.parse(source) ?? [],
    b = JSON.parse(target) ?? [];
  const identity = (r: Record<string, unknown>) =>
    canonicalJson([
      r.kind,
      r.schema,
      r.table ?? null,
      r.name ?? null,
      r.type ?? null,
      r.kind === "default" ? r.owner : null,
    ]);
  const left = new Map<string, Record<string, unknown>>(
    a.map((r: Record<string, unknown>) => [identity(r), r]),
  );
  const right = new Map<string, Record<string, unknown>>(
    b.map((r: Record<string, unknown>) => [identity(r), r]),
  );
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort();
  if (
    summary.truncated ||
    summary.differences > 10 ||
    left.size !== a.length ||
    right.size !== b.length
  )
    throw new Error("fixture_metadata_difference_bound");
  return summary.paths.map((path) => {
    const match = /^records\[(\d+)\]\.(acl|definition)$/.exec(path);
    if (!match) throw new Error("fixture_metadata_difference_field");
    const key = keys[Number(match[1])]!,
      x = left.get(key)!,
      y = right.get(key)!;
    const field = match[2]!;
    if (
      !x ||
      !y ||
      x.schema !== "public" ||
      !(
        field === "acl" ? ["object", "default"] : ["constraint", "index"]
      ).includes(String(x.kind))
    )
      throw new Error("fixture_metadata_difference_kind");
    const value = {
      path,
      kind: x.kind,
      schema: x.schema,
      table: x.table ?? null,
      name: x.name ?? null,
      type: x.type ?? null,
      owner: x.owner ?? null,
      field,
      left: x[field] ?? null,
      right: y[field] ?? null,
    };
    if (JSON.stringify(value).length > 8192)
      throw new Error("fixture_metadata_difference_value_bound");
    return value;
  });
}
