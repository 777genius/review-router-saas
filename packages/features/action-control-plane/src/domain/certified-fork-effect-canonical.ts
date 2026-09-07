import { createHash } from "node:crypto";
import { types } from "node:util";
type Json = null | string | number | boolean | Json[] | { [key: string]: Json };
export type Parser<T> = (value: unknown) => T;
export function requireFact(condition: unknown): asserts condition {
  if (!condition) throw new Error("certified_fork_effect_contract_rejected");
}
function data(value: object, expected?: readonly string[]) {
  requireFact(!types.isProxy(value));
  const keys = Reflect.ownKeys(value);
  requireFact(keys.length <= (expected?.length ?? 256));
  const allowed = expected && new Set(expected);
  requireFact(
    (!expected || keys.length === expected.length) &&
      keys.every(
        (key) =>
          typeof key === "string" &&
          (allowed ? allowed.has(key) : /^[A-Za-z][A-Za-z0-9]*$/u.test(key)),
      ),
  );
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) {
    requireFact("value" in descriptor);
  }
  return descriptors;
}
export function record<S extends Record<string, Parser<unknown>>>(shape: S) {
  return (value: unknown): { readonly [K in keyof S]: ReturnType<S[K]> } => {
    requireFact(typeof value === "object" && value !== null);
    const keys = Object.keys(shape).sort();
    const descriptors = data(value, keys);
    requireFact(Object.getPrototypeOf(value) === Object.prototype);
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      requireFact(descriptors[key]?.enumerable);
      result[key] = shape[key]!(descriptors[key]!.value);
    }
    return Object.freeze(result) as {
      readonly [K in keyof S]: ReturnType<S[K]>;
    };
  };
}
export function list<T>(parse: Parser<T>): Parser<readonly T[]> {
  return (value) => {
    requireFact(typeof value === "object" && value !== null);
    requireFact(!types.isProxy(value));
    requireFact(
      Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype,
    );
    requireFact(value.length <= 256);
    const descriptors = data(value, [
      "length",
      ...Array.from({ length: value.length }, (_, i) => String(i)),
    ]);
    const result: T[] = [];
    for (let i = 0; i < value.length; i++) {
      requireFact(descriptors[String(i)]?.enumerable);
      result.push(parse(descriptors[String(i)]!.value));
    }
    return Object.freeze(result);
  };
}
export function choice<const T extends readonly string[]>(
  ...allowed: T
): Parser<T[number]> {
  return (value) => {
    requireFact(typeof value === "string" && allowed.includes(value));
    return value as T[number];
  };
}
function text(pattern: RegExp): Parser<string> {
  return (value) => {
    requireFact(typeof value === "string" && pattern.test(value));
    return value;
  };
}
export const hash = text(/^[a-f0-9]{64}$/u);
export const sha = text(/^[a-f0-9]{40}$/u);
export const opaqueId = text(/^[A-Za-z0-9_-]{1,64}$/u);
export const counter = text(/^(0|[1-9][0-9]{0,17})$/u);
export const positive: Parser<number> = (value) => {
  requireFact(
    typeof value === "number" && Number.isSafeInteger(value) && value > 0,
  );
  return value;
};
export function nullable<T>(parse: Parser<T>): Parser<T | null> {
  return (value) => (value === null ? null : parse(value));
}
export function next(value: string) {
  return counter(String(BigInt(value) + 1n));
}
export function set<T>(
  items: readonly T[],
  key: (item: T) => string,
): readonly T[] {
  const sorted = [...items].sort((a, b) =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0,
  );
  requireFact(
    sorted.every((item, i) => i === 0 || key(item) !== key(sorted[i - 1]!)),
  );
  return Object.freeze(sorted);
}
function canonical(value: unknown): Json {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    requireFact(Number.isSafeInteger(value) && !Object.is(value, -0));
    return value;
  }
  requireFact(
    typeof value === "object" && value !== null && !types.isProxy(value),
  );
  if (Array.isArray(value)) return [...list(canonical)(value)];
  const descriptors = data(value);
  requireFact(Object.getPrototypeOf(value) === Object.prototype);
  const result: Record<string, Json> = {};
  for (const key of Object.keys(descriptors).sort()) {
    requireFact(
      /^[A-Za-z][A-Za-z0-9]*$/u.test(key) && descriptors[key]!.enumerable,
    );
    result[key] = canonical(descriptors[key]!.value);
  }
  return result;
}
export function fingerprint(tag: string, value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical({ tag, version: 1, value })))
    .digest("hex");
}
const artifacts = new Map<string, WeakSet<object>>();
export function artifact<T extends object>(
  kind: string,
  value: T,
): Readonly<T> {
  // Detach every nested record and ordered array, then freeze recursively.
  const freeze = (item: Json): Json => {
    if (item !== null && typeof item === "object") {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
    return item;
  };
  const result = freeze(canonical(value)) as T;
  let registry = artifacts.get(kind);
  if (!registry) {
    registry = new WeakSet();
    artifacts.set(kind, registry);
  }
  const inherit = (original: unknown, copy: unknown): void => {
    if (
      original === null ||
      typeof original !== "object" ||
      copy === null ||
      typeof copy !== "object"
    )
      return;
    for (const registered of artifacts.values())
      if (registered.has(original)) registered.add(copy);
    for (const key of Object.keys(copy))
      inherit(
        (original as Record<string, unknown>)[key],
        (copy as Record<string, unknown>)[key],
      );
  };
  inherit(value, result);
  registry.add(result);
  return result;
}
export function authentic<T extends object>(kind: string, value: T): T {
  requireFact(
    typeof value === "object" &&
      value !== null &&
      artifacts.get(kind)?.has(value),
  );
  return value;
}
