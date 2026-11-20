import { ORPCError } from "@orpc/client";
import type { PolarisRpcClient } from "@polaris/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUnreachableError } from "./offline-runtime";
import { createRpcRuntimeApi } from "./runtime-api";

let api = createRpcRuntimeApi({} as PolarisRpcClient);

beforeEach(() => {
  api = createRpcRuntimeApi({} as PolarisRpcClient);
});

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

  it("reads the server again when the caller asks for a fresh answer", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(Response.json({ user: { id: "user-1" } }))
    );
    vi.stubGlobal("fetch", fetchMock);
    await api.sessionUserId();
    await api.sessionUserId();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await api.sessionUserId({ fresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("the session of a start, as the server answers it now", () => {
  it("names the user and the id of the session row, never its token", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(
        Response.json({
          session: {
            expiresAt: "2026-11-20T00:00:00.000Z",
            id: "session-1",
            token: "secret-session-token",
            userId: "user-1",
          },
          user: { email: "a@example.com", id: "user-1" },
        })
      )
    );
    vi.stubGlobal("fetch", fetchSpy);
    const session = await api.signedInSession?.();
    expect(session).toEqual({ sessionId: "session-1", userId: "user-1" });
    expect(JSON.stringify(session)).not.toContain("secret-session-token");
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/auth/get-session",
      expect.objectContaining({ cache: "no-store" })
    );
  });

  it("asks the server at every call, never reusing an answer", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(
        Response.json({ session: { id: "s" }, user: { id: "u" } })
      )
    );
    vi.stubGlobal("fetch", fetchSpy);
    await api.signedInSession?.();
    await api.signedInSession?.();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("joins the lookup the shell has going at the opening, and not the memory of a finished one", async () => {
    let release: (response: Response) => void = () => undefined;
    const fetchSpy = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        })
    );
    vi.stubGlobal("fetch", fetchSpy);
    const shell = api.sessionUserId();
    const runtime = api.signedInSession?.();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    release(Response.json({ session: { id: "s" }, user: { id: "u" } }));
    expect(await shell).toBe("u");
    expect(await runtime).toEqual({ sessionId: "s", userId: "u" });
    api.signedInSession?.().catch(() => undefined);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("goes to the server even right after the tab's memory answered a start", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(
        Response.json({ session: { id: "s" }, user: { id: "u" } })
      )
    );
    vi.stubGlobal("fetch", fetchSpy);
    await api.sessionUserId();
    await api.sessionUserId();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await api.signedInSession?.()).toEqual({
      sessionId: "s",
      userId: "u",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("has no session id when the answer carries none, so the start asks whose the device is", async () => {
    answerWith(Response.json({ user: { id: "user-1" } }));
    expect(await api.signedInSession?.()).toEqual({
      sessionId: null,
      userId: "user-1",
    });
    answerWith(Response.json({ session: { id: "" }, user: { id: "user-1" } }));
    expect((await api.signedInSession?.())?.sessionId).toBeNull();
  });

  it("has no one when the server says there is no session, and no answer is still no answer", async () => {
    answerWith(Response.json(null));
    expect(await api.signedInSession?.()).toBeNull();
    answerWith(new Response("{}", { status: 401 }));
    expect(await api.signedInSession?.()).toBeNull();
    answerWith(new Response("busy", { status: 503 }));
    await expect(api.signedInSession?.()).rejects.toBeInstanceOf(
      SessionUnreachableError
    );
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

  it("asks once when the server answers 503 (a killed Worker, the 1102): device.check is a write, never the read's second try", async () => {
    for (const failure of [
      new ORPCError("SERVICE_UNAVAILABLE"),
      new ORPCError("SERVICE_UNAVAILABLE", { data: { reason: "server_busy" } }),
      Object.assign(new Error("Worker exceeded resource limits"), {
        code: "SERVICE_UNAVAILABLE",
        status: 503,
      }),
    ]) {
      const check = vi.fn(() => Promise.reject(failure));
      // biome-ignore lint/performance/noAwaitInLoops: each failure is verified on its own
      await expect(apiWithCheck(check).deviceIsMine(deviceId)).rejects.toBe(
        failure
      );
      expect(check).toHaveBeenCalledTimes(1);
    }
  });
});
