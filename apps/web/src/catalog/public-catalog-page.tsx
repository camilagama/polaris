import type {
  ProductReadModel,
  PublicCatalogSetupReadModel,
} from "@polaris/contracts";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useCurrentOrganization } from "../lib/current-organization";
import { orpcClient } from "../lib/orpc";
import { useReportUnsentWork } from "../lib/unsent-work";
import { publicCatalogErrorMessage } from "./public-catalog-errors";
import {
  draftFromProfile,
  hasProfileChanges,
  inBatches,
  type PublicProfileDraft,
  profileRequest,
  visibilityOf,
} from "./public-catalog-model";
import { ProductsCard, ProfileForm, SwitchCard } from "./public-catalog-panels";
import "./public-catalog-page.css";

interface LoadedState {
  products: ProductReadModel[];
  setup: PublicCatalogSetupReadModel;
}

type Action = Parameters<typeof publicCatalogErrorMessage>[1];

export function PublicCatalogPage() {
  const { organizationId } = useCurrentOrganization();
  const [loaded, setLoaded] = useState<LoadedState | null>(null);
  const [draft, setDraft] = useState<PublicProfileDraft>(() =>
    draftFromProfile(null)
  );
  const [slugEdited, setSlugEdited] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useReportUnsentWork(
    loaded !== null && hasProfileChanges(draft, loaded.setup.profile)
  );

  const load = useCallback(
    async (keepDraft: boolean) => {
      setLoading(true);
      try {
        const [setup, products] = await Promise.all([
          orpcClient.publicCatalog.setup({ organizationId }),
          orpcClient.product.list({ organizationId, status: "active" }),
        ]);
        setLoaded({ products: products.products, setup });
        if (!keepDraft) {
          setDraft(draftFromProfile(setup.profile));
          setSlugEdited(setup.profile !== null);
        }
      } catch (loadError) {
        setError(publicCatalogErrorMessage(loadError, "load"));
      } finally {
        setLoading(false);
      }
    },
    [organizationId]
  );

  useEffect(() => {
    load(false).catch(() => undefined);
  }, [load]);

  /** Runs a command, then reloads so the screen shows what the server holds. */
  const run = useCallback(
    async (
      action: Action,
      command: () => Promise<unknown>,
      success: string,
      keepDraft: boolean
    ) => {
      setPending(true);
      setError(null);
      setNotice(null);
      try {
        await command();
        setNotice(success);
      } catch (commandError) {
        setError(publicCatalogErrorMessage(commandError, action));
      } finally {
        setPending(false);
      }
      await load(keepDraft).catch(() => undefined);
    },
    [load]
  );

  const setup = loaded?.setup ?? null;
  const profile = setup?.profile ?? null;
  const planBlocks = setup !== null && !setup.enabled;
  const shown = useMemo(
    () => new Set(setup?.publishedProductIds ?? []),
    [setup]
  );
  const visibility = visibilityOf({
    enabled: setup?.enabled ?? false,
    profile,
  });
  const changed = hasProfileChanges(draft, profile);

  const handleSlugEdited = useCallback(() => setSlugEdited(true), []);

  const saveProfile = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      run(
        "profile",
        () =>
          orpcClient.publicCatalog.saveProfile({
            organizationId,
            ...profileRequest(draft, profile?.version),
          }),
        "Perfil salvo.",
        false
      ).catch(() => undefined);
    },
    [draft, organizationId, profile?.version, run]
  );

  const toggleCatalog = useCallback(() => {
    if (!profile) {
      return;
    }
    const publish = !profile.published;
    run(
      "switch",
      () =>
        orpcClient.publicCatalog.setPublished({
          expectedVersion: profile.version,
          organizationId,
          published: publish,
        }),
      publish ? "Catálogo ligado." : "Catálogo desligado.",
      false
    ).catch(() => undefined);
  }, [organizationId, profile, run]);

  const changeProducts = useCallback(
    (ids: string[], show: boolean) => {
      if (ids.length === 0) {
        return;
      }
      const apply = show
        ? orpcClient.publicCatalog.publishProducts
        : orpcClient.publicCatalog.unpublishProducts;
      run(
        "products",
        async () => {
          for (const batch of inBatches(ids)) {
            // biome-ignore lint/performance/noAwaitInLoops: batches are applied one after the other
            await apply({ organizationId, productIds: batch });
          }
        },
        show ? "Produtos no catálogo." : "Produtos fora do catálogo.",
        true
      ).catch(() => undefined);
    },
    [organizationId, run]
  );

  return (
    <div className="public-catalog-page">
      <section className="categories-heading">
        <div>
          <p className="categories-eyebrow">Vitrine</p>
          <h1>Catálogo público</h1>
          <p className="categories-intro-copy">
            Mostre produtos a quem não tem conta, num endereço só seu. Só o que
            você escolher aparece: nome, descrição, fotos e preço de tabela.
            Custo, estoque e SKU nunca saem.
          </p>
        </div>
      </section>
      {error ? (
        <p className="public-catalog-message is-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="public-catalog-message is-success" role="status">
          {notice}
        </p>
      ) : null}
      {loading && !loaded ? <p role="status">Carregando…</p> : null}
      {planBlocks ? (
        <p className="public-catalog-message is-warning" role="status">
          O catálogo público faz parte do plano Pro. Você pode ver o que já está
          guardado, mas só poderá salvar o perfil e escolher produtos quando o
          plano incluir.
        </p>
      ) : null}
      {loaded && setup ? (
        <div className="public-catalog-workspace">
          <ProfileForm
            changed={changed}
            disabled={planBlocks}
            draft={draft}
            onChange={setDraft}
            onSlugEdited={handleSlugEdited}
            onSubmit={saveProfile}
            pending={pending}
            publicOrigin={setup.publicOrigin}
            slugEdited={slugEdited}
          />
          <SwitchCard
            changed={changed}
            onToggle={toggleCatalog}
            pending={pending}
            planBlocks={planBlocks}
            profile={profile}
            publicOrigin={setup.publicOrigin}
            visibility={visibility}
          />
          <ProductsCard
            onChange={changeProducts}
            pending={pending}
            planBlocks={planBlocks}
            products={loaded.products}
            shown={shown}
          />
        </div>
      ) : null}
    </div>
  );
}
