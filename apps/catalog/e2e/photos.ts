import type { Page } from "@playwright/test";

/** A 1 x 1 gray PNG: the fixture build has no bucket, so the photo routes are answered by the test. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mO8c+fOfwAIBAPD5uLZNgAAAABJRU5ErkJggg==",
  "base64"
);
const PHOTO_ROUTE = /\/m\/[^/]+\/[^/?]+/;

export async function servePhotos(page: Page) {
  await page.route(PHOTO_ROUTE, (route) =>
    route.fulfill({ body: PNG, contentType: "image/png" })
  );
}
