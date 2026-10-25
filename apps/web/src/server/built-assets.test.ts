import { describe, expect, it, vi } from "vitest";
import {
  type AssetsBinding,
  isBuiltAssetRequest,
  serveBuiltAsset,
} from "./built-assets";

const get = (path: string, method = "GET") =>
  new Request(`https://app.example${path}`, { method });

function assetsAnswering(response: Response): AssetsBinding {
  return { fetch: vi.fn(() => Promise.resolve(response)) };
}

const SHELL = () =>
  new Response("<!doctype html><html></html>", {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });

describe("the files under /assets/", () => {
  it("asks only for the paths of the build's files", () => {
    expect(isBuiltAssetRequest(get("/assets/dashboard-page-AAAA.js"))).toBe(
      true
    );
    expect(isBuiltAssetRequest(get("/assetsx/a.js"))).toBe(false);
    expect(isBuiltAssetRequest(get("/rpc/sale/confirm"))).toBe(false);
    expect(isBuiltAssetRequest(get("/vendas"))).toBe(false);
  });

  it("serves the file that exists as the platform gave it, headers and all", async () => {
    const file = new Response("export default 1", {
      headers: {
        "Content-Type": "text/javascript; charset=utf-8",
        ETag: '"abc"',
      },
    });
    const response = await serveBuiltAsset(
      get("/assets/a-1.js"),
      assetsAnswering(file)
    );
    expect(response).toBe(file);
  });

  it("answers 404, never the shell, for a chunk that does not exist", async () => {
    const response = await serveBuiltAsset(
      get("/assets/dashboard-page-ZZZZZZZZ.js"),
      assetsAnswering(SHELL())
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toBe(
      "text/plain; charset=utf-8"
    );
    expect(await response.text()).toBe("Not found");
  });

  it("never lets the 404 be cached: the file may be there a minute later, with the deploy", async () => {
    const response = await serveBuiltAsset(
      get("/assets/a-1.js"),
      assetsAnswering(SHELL())
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("keeps a 404 of the platform a 404", async () => {
    const response = await serveBuiltAsset(
      get("/assets/a-1.js"),
      assetsAnswering(new Response(null, { status: 404 }))
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("passes a 304 through: the browser's copy is still the file", async () => {
    const response = await serveBuiltAsset(
      get("/assets/a-1.js"),
      assetsAnswering(new Response(null, { status: 304 }))
    );
    expect(response.status).toBe(304);
  });

  it("only reads: any write is refused without asking the assets", async () => {
    const assets = assetsAnswering(SHELL());
    const response = await serveBuiltAsset(
      get("/assets/a-1.js", "POST"),
      assets
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(assets.fetch).not.toHaveBeenCalled();
  });
});
