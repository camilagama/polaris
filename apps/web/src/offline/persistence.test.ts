import { afterEach, describe, expect, it, vi } from "vitest";
import { requestPersistentStorage } from "./persistence";

function stubStorage(storage: Record<string, unknown> | undefined) {
  vi.stubGlobal("navigator", { storage });
}

describe("requestPersistentStorage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is granted without asking again when the origin is already persisted", async () => {
    const persist = vi.fn().mockResolvedValue(false);
    const persisted = vi.fn().mockResolvedValue(true);
    stubStorage({ persist, persisted });

    await expect(requestPersistentStorage()).resolves.toBe("granted");
    expect(persisted).toHaveBeenCalledTimes(1);
    expect(persist).not.toHaveBeenCalled();
  });

  it("is granted when persist() resolves true", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    const persisted = vi.fn().mockResolvedValue(false);
    stubStorage({ persist, persisted });

    await expect(requestPersistentStorage()).resolves.toBe("granted");
    expect(persisted).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("is denied when persist() resolves false", async () => {
    const persist = vi.fn().mockResolvedValue(false);
    const persisted = vi.fn().mockResolvedValue(false);
    stubStorage({ persist, persisted });

    await expect(requestPersistentStorage()).resolves.toBe("denied");
    expect(persisted).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("asks persist() when persisted() does not exist", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    stubStorage({ persist });

    await expect(requestPersistentStorage()).resolves.toBe("granted");
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("is unsupported when navigator.storage is absent", async () => {
    stubStorage(undefined);

    await expect(requestPersistentStorage()).resolves.toBe("unsupported");
  });

  it("is unsupported when there is no navigator at all", async () => {
    vi.stubGlobal("navigator", undefined);

    await expect(requestPersistentStorage()).resolves.toBe("unsupported");
  });

  it("is unsupported when storage has no persist(), even with persisted()", async () => {
    const persisted = vi.fn().mockResolvedValue(true);
    stubStorage({ persisted });

    await expect(requestPersistentStorage()).resolves.toBe("unsupported");
    expect(persisted).not.toHaveBeenCalled();
  });

  it("reports denied, not a rejection, when persist() throws", async () => {
    const persist = vi.fn().mockRejectedValue(new Error("SecurityError"));
    stubStorage({ persist, persisted: vi.fn().mockResolvedValue(false) });

    await expect(requestPersistentStorage()).resolves.toBe("denied");
  });

  it("reports denied without calling persist() when persisted() throws", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    const persisted = vi.fn().mockRejectedValue(new Error("boom"));
    stubStorage({ persist, persisted });

    await expect(requestPersistentStorage()).resolves.toBe("denied");
    expect(persist).not.toHaveBeenCalled();
  });

  it("reports denied when persist() throws synchronously", async () => {
    const persist = vi.fn(() => {
      throw new Error("SecurityError");
    });
    stubStorage({ persist, persisted: vi.fn().mockResolvedValue(false) });

    await expect(requestPersistentStorage()).resolves.toBe("denied");
  });
});
