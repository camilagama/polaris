import { afterEach, describe, expect, it, vi } from "vitest";
import { createServerApp } from "../app";
import type { WorkerBindings } from "../environment";
import { createSystemRoutes, systemRoutes } from "./system";

type ReleaseSwitch = Pick<WorkerBindings, "RELEASE_HEADER_ENABLED">;

const RELEASE = "9b3d37ed5c22";
const ON: ReleaseSwitch = { RELEASE_HEADER_ENABLED: "true" };

describe("the health check", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("reads the release the build defined, and the switch of the bindings", async () => {
    vi.stubEnv("POLARIS_SERVER_RELEASE", RELEASE);
    vi.resetModules();
    const built = (await import("./system")).systemRoutes;
    const on = await built.request("/health", {}, ON);
    expect(on.headers.get("X-Polaris-Release")).toBe(RELEASE);
    const off = await built.request("/health", {}, {});
    expect(off.headers.has("X-Polaris-Release")).toBe(false);
  });

  it("declares the release, not cacheable, with the switch on", async () => {
    const response = await createSystemRoutes(RELEASE).request(
      "/health",
      {},
      ON
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("X-Polaris-Release")).toBe(RELEASE);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("declares no release with the switch absent or any value but true", async () => {
    const switches: ReleaseSwitch[] = [
      {},
      { RELEASE_HEADER_ENABLED: "false" },
      { RELEASE_HEADER_ENABLED: "1" },
      { RELEASE_HEADER_ENABLED: "TRUE" },
    ];
    for (const env of switches) {
      // biome-ignore lint/performance/noAwaitInLoops: each case on its own, for a clear failure
      const response = await createSystemRoutes(RELEASE).request(
        "/health",
        {},
        env
      );
      expect(response.status).toBe(200);
      expect(response.headers.has("X-Polaris-Release")).toBe(false);
    }
  });

  it("declares no release when the build has none, even with the switch on", async () => {
    for (const release of ["", "not-a-sha"]) {
      // biome-ignore lint/performance/noAwaitInLoops: each case on its own, for a clear failure
      const response = await createSystemRoutes(release).request(
        "/health",
        {},
        ON
      );
      expect(response.headers.has("X-Polaris-Release")).toBe(false);
    }
  });

  it("has no release outside a build: the define exists only in the Worker's build", async () => {
    const response = await systemRoutes.request("/health", {}, ON);
    expect(response.headers.has("X-Polaris-Release")).toBe(false);
  });

  it("never declares the release on /ready", async () => {
    const ready = await createSystemRoutes(RELEASE).request("/ready", {}, ON);
    expect(ready.status).toBe(200);
    expect(ready.headers.has("X-Polaris-Release")).toBe(false);
  });

  it("keeps the health check of the whole app not cacheable", async () => {
    const health = await createServerApp().request("/health", {}, ON);
    expect(health.status).toBe(200);
    expect(health.headers.get("Cache-Control")).toBe("no-store");
  });
});
