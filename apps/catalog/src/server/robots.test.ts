import { afterEach, describe, expect, it, vi } from "vitest";

const bindings = vi.hoisted(
  () => ({}) as { RELEASE_HEADER_ENABLED?: string | undefined }
);

vi.mock("cloudflare:workers", () => ({ env: bindings }));

const { robotsTxt, serveRobotsTxt } = await import("./robots");
const { secureResponse } = await import("./security");

const RELEASE = "9b3d37ed5c22";

describe("the robots.txt of the catalog", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    bindings.RELEASE_HEADER_ENABLED = undefined;
  });

  it("reads the release the build defined and the switch of the Worker's bindings", async () => {
    vi.stubEnv("POLARIS_SERVER_RELEASE", RELEASE);
    vi.resetModules();
    const built = (await import("./robots")).serveRobotsTxt;
    expect(built().headers.has("X-Polaris-Release")).toBe(false);
    bindings.RELEASE_HEADER_ENABLED = "true";
    expect(built().headers.get("X-Polaris-Release")).toBe(RELEASE);
    bindings.RELEASE_HEADER_ENABLED = "false";
    expect(built().headers.has("X-Polaris-Release")).toBe(false);
  });

  it("declares the release, not cacheable, with the switch on", async () => {
    const response = robotsTxt(RELEASE, "true");
    expect(await response.text()).toBe("User-agent: *\nAllow: /\n");
    expect(response.headers.get("X-Polaris-Release")).toBe(RELEASE);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("declares no release and keeps no cache rule of its own with the switch absent or any value but true", async () => {
    for (const enabled of [undefined, "false", "1", "TRUE"]) {
      const response = robotsTxt(RELEASE, enabled);
      // biome-ignore lint/performance/noAwaitInLoops: each case on its own, for a clear failure
      expect(await response.text()).toBe("User-agent: *\nAllow: /\n");
      expect(response.headers.has("X-Polaris-Release")).toBe(false);
      expect(response.headers.has("Cache-Control")).toBe(false);
    }
  });

  it("declares no release when the build has none, even with the switch on", () => {
    for (const release of ["", "release-1"]) {
      expect(robotsTxt(release, "true").headers.has("X-Polaris-Release")).toBe(
        false
      );
    }
  });

  it("reads the switch of the Worker's bindings, and has no release outside a build", () => {
    bindings.RELEASE_HEADER_ENABLED = "true";
    const response = serveRobotsTxt();
    expect(response.status).toBe(200);
    expect(response.headers.has("X-Polaris-Release")).toBe(false);
  });

  it("keeps the release and the no-store through the security headers of the entry", () => {
    const secured = secureResponse(robotsTxt(RELEASE, "true"), "nonce-x");
    expect(secured.headers.get("X-Polaris-Release")).toBe(RELEASE);
    expect(secured.headers.get("Cache-Control")).toBe("no-store");
  });
});
