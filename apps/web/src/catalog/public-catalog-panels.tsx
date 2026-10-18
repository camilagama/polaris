import type {
  ProductReadModel,
  PublicCatalogProfileReadModel,
} from "@polaris/contracts";
import { type ChangeEvent, type FormEvent, useCallback } from "react";
import {
  type CatalogVisibility,
  MAX_PUBLIC_DESCRIPTION,
  MAX_PUBLIC_NAME,
  type PublicProfileDraft,
  publicUrl,
  slugFromName,
} from "./public-catalog-model";

const VISIBILITY_TEXT: Readonly<Record<CatalogVisibility, string>> = {
  live: "No ar: qualquer pessoa com o endereço vê os produtos escolhidos.",
  off: "Fora do ar: ninguém vê o catálogo.",
  "waiting-plan":
    "Ligado, mas fora do ar: o plano atual não inclui o catálogo público. Tudo fica guardado e volta ao ar quando o plano incluir.",
};

interface ProfileFormProps {
  changed: boolean;
  disabled: boolean;
  draft: PublicProfileDraft;
  onChange: (draft: PublicProfileDraft) => void;
  onSlugEdited: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  pending: boolean;
  publicOrigin: string | null;
  slugEdited: boolean;
}

export function ProfileForm(props: ProfileFormProps) {
  const { draft, onChange, onSlugEdited, slugEdited } = props;
  const handleName = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const publicName = event.target.value;
      // the address follows the name until the organization types its own
      onChange({
        ...draft,
        publicName,
        slug: slugEdited ? draft.slug : slugFromName(publicName),
      });
    },
    [draft, onChange, slugEdited]
  );
  const handleSlug = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onSlugEdited();
      onChange({ ...draft, slug: event.target.value });
    },
    [draft, onChange, onSlugEdited]
  );
  const handleDescription = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) =>
      onChange({ ...draft, description: event.target.value }),
    [draft, onChange]
  );
  const handleWhatsapp = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onChange({ ...draft, whatsapp: event.target.value }),
    [draft, onChange]
  );
  const handleInstagram = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onChange({ ...draft, instagram: event.target.value }),
    [draft, onChange]
  );
  const example = draft.slug.trim() || "seu-endereco";
  const preview = publicUrl(props.publicOrigin, example) ?? `/${example}`;

  return (
    <form className="public-catalog-card" onSubmit={props.onSubmit}>
      <h2>Perfil público</h2>
      <p className="field-help">
        O que você digitar aqui é o que aparece. Nada é copiado do seu cadastro,
        do seu login ou do plano.
      </p>
      <label htmlFor="public-name">Nome público</label>
      <input
        disabled={props.pending}
        id="public-name"
        maxLength={MAX_PUBLIC_NAME}
        onChange={handleName}
        required
        value={draft.publicName}
      />
      <label htmlFor="public-slug">Endereço</label>
      <input
        autoCapitalize="none"
        disabled={props.pending}
        id="public-slug"
        maxLength={40}
        onChange={handleSlug}
        required
        spellCheck={false}
        value={draft.slug}
      />
      <p className="field-help">
        {preview} · de 3 a 40 letras minúsculas, números e hífens, único entre
        todas as lojas.
      </p>
      <label htmlFor="public-description">Descrição (opcional)</label>
      <textarea
        disabled={props.pending}
        id="public-description"
        maxLength={MAX_PUBLIC_DESCRIPTION}
        onChange={handleDescription}
        rows={3}
        value={draft.description}
      />
      <p className="field-help">
        {MAX_PUBLIC_DESCRIPTION - draft.description.length} caracteres
        restantes.
      </p>
      <label htmlFor="public-whatsapp">WhatsApp (opcional)</label>
      <input
        autoComplete="off"
        disabled={props.pending}
        id="public-whatsapp"
        inputMode="tel"
        onChange={handleWhatsapp}
        placeholder="11 91234-5678"
        value={draft.whatsapp}
      />
      <label htmlFor="public-instagram">Instagram (opcional)</label>
      <input
        autoCapitalize="none"
        disabled={props.pending}
        id="public-instagram"
        onChange={handleInstagram}
        placeholder="minhaloja"
        spellCheck={false}
        value={draft.instagram}
      />
      <button
        className="primary-button"
        disabled={props.pending || props.disabled || !props.changed}
        type="submit"
      >
        {props.pending ? "Salvando…" : "Salvar perfil"}
      </button>
    </form>
  );
}

