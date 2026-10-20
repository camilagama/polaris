import { env } from "cloudflare:workers";
import { createDatabase } from "@polaris/db/client";
import {
  type PublicCatalogReader,
  withPublicCatalog,
} from "@polaris/db/public-catalog-reader";
import { afterEach, describe, expect, it } from "vitest";
import { serveCatalogMedia } from "./media";

/**
 * The server side of the public catalog Worker, real, inside workerd, against PostgreSQL (T-121b): the Hyperdrive
 * binding of the public catalog role, the private bucket, and the code the routes call (the reads and the image
 * route). The Worker's fetch is not here: the TanStack Start handler needs the build of Vite, and the e2e of the app
 * runs it. The `catalog-worker` gate (packages/db/scripts/verify-catalog-worker-gate.ts) makes the login and the
 * stores, runs this file and reads the database afterwards.
 */

interface Store {
  assetId: string;
  organizationId: string;
  productId: string;
  productName: string;
  sku: string;
  slug: string;
  storageKey: string;
}

interface Fixture {
  catalogLogin: string;
  hidden: Store;
  masterBytes: number[];
  shown: Store;
}

const fixture = JSON.parse(env.TEST_CATALOG_FIXTURE ?? "{}") as Fixture;
const { hidden, shown } = fixture;
const MASTER = new Uint8Array(fixture.masterBytes);
/** A Hyperdrive that fails closed: a loopback port nobody listens on. */
const CLOSED = {
  connectionString: "postgresql://harness:harness@127.0.0.1:1/harness",
};
const ETAG = /^"[0-9a-f-]+-master"$/;

const read = <T>(operation: (catalog: PublicCatalogReader) => Promise<T>) =>
  withPublicCatalog(env.CATALOG_HYPERDRIVE.connectionString, operation);

const image = (
  store: Store,
  parameters: { ifNoneMatch?: string; size?: string } = {}
) =>
  serveCatalogMedia({
    assetId: store.assetId,
    ifNoneMatch: parameters.ifNoneMatch ?? null,
    productId: store.productId,
    size: parameters.size ?? null,
    slug: store.slug,
  });

