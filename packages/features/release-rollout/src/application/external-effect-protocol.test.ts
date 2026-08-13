import { describe, expect, it, vi } from "vitest";
import {
  ExternalEffectDispatchUseCase,
  ExternalEffectReconciliationUseCase,
} from "./external-effect-protocol";
import type { ExternalEffectRecord } from "../domain/external-effect";

const prepared = (ownerId: string): ExternalEffectRecord => ({
  state: "prepared",
  ownerId,
  epoch: 0,
  providerId: null,
  safeForCompensation: false,
});

function authority() {
  let state = prepared("controller-a");
  return {
    prepare: vi.fn(async () => state),
    acquireDispatchPermit: vi.fn(async ({ ownerId, expectedEpoch }) => {
      if (state.state === "prepared" && state.ownerId === ownerId) {
        state = {
          state: "dispatching",
          ownerId,
          epoch: expectedEpoch + 1,
          providerId: null,
          safeForCompensation: false,
        };
      }
      return state;
    }),
    reconcile: vi.fn(),
    resetPrepared(ownerId: string) {
      state = prepared(ownerId);
    },
  };
}

describe("external effect dispatch application boundary", () => {
  it("redrives a crash before permit while never dispatching without the permit", async () => {
    const port = authority();
    port.acquireDispatchPermit.mockRejectedValueOnce(
      new Error("crash_before_permit"),
    );
    const dispatch = vi.fn().mockResolvedValue("created");
    const useCase = new ExternalEffectDispatchUseCase(port);
    await expect(
      useCase.execute({
        effectId: "e",
        ownerId: "controller-a",
        prepare: {},
        dispatch,
      }),
    ).rejects.toThrow("crash_before_permit");
    expect(dispatch).not.toHaveBeenCalled();
    await expect(
      useCase.execute({
        effectId: "e",
        ownerId: "controller-a",
        prepare: {},
        dispatch,
      }),
    ).resolves.toMatchObject({ response: "created" });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("fails closed after a lost POST response and never retries from dispatching", async () => {
    const port = authority();
    const firstDispatch = vi.fn().mockRejectedValue(new Error("lost_response"));
    const useCase = new ExternalEffectDispatchUseCase(port);
    await expect(
      useCase.execute({
        effectId: "e",
        ownerId: "controller-a",
        prepare: {},
        dispatch: firstDispatch,
      }),
    ).rejects.toThrow("lost_response");
    const replayDispatch = vi.fn();
    await expect(
      useCase.execute({
        effectId: "e",
        ownerId: "controller-a",
        prepare: {},
        dispatch: replayDispatch,
      }),
    ).resolves.toMatchObject({ record: { state: "dispatching" } });
    expect(replayDispatch).not.toHaveBeenCalled();
  });

  it("allows only one of two controllers to POST even with a delayed response", async () => {
    const port = authority();
    const delayed = vi.fn(
      async () =>
        await new Promise<string>((resolve) =>
          queueMicrotask(() => resolve("ok")),
        ),
    );
    const useCase = new ExternalEffectDispatchUseCase(port);
    const first = useCase.execute({
      effectId: "e",
      ownerId: "controller-a",
      prepare: {},
      dispatch: delayed,
    });
    const secondDispatch = vi.fn();
    const second = useCase.execute({
      effectId: "e",
      ownerId: "controller-b",
      prepare: {},
      dispatch: secondDispatch,
    });
    await expect(first).resolves.toMatchObject({ response: "ok" });
    await expect(second).resolves.toMatchObject({
      record: { state: "dispatching" },
    });
    expect(delayed).toHaveBeenCalledTimes(1);
    expect(secondDispatch).not.toHaveBeenCalled();
  });
});

describe("external effect reconciliation application boundary", () => {
  it("binds one discovered provider identity but blocks duplicates unsafe", async () => {
    const reconcile = vi
      .fn()
      .mockResolvedValueOnce({
        state: "bound",
        ownerId: "controller-a",
        epoch: 1,
        providerId: "job-a",
        safeForCompensation: false,
      })
      .mockResolvedValueOnce({
        state: "blocked",
        ownerId: "controller-a",
        epoch: 1,
        providerId: null,
        safeForCompensation: false,
      });
    const useCase = new ExternalEffectReconciliationUseCase({ reconcile });
    await expect(
      useCase.discover({
        effectId: "e",
        ownerId: "controller-a",
        expectedEpoch: 1,
        matchingProviderIds: ["job-a"],
        timedOut: false,
      }),
    ).resolves.toMatchObject({ record: { state: "bound" } });
    expect(reconcile).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        providerId: "job-a",
        reconciliation: { result: "pending", safeForCompensation: false },
      }),
    );
    await expect(
      useCase.discover({
        effectId: "e",
        ownerId: "controller-a",
        expectedEpoch: 1,
        matchingProviderIds: ["job-a", "job-b"],
        timedOut: false,
      }),
    ).resolves.toMatchObject({
      reconciliation: {
        result: "blocked",
        safeForCompensation: false,
        reason: "duplicate",
      },
    });
  });

  it("does not expose a control-plane clean transition", () => {
    const useCase = new ExternalEffectReconciliationUseCase({
      reconcile: vi.fn(),
    });
    expect(useCase).not.toHaveProperty("cleaned");
  });

  it("keeps provider timeout discovery retryable and compensation-unsafe", async () => {
    const reconcile = vi.fn().mockResolvedValue({
      state: "dispatching",
      ownerId: "controller-a",
      epoch: 1,
      providerId: null,
      safeForCompensation: false,
    });
    const useCase = new ExternalEffectReconciliationUseCase({ reconcile });

    await expect(
      useCase.discover({
        effectId: "e",
        ownerId: "controller-a",
        expectedEpoch: 1,
        matchingProviderIds: [],
        timedOut: true,
      }),
    ).resolves.toMatchObject({
      record: { state: "dispatching", safeForCompensation: false },
      reconciliation: { result: "pending", safeForCompensation: false },
    });
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        reconciliation: { result: "pending", safeForCompensation: false },
      }),
    );
  });
});
