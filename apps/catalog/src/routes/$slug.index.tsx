import { createFileRoute, Link } from "@tanstack/react-router";
import { formatPrice, instagramLink, whatsappLink } from "../format";
import { storeHead } from "../seo";
import { getStore } from "../server/catalog";

// the order matters for inference: search, then deps, then loader, then head
export const Route = createFileRoute("/$slug/")({
  validateSearch: (search: Record<string, unknown>): { after?: string } =>
    typeof search.after === "string" ? { after: search.after } : {},
  loaderDeps: ({ search }) => ({ after: search.after }),
  loader: ({ deps, params }) =>
    getStore({ data: { after: deps.after, slug: params.slug } }),
  head: ({ loaderData }) =>
    loaderData
      ? storeHead({ origin: loaderData.origin, profile: loaderData.profile })
      : {},
  component: Store,
});

function Store() {
  const { page, profile } = Route.useLoaderData();
  const { slug } = Route.useParams();
  return (
    <main className="page">
      <header className="store-header">
        <h1>{profile.name}</h1>
        {profile.description ? <p>{profile.description}</p> : null}
        <p className="contacts">
          {profile.whatsapp ? (
            <a href={whatsappLink(profile.whatsapp)} rel="noopener">
              WhatsApp
            </a>
          ) : null}
          {profile.instagram ? (
            <a href={instagramLink(profile.instagram)} rel="noopener">
              Instagram
            </a>
          ) : null}
        </p>
      </header>
      {page.products.length === 0 ? (
        <p className="empty">Ainda não há produtos neste catálogo.</p>
      ) : (
        <ul className="grid">
          {page.products.map((product) => (
            <li key={product.id}>
              <Link
                className="card"
                params={{ productId: product.id, slug }}
                to="/$slug/p/$productId"
              >
                <span className="card-name">{product.name}</span>
                {product.priceFrom ? (
                  <span className="card-price">
                    a partir de {formatPrice(product.priceFrom)}
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {page.next ? (
        <nav className="more">
          <Link params={{ slug }} search={{ after: page.next }} to="/$slug">
            Ver mais produtos
          </Link>
        </nav>
      ) : null}
    </main>
  );
}
