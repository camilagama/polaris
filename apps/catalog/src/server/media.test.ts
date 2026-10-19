import { afterEach, describe, expect, it, vi } from "vitest";

const SECRET = "postgresql://catalog:s3cret-pass@db.internal/neondb";

const mocks = vi.hoisted(() => ({ withPublicCatalog: vi.fn() }));

vi.mock("cloudflare:workers", () => ({
  env: { CATALOG_HYPERDRIVE: { connectionString: "postgresql://unused" } },
}));
vi.mock("@polaris/db/public-catalog-reader", () => ({
  withPublicCatalog: mocks.withPublicCatalog,
}));

const { serveCatalogMedia } = await import("./media");

describe("the wiring of the public image route", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mocks.withPublicCatalog.mockReset();
  });

  it("logs a failed authorization through the logger, as class and code and never the driver's text", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.withPublicCatalog.mockRejectedValue(
      Object.assign(new Error(`password authentication failed for ${SECRET}`), {
        code: "28P01",
        name: "DatabaseError",
      })
    );

    const response = await serveCatalogMedia({
      assetId: "0199c2d0-0000-7000-8000-0000000000aa",
      ifNoneMatch: null,
      productId: "0199c2d0-0000-7000-8000-0000000000bb",
      size: null,
      slug: "loja-da-ana",
    });

    expect(response.status).toBe(502);
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        errorClass: "DatabaseError",
        errorCode: "28P01",
        event: "catalog_media_authorization_failed",
      })
    );
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).not.toContain("s3cret-pass");
    expect(logged).not.toContain("password authentication failed");
  });
});
