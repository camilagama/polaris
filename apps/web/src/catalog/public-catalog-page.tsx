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
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { useConnectionNoticeForm } from "../app-shell/connection-required-notice";
import { useConnectionReturn, workerAnswers } from "../lib/browser-connection";
import { useCurrentOrganization } from "../lib/current-organization";
import { orpcClient } from "../lib/orpc";
import { readWithRetry } from "../lib/read-with-retry";
import { CHANGE_OUTCOME_UNKNOWN, isConnectionFailure } from "../lib/rpc-error";
import { useReportUnsentWork } from "../lib/unsent-work";
import { LoadErrorNotice } from "./products-page-parts";
import {
  type ProfileFieldError,
  profileFieldError,
  publicCatalogErrorMessage,
} from "./public-catalog-errors";
import {
  draftFromProfile,
  hasProfileChanges,
  inBatches,
  type PublicProfileDraft,
  profileDraftProblem,
  profileRequest,
  visibilityOf,
} from "./public-catalog-model";
import {
  PLAN_NOTICE_ID,
  ProductsCard,
  ProfileForm,
  SwitchCard,
} from "./public-catalog-panels";
import { ListNotice } from "./screen-parts";
import { ScreenTitle } from "../app-shell/screen-title";

interface LoadedState {
  products: ProductReadModel[];
  setup: PublicCatalogSetupReadModel;
}

type Action = Parameters<typeof publicCatalogErrorMessage>[1];

/** What a command said, and the command it came from: it shows next to that command's button (U-49). */
interface Feedback {
  error: string | null;
  notice: string | null;
  /** `load` is the page itself: its message stays at the top. */
  where: Action;
}

const NO_FEEDBACK = { error: null, notice: null } as const;
const FIELD_PROBLEM_SUMMARY =
  "O perfil não foi salvo. Corrija o campo indicado acima.";
const INPUT_OF_FIELD = {
  description: "public-description",
  instagram: "public-instagram",
  publicName: "public-name",
  slug: "public-slug",
  whatsapp: "public-whatsapp",
} as const;

/** The feedback of one command, or nothing when the last message came from another. */
function feedbackOf(feedback: Feedback | null, where: Action) {
  return feedback?.where === where ? feedback : NO_FEEDBACK;
}

