import { createFileRoute } from "@tanstack/react-router";
import { storeHead } from "../seo";
import { getStore } from "../server/catalog";
import { StoreView, useFooterHref } from "../views";

// the order matters for inference: search, then deps, then loader, then head
export const Route = createFileRoute("/$slug/")({
  component: Store,
  head: ({ loaderData }) =>
    loaderData
      ? storeHead({
          cover: firstCover(loaderData.page),
          origin: loaderData.origin,
          profile: loaderData.profile,
        })
      : {},
  loader: ({ deps, params }) =>
    getStore({ data: { after: deps.after, slug: params.slug } }),
  loaderDeps: ({ search }) => ({ after: search.after }),
  validateSearch: (search: Record<string, unknown>): { after?: string } =>
    typeof search.after === "string" ? { after: search.after } : {},
});

/** The first product shown that has a picture: the store's preview image. */
function firstCover(page: {
  products: { coverAssetId: string | null; id: string }[];
}) {
  const product = page.products.find((candidate) => candidate.coverAssetId);
  return product?.coverAssetId
    ? { assetId: product.coverAssetId, productId: product.id }
    : null;
}

function Store() {
  const { page, profile } = Route.useLoaderData();
  const { slug } = Route.useParams();
  return (
    <StoreView
      footerHref={useFooterHref()}
      page={page}
      profile={profile}
      slug={slug}
    />
  );
}
