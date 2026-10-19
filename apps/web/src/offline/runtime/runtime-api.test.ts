import type { PolarisRpcClient } from "@polaris/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionUnreachableError } from "./offline-runtime";
import { createRpcRuntimeApi } from "./runtime-api";

const api = createRpcRuntimeApi({} as PolarisRpcClient);

function answerWith(response: Response | Error) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      response instanceof Error
        ? Promise.reject(response)
        : Promise.resolve(response)
    )
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("who is signed in, as the server answers", () => {
  it("names the user of a live session", async () => {
    answerWith(Response.json({ user: { id: "user-1" } }));
    expect(await api.sessionUserId()).toBe("user-1");
  });

  it("has no one when the server says there is no session", async () => {
    answerWith(Response.json(null));
    expect(await api.sessionUserId()).toBeNull();
  });

  it.each([401, 403])(
    "has no one when the server refuses with %i",
    async (status) => {
      answerWith(new Response("{}", { status }));
      expect(await api.sessionUserId()).toBeNull();
    }
  );

  it.each([500, 502, 503, 504, 429])(
    "treats %i as no answer, so the remembered user stands in",
    async (status) => {
      answerWith(new Response("busy", { status }));
      await expect(api.sessionUserId()).rejects.toBeInstanceOf(
        SessionUnreachableError
      );
    }
  );

  it("treats a network failure and a timeout as no answer", async () => {
    answerWith(new TypeError("Failed to fetch"));
    await expect(api.sessionUserId()).rejects.toBeInstanceOf(
      SessionUnreachableError
    );
    answerWith(new DOMException("timed out", "TimeoutError"));
    await expect(api.sessionUserId()).rejects.toBeInstanceOf(
      SessionUnreachableError
    );
  });

  it("never guesses on an answer it cannot use", async () => {
    answerWith(new Response("<html>login</html>", { status: 200 }));
    await expect(api.sessionUserId()).rejects.toThrow("session_unavailable");
    answerWith(new Response("nope", { status: 404 }));
    await expect(api.sessionUserId()).rejects.toThrow("session_unavailable");
  });
});

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
      const refusing = apiWithCheck(() => Promise.reject({ code }));
      // biome-ignore lint/performance/noAwaitInLoops: each code is verified on its own
      await expect(refusing.deviceIsMine(deviceId)).resolves.toBe(false);
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
