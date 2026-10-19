import type { PolarisRpcClient } from "@polaris/contracts";
import { describe, expect, it, vi } from "vitest";
import { createRpcRuntimeApi } from "./runtime-api";

const deviceId = "0199c2d0-0000-7000-8000-0000000000d1";

function apiWithCheck(
  check: (input: { deviceId: string }) => Promise<unknown>
) {
  const client = { device: { check } } as unknown as PolarisRpcClient;
  return createRpcRuntimeApi(client);
}

describe("runtime api deviceIsMine", () => {
  it("is true when the server confirms the device, asking device.check", async () => {
    const check = vi.fn(() => Promise.resolve({ device: {} }));
    await expect(apiWithCheck(check).deviceIsMine(deviceId)).resolves.toBe(
      true
    );
    expect(check).toHaveBeenCalledWith({ deviceId });
  });

  it("is false for a revoked (CONFLICT) or unknown (NOT_FOUND) device", async () => {
    for (const code of ["CONFLICT", "NOT_FOUND"]) {
      const api = apiWithCheck(() => Promise.reject({ code }));
      // biome-ignore lint/performance/noAwaitInLoops: each code is verified on its own
      await expect(api.deviceIsMine(deviceId)).resolves.toBe(false);
    }
  });

  it("rethrows any other failure instead of calling the device foreign", async () => {
    const failure = Object.assign(new Error("down"), { code: "UNAUTHORIZED" });
    await expect(
      apiWithCheck(() => Promise.reject(failure)).deviceIsMine(deviceId)
    ).rejects.toBe(failure);
    const network = new TypeError("fetch failed");
    await expect(
      apiWithCheck(() => Promise.reject(network)).deviceIsMine(deviceId)
    ).rejects.toBe(network);
  });
});
