import { describe, expect, it, vi } from "vitest";
import {
  CLOSURE_SWEEP_BATCH,
  CLOSURE_SWEEP_MAX_BATCHES,
  runPrivacyMaintenance,
} from "./maintenance";

describe("the closure sweep", () => {
  it("asks once and stops when nothing was due", async () => {
    const finalizeExpiredClosures = vi.fn(() => Promise.resolve(0));
    await expect(
      runPrivacyMaintenance({ finalizeExpiredClosures })
    ).resolves.toEqual({ closedOrganizations: 0 });
    expect(finalizeExpiredClosures).toHaveBeenCalledTimes(1);
    expect(finalizeExpiredClosures).toHaveBeenCalledWith(CLOSURE_SWEEP_BATCH);
  });

  it("keeps going while a whole batch was closed, and counts them all", async () => {
    const finalizeExpiredClosures = vi
      .fn<(limit: number) => Promise<number>>()
      .mockResolvedValueOnce(CLOSURE_SWEEP_BATCH)
      .mockResolvedValueOnce(7);
    await expect(
      runPrivacyMaintenance({ finalizeExpiredClosures })
    ).resolves.toEqual({ closedOrganizations: CLOSURE_SWEEP_BATCH + 7 });
    expect(finalizeExpiredClosures).toHaveBeenCalledTimes(2);
  });

  it("is bounded: a long backlog is left for the next run", async () => {
    const finalizeExpiredClosures = vi.fn(() =>
      Promise.resolve(CLOSURE_SWEEP_BATCH)
    );
    await runPrivacyMaintenance({ finalizeExpiredClosures });
    expect(finalizeExpiredClosures).toHaveBeenCalledTimes(
      CLOSURE_SWEEP_MAX_BATCHES
    );
  });

  it("lets a failure reach the caller", async () => {
    await expect(
      runPrivacyMaintenance({
        finalizeExpiredClosures: () => Promise.reject(new Error("db_down")),
      })
    ).rejects.toThrow("db_down");
  });
});
