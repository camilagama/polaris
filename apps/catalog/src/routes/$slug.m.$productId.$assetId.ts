import { createFileRoute } from "@tanstack/react-router";
import { serveCatalogMedia } from "../server/media";

export const Route = createFileRoute("/$slug/m/$productId/$assetId")({
  server: {
    handlers: {
      GET: ({ params, request }) =>
        serveCatalogMedia({
          assetId: params.assetId,
          ifNoneMatch: request.headers.get("if-none-match"),
          productId: params.productId,
          size: new URL(request.url).searchParams.get("s"),
          slug: params.slug,
        }),
    },
  },
});
