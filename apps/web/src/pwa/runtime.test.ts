import { afterEach, describe, expect, it, vi } from "vitest";
import { NO_PENDING_WORK, type PendingWorkSource } from "./update-model";
import type { UpdateStoreOptions } from "./update-store";

/** The queue the page's store reads before the offline runtime hands its own, with the build flag as given. */
async function workSourceOfThePage(
  offlineRuntimeEnabled: boolean
): Promise<PendingWorkSource | undefined> {
  vi.resetModules();
  vi.doMock("../offline/runtime/enabled", () => ({
    OFFLINE_RUNTIME_ENABLED: offlineRuntimeEnabled,
  }));
  const created: UpdateStoreOptions[] = [];
  vi.doMock("./update-store", () => ({
    createUpdateStore: (options: UpdateStoreOptions) => {
      created.push(options);
      return {};
    },
  }));
  vi.stubGlobal("navigator", { serviceWorker: {} });
  const { getUpdateStore } = await import("./runtime");
  getUpdateStore();
  return created[0]?.workSource;
}

describe("the update store of the page", () => {
  afterEach(() => {
    vi.doUnmock("../offline/runtime/enabled");
    vi.doUnmock("./update-store");
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("with the offline runtime off reads an empty queue: there is none", async () => {
    const source = await workSourceOfThePage(false);
    await expect(source?.read()).resolves.toEqual(NO_PENDING_WORK);
  });

  it("with the offline runtime on cannot read the queue until the runtime hands it", async () => {
    const source = await workSourceOfThePage(true);
    await expect(source?.read()).rejects.toThrow("queue_not_attached");
  });
});
