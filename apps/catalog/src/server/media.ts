import { withPublicCatalog } from "@polaris/db/public-catalog-reader";
import { logger } from "@polaris/observability/logger";
import { describeError } from "@polaris/observability/wide-event";
import { env } from "cloudflare:workers";
import {
  type MediaDependencies,
  type MediaRequest,
  serveMedia,
} from "../media";

/**
 * Wires the public image route to the database (the public role) and to the
 * private bucket (read only: only `get` is ever called on the binding).
 */
const dependencies: MediaDependencies = {
  authorize: ({ assetId, productId, slug }) => {
    const connectionString = env.CATALOG_HYPERDRIVE?.connectionString;
    if (!connectionString) {
      return Promise.reject(new Error("catalog_unavailable"));
    }
    return withPublicCatalog(connectionString, (catalog) =>
      catalog.media(slug, productId, assetId)
    );
  },
  getObject: async (key) => {
    if (!env.MEDIA_BUCKET) {
      // a missing binding is our configuration, not a missing image
      throw new Error("catalog_media_not_configured");
    }
    const object = await env.MEDIA_BUCKET.get(key);
    return object ? { body: object.body, size: object.size } : null;
  },
  report: (message, error) =>
    logger.error(message, error === undefined ? {} : describeError(error)),
};

export function serveCatalogMedia(request: MediaRequest): Promise<Response> {
  return serveMedia(request, dependencies);
}