export function PublicCatalogPage() {
  const { organizationId } = useCurrentOrganization();
  const [loaded, setLoaded] = useState<LoadedState | null>(null);
  const [draft, setDraft] = useState<PublicProfileDraft>(() =>
    draftFromProfile(null)
  );
  const [slugEdited, setSlugEdited] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [problem, setProblem] = useState<ProfileFieldError | null>(null);
  // read again when the connection returns: the page that did not load, or what a cut command changed
  const [stale, setStale] = useState(false);
  useReportUnsentWork(
    loaded !== null && hasProfileChanges(draft, loaded.setup.profile)
  );
  // offline the notice says the typed text stays only when there is a form (it shows once the page loaded)
  useConnectionNoticeForm(loaded !== null);

  const load = useCallback(
    async (keepDraft: boolean) => {
      setLoading(true);
      try {
        const [setup, products] = await Promise.all([
          readWithRetry(() =>
            orpcClient.publicCatalog.setup({ organizationId })
          ),
          readWithRetry(() =>
            orpcClient.product.list({ organizationId, status: "active" })
          ),
        ]);
        setLoaded({ products: products.products, setup });
        setStale(false);
        if (!keepDraft) {
          setDraft(draftFromProfile(setup.profile));
          setSlugEdited(setup.profile !== null);
        }
      } catch (loadError) {
        if (isConnectionFailure(loadError) && !(await workerAnswers())) {
          setStale(true); // the connection notice says it; the page loads by itself on the return
        } else {
          setFeedback({
            error: publicCatalogErrorMessage(loadError, "load"),
            notice: null,
            where: "load",
          });
        }
      } finally {
        setLoading(false);
      }
    },
    [organizationId]
  );

  useEffect(() => {
    load(false).catch(() => undefined);
  }, [load]);

  const hasLoaded = loaded !== null;
  const online = useConnectionReturn(() => {
    if (stale) {
      // what was typed before the cut stays
      load(hasLoaded).catch(() => undefined);
    }
  });

  // the field with the error gets the focus once the form is enabled again (a disabled input takes no focus)
  useEffect(() => {
    if (problem && !pending) {
      document.getElementById(INPUT_OF_FIELD[problem.field])?.focus();
    }
  }, [problem, pending]);

  /** Runs a command, then reloads so the screen shows what the server holds. */
  const run = useCallback(
    async (
      action: Action,
      command: () => Promise<unknown>,
      success: string,
      keepDraft: boolean
    ) => {
      if (!online) {
        return; // nothing leaves offline; the button says why
      }
      setPending(true);
      setFeedback(null);
      setProblem(null);
      let failed = false;
      try {
        await command();
        setFeedback({ error: null, notice: success, where: action });
      } catch (commandError) {
        failed = true;
        const fieldError =
          action === "profile" ? profileFieldError(commandError) : null;
        if (isConnectionFailure(commandError)) {
          setFeedback({
            error: CHANGE_OUTCOME_UNKNOWN,
            notice: null,
            where: action,
          });
          if (!(await workerAnswers())) {
            setStale(true);
            return;
          }
          // an isolated cut (the Worker still answers): the page is read again below, the change never sent again
        } else if (fieldError) {
          // under its field, with the summary beside the button; what was typed stays as it is
          setProblem(fieldError);
          setFeedback({
            error: FIELD_PROBLEM_SUMMARY,
            notice: null,
            where: action,
          });
        } else {
          setFeedback({
            error: publicCatalogErrorMessage(commandError, action),
            notice: null,
            where: action,
          });
        }
      } finally {
        setPending(false);
      }
      // a refused command never takes the typed form back to what the server holds (U-48)
      await load(keepDraft || failed).catch(() => undefined);
    },
    [load, online]
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
  const handleDraftChange = useCallback((next: PublicProfileDraft) => {
    setDraft(next);
    setProblem(null);
    // what was said about the last save is old news once a field changes (U-56)
    setFeedback((current) => (current?.where === "profile" ? null : current));
  }, []);

  const saveProfile = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      // the same check the server runs, before the trip: the address is refused under its own field
      const refused = profileDraftProblem(draft);
      if (refused) {
        setProblem(refused);
        setFeedback({
          error: FIELD_PROBLEM_SUMMARY,
          notice: null,
          where: "profile",
        });
        return;
      }
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

  const handleRetry = useCallback(() => {
    setFeedback(null);
    load(false).catch(() => undefined);
  }, [load]);

  return (
    <div className="grid gap-4 font-sans text-foreground text-sm antialiased">
      <div className="grid gap-1">
        <ScreenTitle>Catálogo público</ScreenTitle>
        <p className="text-muted-foreground text-support">
          Mostre produtos a quem não tem conta, num endereço só seu. Só o que
          você escolher aparece: nome, descrição, fotos e preço de tabela.
          Custo, estoque e SKU nunca saem.
        </p>
      </div>
      {feedback?.where === "load" && feedback.error ? (
        <LoadErrorNotice message={feedback.error} onRetry={handleRetry} />
      ) : null}
      {loading && !loaded && online ? (
        <ListNotice>
          <p className="text-muted-foreground" role="status">
            Carregando…
          </p>
        </ListNotice>
      ) : null}
      {planBlocks ? (
        <Alert id={PLAN_NOTICE_ID} variant="warning">
          <AlertTitle>Seu plano não inclui o catálogo público.</AlertTitle>
          <AlertDescription>
            O catálogo público faz parte do plano Pro. Você pode ver o que já
            está guardado, mas só poderá salvar o perfil e escolher produtos
            quando o plano incluir.
          </AlertDescription>
        </Alert>
      ) : null}
      {loaded && setup ? (
        <div className="grid items-start gap-4 md:grid-cols-[minmax(0,1.1fr)_minmax(18rem,0.9fr)]">
          <ProfileForm
            changed={changed}
            disabled={planBlocks}
            draft={draft}
            feedback={feedbackOf(feedback, "profile")}
            onChange={handleDraftChange}
            online={online}
            onSlugEdited={handleSlugEdited}
            onSubmit={saveProfile}
            pending={pending}
            problem={problem}
            publicOrigin={setup.publicOrigin}
            slugEdited={slugEdited}
          />
          <SwitchCard
            changed={changed}
            feedback={feedbackOf(feedback, "switch")}
            online={online}
            onToggle={toggleCatalog}
            pending={pending}
            planBlocks={planBlocks}
            profile={profile}
            publicOrigin={setup.publicOrigin}
            visibility={visibility}
          />
          <div className="md:col-span-2">
            <ProductsCard
              feedback={feedbackOf(feedback, "products")}
              onChange={changeProducts}
              online={online}
              pending={pending}
              planBlocks={planBlocks}
              products={loaded.products}
              shown={shown}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