describe("the Hyperdrive binding of the catalog worker", () => {
  it("reaches PostgreSQL as the login of the public catalog role, and as no other role", async () => {
    const { pool } = createDatabase(env.CATALOG_HYPERDRIVE.connectionString, {
      maxConnections: 1,
    });
    try {
      const { rows } = await pool.query<{ groups: string[]; login: string }>(
        `SELECT current_user AS login,
                ARRAY(SELECT g FROM unnest($1::text[]) AS g WHERE pg_has_role(current_user, g, 'member') ORDER BY g) AS groups`,
        [
          [
            "polaris_admin_runtime",
            "polaris_auth_runtime",
            "polaris_billing_runtime",
            "polaris_catalog_runtime",
            "polaris_outbox_runtime",
            "polaris_pr11_runtime",
            "polaris_privacy_runtime",
          ],
        ]
      );
      expect(rows[0]?.login).toBe(fixture.catalogLogin);
      expect(rows[0]?.groups).toEqual(["polaris_catalog_runtime"]);
      // it reads no table: what a visitor sees comes only through the four functions
      await expect(
        pool.query("SELECT id FROM public.products")
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await pool.end();
    }
  });
});

describe("the reads of the catalog worker", () => {
  it("answers the store that is shown, with nothing that is not for a visitor", async () => {
    const profile = await read((catalog) => catalog.profile(shown.slug));
    expect(profile).toMatchObject({ name: "Loja on", slug: shown.slug });
    const page = await read((catalog) => catalog.products(shown.slug));
    expect(page?.products.map((product) => product.id)).toEqual([
      shown.productId,
    ]);
    const product = await read((catalog) =>
      catalog.product(shown.slug, shown.productId)
    );
    expect(product).toMatchObject({
      id: shown.productId,
      name: shown.productName,
    });
    expect(product?.media.map((media) => media.assetId)).toEqual([
      shown.assetId,
    ]);
    const everything = JSON.stringify([profile, page, product]);
    for (const secret of [shown.organizationId, shown.sku, shown.storageKey]) {
      expect(everything).not.toContain(secret);
    }
  });

  it("answers the same nothing for a store that was never switched on and one that does not exist", async () => {
    for (const slug of [hidden.slug, "loja-que-nunca-existiu"]) {
      expect(await read((catalog) => catalog.profile(slug))).toBeNull();
      expect(await read((catalog) => catalog.products(slug))).toBeNull();
      expect(
        await read((catalog) => catalog.product(slug, hidden.productId))
      ).toBeNull();
    }
  });

  it("does not show a product through another store's address", async () => {
    expect(
      await read((catalog) => catalog.product(shown.slug, hidden.productId))
    ).toBeNull();
  });

  it("fails when the database is down instead of answering an empty store", async () => {
    await expect(
      withPublicCatalog(CLOSED.connectionString, (catalog) =>
        catalog.profile(shown.slug)
      )
    ).rejects.toThrow();
  });
});

describe("the image route of the catalog worker", () => {
  const put = () => env.MEDIA_BUCKET.put(shown.storageKey, MASTER);

  afterEach(async () => {
    await env.MEDIA_BUCKET.delete(shown.storageKey);
  });

  it("serves the master of an image that is shown, read from the private bucket", async () => {
    await put();
    const response = await image(shown);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(MASTER);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("content-length")).toBe(String(MASTER.length));
    expect(response.headers.get("etag")).toMatch(ETAG);
    expect(response.headers.get("cache-control")).toContain("max-age=60");
    // the storage path goes no further than the server
    const exposed = [...response.headers.values()].join(" ");
    expect(exposed).not.toContain(shown.storageKey);
  });

  it("serves the master for a size that has no derivative yet, and 304 for the same entity tag", async () => {
    await put();
    const sized = await image(shown, { size: "320" });
    expect(sized.status).toBe(200);
    expect(new Uint8Array(await sized.arrayBuffer())).toEqual(MASTER);
    const etag = sized.headers.get("etag") ?? "";
    const same = await image(shown, { ifNoneMatch: etag });
    expect(same.status).toBe(304);
    expect(await same.text()).toBe("");
  });

  it("serves a derivative once the bucket holds it", async () => {
    const derivative = new Uint8Array([9, 9, 9]);
    const { mediaDerivativeKey } = await import(
      "@polaris/domain/catalog/media"
    );
    const key = mediaDerivativeKey(shown.assetId, 320);
    await put();
    await env.MEDIA_BUCKET.put(key, derivative);
    try {
      const response = await image(shown, { size: "320" });
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(derivative);
    } finally {
      await env.MEDIA_BUCKET.delete(key);
    }
  });

  it("answers 404 when the object is not in the bucket, and for a size that does not exist", async () => {
    expect((await image(shown)).status).toBe(404);
    await put();
    expect((await image(shown, { size: "9999" })).status).toBe(404);
  });

  it("answers 404, without reading the bucket, for an image of a store that is not shown or of another store", async () => {
    await put();
    expect((await image(hidden)).status).toBe(404);
    // the right image under the address of another store
    const crossed = await serveCatalogMedia({
      assetId: shown.assetId,
      ifNoneMatch: null,
      productId: shown.productId,
      size: null,
      slug: hidden.slug,
    });
    expect(crossed.status).toBe(404);
  });

  it("answers 502 when the database is down, never a missing image", async () => {
    await put();
    const real = env.CATALOG_HYPERDRIVE;
    // the route reads the binding on every request: swap it for the one that fails closed, and put it back
    Object.defineProperty(env, "CATALOG_HYPERDRIVE", {
      configurable: true,
      value: CLOSED,
    });
    try {
      expect((await image(shown)).status).toBe(502);
    } finally {
      Object.defineProperty(env, "CATALOG_HYPERDRIVE", {
        configurable: true,
        value: real,
      });
    }
  });
});
