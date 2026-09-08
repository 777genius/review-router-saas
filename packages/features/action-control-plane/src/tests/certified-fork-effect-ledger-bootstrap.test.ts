import { describe, expect, it, vi } from "vitest";
import {
  captureForkInput,
  commandHash,
  inactive,
  ready,
  validateForkCommand,
  type ForkBoundary,
} from "../application/services/certified-fork-effect-ledger.js";
import type { ForkLedgerInput } from "../application/ports/certified-fork-effect-repository-port.js";

// Temporary PR1 bootstrap; remove after the complete PR4 security suites land.
describe("certified fork effect ledger bootstrap", () => {
  it("captures detached, deeply frozen nested records and arrays", () => {
    const source = { nested: { items: [{ value: "original" }] } };
    const copy = captureForkInput(source);
    expect(copy).toEqual(source);
    expect(copy).not.toBe(source);
    expect(copy.nested).not.toBe(source.nested);
    expect(copy.nested.items).not.toBe(source.nested.items);
    expect(copy.nested.items[0]).not.toBe(source.nested.items[0]);
    for (const value of [
      copy,
      copy.nested,
      copy.nested.items,
      copy.nested.items[0],
    ])
      expect(Object.isFrozen(value)).toBe(true);
    source.nested.items[0]!.value = "changed";
    source.nested.items.push({ value: "later" });
    expect(copy).toEqual({ nested: { items: [{ value: "original" }] } });
  });

  it("rejects accessor descriptors without invoking their getters", () => {
    const getter = vi.fn(() => "unexpected");
    const input = Object.defineProperty({}, "value", {
      get: getter,
      enumerable: true,
    });
    expect(() => captureForkInput(input)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it("distinguishes disabled and incomplete boundaries without dependency calls", () => {
    const access = vi.fn(() => {
      throw new Error("dependency accessed");
    });
    const dependency = new Proxy({}, { get: access });
    const deps: ForkBoundary = {
      repository: dependency as ForkBoundary["repository"],
      proofs: dependency as ForkBoundary["proofs"],
    };
    const disabled = { ...deps, enabled: false, ownerProof: "owner" };
    const incomplete = { ...deps, enabled: true };
    expect(ready(disabled)).toBeNull();
    expect(inactive(disabled)).toEqual({ status: "disabled" });
    expect(ready(incomplete)).toBeNull();
    expect(inactive(incomplete)).toEqual({ status: "missing_dependencies" });
    expect(access).not.toHaveBeenCalled();
  });

  it("separates seal and stop hashes and rejects invalid stop reasons", () => {
    const effectKey = "a".repeat(64);
    expect(commandHash("seal", { effectKey })).not.toBe(
      commandHash("stop", { effectKey }),
    );
    const stop: ForkLedgerInput = {
      kind: "stop",
      effectKey,
      reason: "cancelled",
    };
    expect(() => validateForkCommand(stop)).not.toThrow();
    const invalid = {
      ...stop,
      reason: "invalid",
    } as unknown as ForkLedgerInput;
    expect(() => validateForkCommand(invalid)).toThrow();
  });
});
