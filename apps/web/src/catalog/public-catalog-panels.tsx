import type {
  ProductReadModel,
  PublicCatalogProfileReadModel,
} from "@polaris/contracts";
import CircleAlertIcon from "lucide-react/dist/esm/icons/circle-alert";
import CircleCheckIcon from "lucide-react/dist/esm/icons/circle-check";
import EyeOffIcon from "lucide-react/dist/esm/icons/eye-off";
import GlobeIcon from "lucide-react/dist/esm/icons/globe";
import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
import { type FormEvent, useCallback } from "react";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
import { connectionControlProps } from "../app-shell/connection-required-notice";
import { ProductTextAreaField, ProductTextField } from "./product-fields";
import type { ProfileField, ProfileFieldError } from "./public-catalog-errors";
import {
  type CatalogVisibility,
  MAX_PUBLIC_DESCRIPTION,
  MAX_PUBLIC_NAME,
  type PublicProfileDraft,
  publicUrl,
  slugFromName,
} from "./public-catalog-model";

/** The id of the notice of the plan: the controls it turns off point at it, so they read why. */
export const PLAN_NOTICE_ID = "public-catalog-plan-notice";

const VISIBILITY_TEXT: Readonly<Record<CatalogVisibility, string>> = {
  live: "No ar: qualquer pessoa com o endereço vê os produtos escolhidos.",
  off: "Fora do ar: ninguém vê o catálogo.",
  "waiting-plan":
    "Ligado, mas fora do ar: o plano atual não inclui o catálogo público. Tudo fica guardado e volta ao ar quando o plano incluir.",
};

const VISIBILITY_ICON = {
  live: GlobeIcon,
  off: EyeOffIcon,
  "waiting-plan": TriangleAlertIcon,
} as const;

/** What a command said, shown next to the button that ran it (U-49). */
interface ActionFeedback {
  error: string | null;
  notice: string | null;
}

/**
 * The two live regions of a command, always in the tree so a message that appears is announced: the notice is
 * polite, the error is an alert. Empty, they take no room: they go inside the block of what ran the command, not as
 * a cell of a grid (a grid would leave a gap for each), and the message brings its own top margin. An icon goes with
 * each, so the color is never alone.
 */
function ActionMessages({ error, notice }: ActionFeedback) {
  return (
    <>
      <div role="status">
        {notice ? (
          <p className="mt-2 flex items-start gap-1.5 font-medium text-support">
            <CircleCheckIcon
              aria-hidden="true"
              className="mt-px size-3.5 shrink-0"
            />
            {notice}
          </p>
        ) : null}
      </div>
      <div role="alert">
        {error ? (
          <p className="mt-2 flex items-start gap-1.5 font-medium text-destructive text-support">
            <CircleAlertIcon
              aria-hidden="true"
              className="mt-px size-3.5 shrink-0"
            />
            {error}
          </p>
        ) : null}
      </div>
    </>
  );
}

/** The text of the error of one field of the form, or nothing. */
function problemOf(
  field: ProfileField,
  problem: ProfileFieldError | null
): string | undefined {
  return problem?.field === field ? problem.message : undefined;
}

/** A button that is off for a reason the screen says: it stays reachable and reads the reason (decision of 21/10). */
const OFF_BUTTON = "aria-disabled:pointer-events-none aria-disabled:opacity-50";

interface ProfileFormProps {
  changed: boolean;
  disabled: boolean;
  draft: PublicProfileDraft;
  feedback: ActionFeedback;
  onChange: (draft: PublicProfileDraft) => void;
  /** Offline the commands send nothing and say why (the connection notice). */
  online: boolean;
  onSlugEdited: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  pending: boolean;
  problem: ProfileFieldError | null;
  publicOrigin: string | null;
  slugEdited: boolean;
}

const SAVE_REASON_ID = "public-profile-save-reason";

