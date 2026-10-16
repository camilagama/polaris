import { createFileRoute, Link } from "@tanstack/react-router";
import { formatPrice } from "../format";
import { mediaPath, productHead } from "../seo";
import { getProduct } from "../server/catalog";

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
  const { product, profile } = Route.useLoaderData();
  const { slug } = Route.useParams();
  return (
    <main className="page">
      <nav className="crumbs">
        <Link params={{ slug }} to="/$slug">
          {profile.name}
        </Link>
      </nav>
      {product.media.length > 0 ? (
        <div className="gallery">
          {product.media.map((image, index) => (
            <img
              alt=""
              height={image.height}
              key={image.assetId}
              loading={index === 0 ? "eager" : "lazy"}
              src={mediaPath(slug, product.id, image.assetId, 640)}
              width={image.width}
            />
          ))}
        </div>
      ) : null}
      <h1>{product.name}</h1>
      {product.description ? <p>{product.description}</p> : null}
      <ul className="variants">
        {product.variants.map((variant) => (
          <li key={variant.id}>
            <span>{variant.label ?? "Único"}</span>
            {variant.price ? (
              <strong>{formatPrice(variant.price)}</strong>
            ) : null}
          </li>
        ))}
      </ul>
    </main>
  );
}
