import type {
  PublicCatalogPage,
  PublicCatalogProduct,
  PublicCatalogProfile,
} from "@polaris/db/public-catalog-reader";
import { Link, rootRouteId, useMatch } from "@tanstack/react-router";
import {
  formatPrice,
  instagramLink,
  noPriceLabel,
  priceParts,
  productQuestion,
  whatsappLink,
} from "./format";
import {
  ChevronLeftIcon,
  ImageIcon,
  InstagramIcon,
  WhatsAppIcon,
} from "./icons";
import { mediaPath, normalizeOrigin, productPath } from "./seo";

/**
 * What the four public pages (store, product, home, not found) put on the screen, apart from the routes
 * that load the data, so a test renders them without a database. Plain CSS classes of styles.css only:
 * no style attribute, no HTML injected from a string (ADR 0103, condition 7).
 */

/** The footer's link, from the root route's loader: null when the address is not configured or not valid. */
export function useFooterHref(): string | null {
  return (
    useMatch({
      from: rootRouteId,
      select: (match) => match.loaderData?.footerHref ?? null,
      shouldThrow: false,
    }) ?? null
  );
}

/** On every page, for every store: nothing in the profile, the database or the API switches it off. */
function Footer({ href }: { href: string | null }) {
  return (
    <footer className="foot">
      <span aria-hidden="true" className="dot" />
      <span>
        Catálogo feito com{" "}
        {href ? (
          <a href={href} referrerPolicy="no-referrer" rel="noopener noreferrer">
            Polaris
          </a>
        ) : (
          "Polaris"
        )}
      </span>
    </footer>
  );
}

function StoreContacts({ profile }: { profile: PublicCatalogProfile }) {
  const whatsapp = profile.whatsapp ? whatsappLink(profile.whatsapp) : null;
  if (!(whatsapp || profile.instagram)) {
    return null;
  }
  return (
    <p className="contacts">
      {whatsapp ? (
        <a className="btn btn-sm" href={whatsapp} rel="noopener noreferrer">
          <WhatsAppIcon /> WhatsApp
        </a>
      ) : null}
      {profile.instagram ? (
        <a
          className="btn btn-sm"
          href={instagramLink(profile.instagram)}
          rel="noopener noreferrer"
        >
          <InstagramIcon /> Instagram
        </a>
      ) : null}
    </p>
  );
}

export function StoreView({
  footerHref,
  page,
  profile,
  slug,
}: {
  footerHref: string | null;
  page: PublicCatalogPage;
  profile: PublicCatalogProfile;
  slug: string;
}) {
  return (
    <main className="page">
      <header className="store-header">
        <h1>{profile.name}</h1>
        {profile.description ? <p>{profile.description}</p> : null}
        <StoreContacts profile={profile} />
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
                {product.coverAssetId ? (
                  <img
                    alt=""
                    className="card-image"
                    height={320}
                    loading="lazy"
                    src={mediaPath(slug, product.id, product.coverAssetId, 320)}
                    width={320}
                  />
                ) : (
                  <span aria-hidden="true" className="card-image-empty">
                    <ImageIcon />
                  </span>
                )}
                <span className="card-name">{product.name}</span>
                <span className="card-price">
                  {product.priceFrom ? (
                    <>
                      a partir de{" "}
                      <strong>{formatPrice(product.priceFrom)}</strong>
                    </>
                  ) : (
                    noPriceLabel(profile)
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {page.next ? (
        <nav className="more">
          <Link
            className="btn"
            params={{ slug }}
            search={{ after: page.next }}
            to="/$slug"
          >
            Ver mais produtos
          </Link>
        </nav>
      ) : null}
      <Footer href={footerHref} />
    </main>
  );
}

function Price({ value }: { value: string }) {
  const parts = priceParts(value);
  return (
    <strong className="price">
      {parts ? (
        <>
          <small>{parts.symbol}</small>
          {parts.amount}
        </>
      ) : (
        value
      )}
    </strong>
  );
}

export function ProductView({
  footerHref,
  origin,
  product,
  profile,
  slug,
}: {
  footerHref: string | null;
  origin: string;
  product: PublicCatalogProduct;
  profile: PublicCatalogProfile;
  slug: string;
}) {
  const ask = profile.whatsapp
    ? whatsappLink(
        profile.whatsapp,
        productQuestion(
          product.name,
          `${normalizeOrigin(origin)}${productPath(slug, product.id)}`
        )
      )
    : null;
  return (
    <main className="page product">
      <nav className="crumbs">
        <Link className="btn btn-sm" params={{ slug }} to="/$slug">
          <ChevronLeftIcon /> {profile.name}
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
              <Price value={variant.price} />
            ) : (
              <span className="unknown">{noPriceLabel(profile)}</span>
            )}
          </li>
        ))}
      </ul>
      {ask ? (
        <p className="contacts">
          <a
            className="btn"
            href={ask}
            rel="noopener noreferrer"
            target="_blank"
          >
            <WhatsAppIcon /> Perguntar no WhatsApp
          </a>
        </p>
      ) : null}
      <Footer href={footerHref} />
    </main>
  );
}

function Notice({
  children,
  footerHref,
  title,
}: {
  children: string;
  footerHref: string | null;
  title: string;
}) {
  return (
    <main className="page">
      <div className="notice">
        <h1>{title}</h1>
        <p>{children}</p>
      </div>
      <Footer href={footerHref} />
    </main>
  );
}

export function HomeView({ footerHref }: { footerHref: string | null }) {
  return (
    <Notice footerHref={footerHref} title="Catálogo Polaris">
      Abra o endereço de uma loja para ver o catálogo dela.
    </Notice>
  );
}

export function NotFoundView({ footerHref }: { footerHref: string | null }) {
  return (
    <Notice footerHref={footerHref} title="Loja não encontrada">
      Confira o endereço com quem passou o link. Se a loja desligou o catálogo,
      ele volta quando ela ligar de novo.
    </Notice>
  );
}

/** The visitor never sees the error itself: it may name our infrastructure. */
export function UnavailableView({ footerHref }: { footerHref: string | null }) {
  return (
    <Notice footerHref={footerHref} title="Catálogo indisponível">
      Não foi possível carregar esta página agora. Tente de novo em instantes.
    </Notice>
  );
}