export function ProfileForm(props: ProfileFormProps) {
  const { draft, onChange, onSlugEdited, problem, slugEdited } = props;
  const handleName = useCallback(
    (publicName: string) => {
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
    (slug: string) => {
      onSlugEdited();
      onChange({ ...draft, slug });
    },
    [draft, onChange, onSlugEdited]
  );
  const handleDescription = useCallback(
    (description: string) => onChange({ ...draft, description }),
    [draft, onChange]
  );
  const handleWhatsapp = useCallback(
    (whatsapp: string) => onChange({ ...draft, whatsapp }),
    [draft, onChange]
  );
  const handleInstagram = useCallback(
    (instagram: string) => onChange({ ...draft, instagram }),
    [draft, onChange]
  );
  const example = draft.slug.trim() || "seu-endereco";
  const preview = publicUrl(props.publicOrigin, example) ?? `/${example}`;

  // offline, nothing to save, or the plan does not allow it: the button says so by aria-disabled and the reason is read with it
  let reasonId = connectionControlProps(props.online)["aria-describedby"];
  if (reasonId === undefined && props.disabled) {
    reasonId = PLAN_NOTICE_ID;
  } else if (reasonId === undefined && !props.changed) {
    reasonId = SAVE_REASON_ID;
  }
  const { onSubmit } = props;
  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      // Enter in a field submits even when the button is off
      if (reasonId !== undefined) {
        event.preventDefault();
        return;
      }
      onSubmit(event);
    },
    [onSubmit, reasonId]
  );

  return (
    <Card>
      <form className="grid gap-4" noValidate onSubmit={handleSubmit}>
        <CardHeader>
          <CardTitle aria-level={2} role="heading">
            Perfil público
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <p className="text-muted-foreground text-support">
            O que você digitar aqui é o que aparece. Nada é copiado do seu
            cadastro, do seu login ou do plano.
          </p>
          <ProductTextField
            error={problemOf("publicName", problem)}
            id="public-name"
            label="Nome público"
            maxLength={MAX_PUBLIC_NAME}
            onChange={handleName}
            value={draft.publicName}
          />
          <ProductTextField
            autoCapitalize="none"
            className="[&_[data-slot=field-description]]:[overflow-wrap:anywhere]"
            error={problemOf("slug", problem)}
            hint={`${preview} · de 3 a 40 letras minúsculas, números e hífens, único entre todas as lojas.`}
            id="public-slug"
            label="Endereço"
            maxLength={40}
            onChange={handleSlug}
            spellCheck={false}
            value={draft.slug}
          />
          <ProductTextAreaField
            error={problemOf("description", problem)}
            hint={`${MAX_PUBLIC_DESCRIPTION - draft.description.length} caracteres restantes.`}
            id="public-description"
            label="Descrição"
            maxLength={MAX_PUBLIC_DESCRIPTION}
            onChange={handleDescription}
            optional
            value={draft.description}
          />
          <ProductTextField
            error={problemOf("whatsapp", problem)}
            id="public-whatsapp"
            inputMode="tel"
            label="WhatsApp"
            onChange={handleWhatsapp}
            optional
            placeholder="11 91234-5678"
            value={draft.whatsapp}
          />
          <ProductTextField
            autoCapitalize="none"
            error={problemOf("instagram", problem)}
            id="public-instagram"
            label="Instagram"
            onChange={handleInstagram}
            optional
            placeholder="minhaloja"
            spellCheck={false}
            value={draft.instagram}
          />
        </CardContent>
        <CardContent>
          <div className="grid gap-2 min-[30rem]:flex min-[30rem]:items-center min-[30rem]:gap-3">
            <Button
              aria-describedby={reasonId}
              aria-disabled={reasonId !== undefined || undefined}
              className={OFF_BUTTON}
              disabled={props.pending}
              type="submit"
            >
              {props.pending ? "Salvando…" : "Salvar perfil"}
            </Button>
            {reasonId === SAVE_REASON_ID ? (
              <p
                className="text-muted-foreground text-support"
                id={SAVE_REASON_ID}
              >
                Nada mudou para salvar.
              </p>
            ) : null}
          </div>
          <ActionMessages {...props.feedback} />
        </CardContent>
      </form>
    </Card>
  );
}

interface SwitchCardProps {
  changed: boolean;
  feedback: ActionFeedback;
  online: boolean;
  onToggle: () => void;
  pending: boolean;
  planBlocks: boolean;
  profile: PublicCatalogProfileReadModel | null;
  publicOrigin: string | null;
  visibility: CatalogVisibility;
}

const SWITCH_REASON_ID = "public-catalog-switch-reason";

