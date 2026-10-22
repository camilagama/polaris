import { createFileRoute } from "@tanstack/react-router";
import { productHead } from "../seo";
import { getProduct } from "../server/catalog";
import { ProductView, useFooterHref } from "../views";

export const Route = createFileRoute("/$slug/p/$productId")({
  loader: ({ params }) =>
    getProduct({ data: { productId: params.productId, slug: params.slug } }),
  head: ({ loaderData }) =>
    loaderData
      ? productHead({
          origin: loaderData.origin,
          product: loaderData.product,
          profile: loaderData.profile,
        })
      : {},
  component: ProductDetail,
});

function ProductDetail() {
  const { origin, product, profile } = Route.useLoaderData();
  const { slug } = Route.useParams();
  return (
    <ProductView
      footerHref={useFooterHref()}
      origin={origin}
      product={product}
      profile={profile}
      slug={slug}
    />
  );
}
