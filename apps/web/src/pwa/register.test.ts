import { describe, expect, it, vi } from "vitest";
import {
  type RegisterEnvironment,
  registerServiceWorker,
  shouldRegisterServiceWorker,
} from "./register";

const environment = (
  overrides: Partial<RegisterEnvironment> = {}
): RegisterEnvironment => ({
  isProduction: true,
  isSecureContext: true,
  pathname: "/",
  register: vi.fn(() =>
    Promise.resolve({} as unknown as ServiceWorkerRegistration)
  ),
  supportsServiceWorker: true,
  ...overrides,
});

describe("registering the service worker", () => {
  it("registers /sw.js at the root scope, bypassing the HTTP cache for the script", async () => {
    const env = environment();
    expect(await registerServiceWorker(env)).not.toBeNull();
    expect(env.register).toHaveBeenCalledWith("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    });
  });

  it("does nothing in development, without support, outside a secure context or on a laboratory", async () => {
    for (const overrides of [
      { isProduction: false },
      { supportsServiceWorker: false },
      { isSecureContext: false },
      { pathname: "/offline-outbox-lab" },
      { pathname: "/offline-poc" },
    ]) {
      const env = environment(overrides);
      expect(shouldRegisterServiceWorker(env)).toBe(false);
      // biome-ignore lint/performance/noAwaitInLoops: each case is verified on its own
      expect(await registerServiceWorker(env)).toBeNull();
      expect(env.register).not.toHaveBeenCalled();
    }
  });

  it("a failed registration never breaks the app", async () => {
    const env = environment({
      register: vi.fn(() => Promise.reject(new Error("blocked"))),
    });
    expect(await registerServiceWorker(env)).toBeNull();
  });
});