export function SwitchCard(props: SwitchCardProps) {
  const { profile } = props;
  const address = profile ? publicUrl(props.publicOrigin, profile.slug) : null;
  const Icon = VISIBILITY_ICON[props.visibility];

  // off for a reason that is on the screen: no connection (its notice), unsaved changes (the hint below) or the plan (its notice at the top)
  let reasonId = connectionControlProps(props.online)["aria-describedby"];
  if (reasonId === undefined && props.changed) {
    reasonId = SWITCH_REASON_ID;
  } else if (
    reasonId === undefined &&
    props.planBlocks &&
    profile &&
    !profile.published
  ) {
    reasonId = PLAN_NOTICE_ID;
  }
  const { onToggle } = props;
  const handleClick = useCallback(() => {
    if (reasonId === undefined) {
      onToggle();
    }
  }, [onToggle, reasonId]);

  return (
    <Card aria-labelledby="catalog-switch" role="region">
      <CardHeader>
        <CardTitle aria-level={2} id="catalog-switch" role="heading">
          Catálogo
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p
          className={
            props.visibility === "waiting-plan"
              ? "flex items-start gap-2 text-warning"
              : "flex items-start gap-2"
          }
          role="status"
        >
          <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {VISIBILITY_TEXT[props.visibility]}
        </p>
        {profile ? (
          <div>
            <Button
              aria-describedby={reasonId}
              aria-disabled={reasonId !== undefined || undefined}
              className={OFF_BUTTON}
              disabled={props.pending}
              onClick={handleClick}
              type="button"
              variant={profile.published ? "outline" : "default"}
            >
              {profile.published ? "Desligar catálogo" : "Ligar catálogo"}
            </Button>
            <ActionMessages {...props.feedback} />
          </div>
        ) : (
          <p className="text-muted-foreground text-support">
            Salve o perfil para poder ligar o catálogo.
          </p>
        )}
        {props.changed && profile ? (
          <p
            className="text-muted-foreground text-support"
            id={SWITCH_REASON_ID}
          >
            Salve o perfil antes de ligar ou desligar o catálogo.
          </p>
        ) : null}
        {address && props.visibility === "live" ? (
          <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
            <a
              className="focus-ring touch-hit rounded-sm underline decoration-input underline-offset-4 hover:decoration-foreground"
              href={address}
              rel="noopener"
              target="_blank"
            >
              Abrir o catálogo
            </a>
            <span className="text-muted-foreground text-support [overflow-wrap:anywhere]">
              {address}
            </span>
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

interface ProductRowProps {
  disabled: boolean;
  online: boolean;
  onToggle: (productId: string, show: boolean) => void;
  product: ProductReadModel;
  shown: boolean;
}

function ProductRow({
  disabled,
  onToggle,
  online,
  product,
  shown,
}: ProductRowProps) {
  const handleClick = useCallback(
    () => onToggle(product.id, !shown),
    [onToggle, product.id, shown]
  );
  return (
    <li className="grid justify-items-start gap-2 py-2.5 min-[30rem]:flex min-[30rem]:items-center min-[30rem]:justify-between min-[30rem]:gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium [overflow-wrap:anywhere]">
          {product.name}
        </span>
        {shown ? <Badge>No catálogo</Badge> : null}
      </div>
      <Button
        {...connectionControlProps(online)}
        aria-pressed={shown}
        className={OFF_BUTTON}
        disabled={disabled}
        onClick={handleClick}
        size="sm"
        type="button"
        variant="outline"
      >
        {shown ? "Tirar do catálogo" : "Mostrar no catálogo"}
      </Button>
    </li>
  );
}

interface ProductsCardProps {
  feedback: ActionFeedback;
  onChange: (productIds: string[], show: boolean) => void;
  online: boolean;
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
    <Card aria-labelledby="catalog-products" role="region">
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle aria-level={2} id="catalog-products" role="heading">
          Produtos
        </CardTitle>
        <div className="flex gap-3">
          <Button
            {...connectionControlProps(props.online)}
            className={OFF_BUTTON}
            disabled={
              props.pending ||
              props.planBlocks ||
              shownCount === products.length
            }
            onClick={handleShowAll}
            size="sm"
            type="button"
            variant="outline"
          >
            Mostrar todos
          </Button>
          <Button
            {...connectionControlProps(props.online)}
            className={OFF_BUTTON}
            disabled={props.pending || shownCount === 0}
            onClick={handleHideAll}
            size="sm"
            type="button"
            variant="outline"
          >
            Tirar todos
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div>
          <p className="text-muted-foreground text-support">
            {shownCount} de {products.length} produtos ativos escolhidos.
            Produto arquivado ou removido sai do catálogo sozinho.
          </p>
          <ActionMessages {...props.feedback} />
        </div>
        {products.length === 0 ? (
          <p>Você ainda não tem produtos ativos.</p>
        ) : (
          <ul className="divide-y divide-border">
            {products.map((product) => {
              const isShown = shown.has(product.id);
              return (
                <ProductRow
                  disabled={props.pending || (props.planBlocks && !isShown)}
                  key={product.id}
                  online={props.online}
                  onToggle={handleToggle}
                  product={product}
                  shown={isShown}
                />
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