interface SwitchCardProps {
  changed: boolean;
  onToggle: () => void;
  pending: boolean;
  planBlocks: boolean;
  profile: PublicCatalogProfileReadModel | null;
  publicOrigin: string | null;
  visibility: CatalogVisibility;
}

export function SwitchCard(props: SwitchCardProps) {
  const { profile } = props;
  const address = profile ? publicUrl(props.publicOrigin, profile.slug) : null;
  return (
    <section aria-labelledby="catalog-switch" className="public-catalog-card">
      <h2 id="catalog-switch">Catálogo</h2>
      <p
        className={`public-catalog-status is-${props.visibility}`}
        role="status"
      >
        {VISIBILITY_TEXT[props.visibility]}
      </p>
      {profile ? (
        <button
          className={profile.published ? "quiet-button" : "primary-button"}
          disabled={
            props.pending ||
            props.changed ||
            (props.planBlocks && !profile.published)
          }
          onClick={props.onToggle}
          type="button"
        >
          {profile.published ? "Desligar catálogo" : "Ligar catálogo"}
        </button>
      ) : (
        <p className="field-help">
          Salve o perfil para poder ligar o catálogo.
        </p>
      )}
      {props.changed && profile ? (
        <p className="field-help">
          Salve o perfil antes de ligar ou desligar o catálogo.
        </p>
      ) : null}
      {address && props.visibility === "live" ? (
        <p>
          <a href={address} rel="noopener" target="_blank">
            Abrir o catálogo
          </a>{" "}
          <span className="field-help">{address}</span>
        </p>
      ) : null}
    </section>
  );
}

interface ProductRowProps {
  disabled: boolean;
  onToggle: (productId: string, show: boolean) => void;
  product: ProductReadModel;
  shown: boolean;
}

function ProductRow({ disabled, onToggle, product, shown }: ProductRowProps) {
  const handleClick = useCallback(
    () => onToggle(product.id, !shown),
    [onToggle, product.id, shown]
  );
  return (
    <li>
      <span>{product.name}</span>
      <button
        aria-pressed={shown}
        className={shown ? "quiet-button" : "primary-button"}
        disabled={disabled}
        onClick={handleClick}
        type="button"
      >
        {shown ? "Tirar do catálogo" : "Mostrar no catálogo"}
      </button>
    </li>
  );
}

interface ProductsCardProps {
  onChange: (productIds: string[], show: boolean) => void;
  pending: boolean;
  planBlocks: boolean;
  products: ProductReadModel[];
  shown: ReadonlySet<string>;
}

export function ProductsCard(props: ProductsCardProps) {
  const { onChange, products, shown } = props;
  const shownCount = products.filter((product) => shown.has(product.id)).length;
  const handleToggle = useCallback(
    (productId: string, show: boolean) => onChange([productId], show),
    [onChange]
  );
  const handleShowAll = useCallback(
    () =>
      onChange(
        products
          .filter((product) => !shown.has(product.id))
          .map((product) => product.id),
        true
      ),
    [onChange, products, shown]
  );
  const handleHideAll = useCallback(
    () =>
      onChange(
        products
          .filter((product) => shown.has(product.id))
          .map((product) => product.id),
        false
      ),
    [onChange, products, shown]
  );

  return (
    <section
      aria-labelledby="catalog-products"
      className="public-catalog-card public-catalog-products"
    >
      <div className="public-catalog-products-heading">
        <h2 id="catalog-products">Produtos</h2>
        <div className="public-catalog-bulk">
          <button
            className="quiet-button"
            disabled={
              props.pending ||
              props.planBlocks ||
              shownCount === products.length
            }
            onClick={handleShowAll}
            type="button"
          >
            Mostrar todos
          </button>
          <button
            className="quiet-button"
            disabled={props.pending || shownCount === 0}
            onClick={handleHideAll}
            type="button"
          >
            Tirar todos
          </button>
        </div>
      </div>
      <p className="field-help">
        {shownCount} de {products.length} produtos ativos escolhidos. Produto
        arquivado ou removido sai do catálogo sozinho.
      </p>
      {products.length === 0 ? (
        <p>Você ainda não tem produtos ativos.</p>
      ) : (
        <ul className="public-catalog-product-list">
          {products.map((product) => {
            const isShown = shown.has(product.id);
            return (
              <ProductRow
                disabled={props.pending || (props.planBlocks && !isShown)}
                key={product.id}
                onToggle={handleToggle}
                product={product}
                shown={isShown}
              />
            );
          })}
        </ul>
      )}
    </section>
  );
}
