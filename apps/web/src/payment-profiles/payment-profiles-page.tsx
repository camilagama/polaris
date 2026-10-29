import type { PaymentProfileReadModel } from "@polaris/contracts";
import CircleAlertIcon from "lucide-react/dist/esm/icons/circle-alert";
import CircleCheckIcon from "lucide-react/dist/esm/icons/circle-check";
import PlusIcon from "lucide-react/dist/esm/icons/plus";
import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
import {
  type FormEvent,
  type Ref,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import { useConnectionReturn, workerAnswers } from "../lib/browser-connection";
import { useCurrentOrganization } from "../lib/current-organization";
import { focusLater } from "../lib/focus";
import { orpcClient } from "../lib/orpc";
import { readWithRetry } from "../lib/read-with-retry";
import {
  CHANGE_CUT_BY_SERVER,
  CHANGE_OUTCOME_UNKNOWN,
  commonFailureMessage,
  isConnectionFailure,
  isPlatformCut,
} from "../lib/rpc-error";
import { useHoldSwap } from "../lib/unsent-work";
import {
  blankDraft,
  blankRule,
  draftProblems,
  hasRepeatedRules,
  type ProfileDraft,
  profileDraft,
  profileDraftKey,
  type RuleDraft,
  ruleFieldId,
  ruleInput,
} from "./payment-profile-draft";
import { PaymentProfileForm } from "./payment-profile-form";
import { PaymentProfileList } from "./payment-profile-list";
import { ScreenTitle } from "../app-shell/screen-title";

const REPEATED_RULES_TEXT =
  "Remova regras repetidas para o mesmo método e combinação de parcelas.";

/** A save whose answer the connection cut: it may have been saved, so the text never says it was not. */
export const SAVE_NOT_CONFIRMED_TEXT =
  "Não deu para confirmar se o perfil foi salvo. Toque em Fechar e conferir: se ele não estiver na lista, abra de novo e salve.";
/** A save whose answer did not come, or that the server cut: it may have been saved. Null for any other failure. */
function saveNotConfirmedText(cause: unknown): string | null {
  if (isPlatformCut(cause)) {
    return `O servidor está ocupado. ${SAVE_NOT_CONFIRMED_TEXT}`;
  }
  return isConnectionFailure(cause) ? SAVE_NOT_CONFIRMED_TEXT : null;
}
/** What the form and the page say once it was closed to check: the draft is kept, and so is the doubt. */
const MAYBE_SAVED_TEXT = "Este perfil pode já ter sido salvo.";
const CHECK_AND_CLOSE_LABEL = "Fechar e conferir";

const GENERIC_ERROR_TEXT =
  "Não foi possível concluir a operação. Revise os dados e tente novamente.";
const LOAD_ERROR_TEXT = "Não foi possível carregar os perfis. Tente novamente.";

function errorText(
  error: unknown,
  subject?: string,
  fallback = GENERIC_ERROR_TEXT
): string {
  const common = commonFailureMessage(error, subject);
  if (common !== undefined) {
    return common;
  }
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  if (code === "UNAUTHORIZED") {
    return "Não foi possível concluir a operação com o perfil de pagamento.";
  }
  if (code === "FORBIDDEN") {
    return "Sua conta não tem acesso a esta loja ou a esta ação.";
  }
  if (code === "BAD_REQUEST") {
    return "Revise o método, as parcelas, o prazo e os valores das taxas.";
  }
  if (code === "CONFLICT") {
    return "Este perfil foi alterado em outra solicitação. Atualize a lista e tente novamente.";
  }
  if (code === "NOT_FOUND") {
    return "Este perfil não existe mais nesta loja.";
  }
  return fallback;
}

interface FeedbackProps {
  error: string | null;
  notice: string | null;
  /** The focus goes here when an action ends, so a person far down the page reads the result. */
  regionRef: Ref<HTMLDivElement>;
  /** The answer of a change the connection cut: not an error, not a success. */
  uncertain: string | null;
  /** The button of the doubt ("Fechar e conferir"), inside the amber notice. */
  uncertainAction?: { label: string; onClick: () => void } | undefined;
  /** A profile with the name typed is already on the list: says so, before it is made again. */
  warning?: string | null | undefined;
}

/** What the last action did, at the top of the screen; nothing is drawn (not even a gap) without a message. */
function ActionFeedback({
  error,
  notice,
  regionRef,
  uncertain,
  uncertainAction,
  warning,
}: FeedbackProps) {
  if (!(error || notice || uncertain || warning)) {
    return null;
  }
  return (
    <div
      className="focus-ring grid gap-2 rounded-lg"
      ref={regionRef}
      tabIndex={-1}
    >
      {error ? (
        <Alert variant="destructive">
          <CircleAlertIcon aria-hidden="true" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {uncertain ? (
        <Alert variant="warning">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertDescription
            className={
              uncertainAction
                ? "flex flex-wrap items-center gap-x-3 gap-y-1"
                : undefined
            }
          >
            {uncertain}
            {uncertainAction ? (
              <Button
                onClick={uncertainAction.onClick}
                size="sm"
                type="button"
                variant="outline"
              >
                {uncertainAction.label}
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {warning ? (
        <Alert variant="warning">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertDescription>{warning}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert>
          <CircleCheckIcon aria-hidden="true" />
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

export function PaymentProfilesPage() {
  const { organizationId } = useCurrentOrganization();
  const [profiles, setProfiles] = useState<PaymentProfileReadModel[]>([]);
  const [draft, setDraft] = useState<ProfileDraft>(blankDraft);
  const [editing, setEditing] = useState<PaymentProfileReadModel | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  // a refused save or action is fixed in the form; only a failed read can be tried again, in the list
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  // the list was not read for lack of a connection (not an empty list); read again when it returns
  const [notLoaded, setNotLoaded] = useState(false);
  // a change the connection cut: amber, the form stays, and it stays said after the list is read again
  const [uncertain, setUncertain] = useState<string | null>(null);
  // a create the connection cut may have been saved: the draft stays, and before it is sent again the list is checked
  const [maybeSaved, setMaybeSaved] = useState(false);
  const [duplicateAsk, setDuplicateAsk] = useState(false);
  // the draft kept when the form was closed by Esc or "Fechar": "new", or the id of the profile being edited
  const keptRef = useRef<string | null>(null);
  // the form is a dialog: it opens for a new profile or for an edit, and the draft is only cleared once it has closed
  const [formOpen, setFormOpen] = useState(false);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  // where the focus goes back to when the form closes without a message to read: what opened it
  const originRef = useRef<() => HTMLElement | null>(() => null);
  // the list stays on screen while it is read again after a save; "Carregando perfis…" is for the first read
  const readOnce = useRef<boolean>(false);
  const profilesRequest = useRef(0);
  useHoldSwap(
    !pending &&
      profileDraftKey(draft) !==
        profileDraftKey(editing ? profileDraft(editing) : blankDraft())
  );

  /** The focus moves in an effect, after the render that draws the message: a timer could run before it. */
  const [feedbackFocus, setFeedbackFocus] = useState(0);
  const focusFeedback = useCallback(
    () => setFeedbackFocus((count) => count + 1),
    []
  );
  useEffect(() => {
    if (feedbackFocus > 0) {
      feedbackRef.current?.focus();
    }
  }, [feedbackFocus]);

  // only a read: a save whose answer was cut is never sent again from here
  const loadProfiles = useCallback(async () => {
    profilesRequest.current += 1;
    const request = profilesRequest.current;
    const isLatest = () => request === profilesRequest.current;
    if (!readOnce.current) {
      setLoading(true);
    }
    setLoadError(null);
    try {
      const result = await readWithRetry(
        () => orpcClient.paymentProfile.list({ organizationId, status: "all" }),
        { isCurrent: isLatest }
      );
      if (!isLatest()) {
        return;
      }
      setProfiles(result.profiles);
      setNotLoaded(false);
      readOnce.current = true;
    } catch (cause) {
      if (!isLatest()) {
        return;
      }
      if (isConnectionFailure(cause) && !(await workerAnswers())) {
        setNotLoaded(true);
      } else {
        setLoadError(
          errorText(cause, "os perfis de pagamento", LOAD_ERROR_TEXT)
        );
      }
    } finally {
      if (isLatest()) {
        setLoading(false);
      }
    }
  }, [organizationId]);
  useEffect(() => {
    loadProfiles().catch(() => undefined);
  }, [loadProfiles]);
  // an isolated cut (the Worker still answers): the list is read now, never the change sent again
  const readAgainIfAnswers = useCallback(() => {
    workerAnswers()
      .then((answers) => (answers ? loadProfiles() : undefined))
      .catch(() => undefined);
  }, [loadProfiles]);
  // the connection came back: the list that did not load, or that a cut save may have changed, is read again
  const online = useConnectionReturn(() => {
    if (notLoaded || uncertain) {
      loadProfiles().catch(() => undefined);
    }
  });
  const handleRetry = useCallback(() => {
    loadProfiles().catch(() => undefined);
  }, [loadProfiles]);

  /** Changing a field takes away what was said about the fields and about the last save: it is old news. */
  const clearStaleMessages = useCallback(() => {
    setFieldErrors({});
    setError(null);
  }, []);
  const updateRule = useCallback(
    (draftId: string, changes: Partial<RuleDraft>) => {
      clearStaleMessages();
      setDraft((current) => ({
        ...current,
        rules: current.rules.map((rule) =>
          rule.draftId === draftId ? { ...rule, ...changes } : rule
        ),
      }));
    },
    [clearStaleMessages]
  );
  const handleNameChange = useCallback(
    (name: string) => {
      clearStaleMessages();
      setDuplicateAsk(false);
      setDraft((current) => ({ ...current, name }));
    },
    [clearStaleMessages]
  );
  const handleAddRule = useCallback(() => {
    const rule = blankRule();
    setDraft((current) => ({ ...current, rules: [...current.rules, rule] }));
    focusLater(() =>
      document.getElementById(ruleFieldId(rule, "method"))?.focus()
    );
  }, []);
  const handleRemoveRule = useCallback((draftId: string) => {
    setFieldErrors({});
    setDraft((current) => ({
      ...current,
      rules: current.rules.filter((rule) => rule.draftId !== draftId),
    }));
    // the button that was pressed is gone: the focus goes to the one that adds a rule, not to the top of the page
    focusLater(() => document.getElementById("payment-add-rule")?.focus());
  }, []);

  const handleNew = useCallback(() => {
    originRef.current = () => newButtonRef.current;
    if (keptRef.current !== "new") {
      setEditing(null);
      setDraft(blankDraft());
      setMaybeSaved(false);
    }
    keptRef.current = null;
    setDuplicateAsk(false);
    setFieldErrors({});
    setError(null);
    setNotice(null);
    setFormOpen(true);
  }, []);
  /** "Cancelar": the form closes and what was typed is thrown away, and with it the doubt about a save. */
  const handleCancelEdit = useCallback(() => {
    keptRef.current = null;
    if (maybeSaved) {
      setMaybeSaved(false);
      setUncertain(null);
    }
    setDuplicateAsk(false);
    setFormOpen(false);
    setFieldErrors({});
    setError(null);
  }, [maybeSaved]);
  /** Esc, "Fechar" and "Fechar e conferir": the form closes and the draft stays, in memory, with the doubt. */
  const handleDismiss = useCallback(() => {
    keptRef.current = editing?.id ?? "new";
    if (maybeSaved) {
      setUncertain(MAYBE_SAVED_TEXT);
    }
    setDuplicateAsk(false);
    setFormOpen(false);
    setFieldErrors({});
    setError(null);
  }, [editing, maybeSaved]);
  /** The form is empty again only once it has finished closing (and only when nothing was kept). */
  const handleFormClosed = useCallback(() => {
    if (keptRef.current === null) {
      setEditing(null);
      setDraft(blankDraft());
      setFieldErrors({});
    }
  }, []);
  /**
   * What the save said takes the focus when the form closes; a cancel (the notice was cleared when it opened) goes
   * back to what opened the form, even with the warning of a cut connection still on screen.
   */
  const finalFocus = useCallback(
    () => (notice ? feedbackRef.current : null) ?? originRef.current() ?? true,
    [notice]
  );

  const saveProfile = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      // offline nothing leaves and nothing typed is touched: the button says why
      if (!(online && draft.rules.length)) {
        return;
      }
      const problems = draftProblems(draft);
      setFieldErrors(problems);
      const [firstProblem] = Object.keys(problems);
      if (firstProblem) {
        // said at the field, with what is accepted; nothing goes to the server and nothing typed is touched (U-29)
        setError(null);
        setNotice(null);
        focusLater(() => document.getElementById(firstProblem)?.focus());
        return;
      }
      if (hasRepeatedRules(draft.rules)) {
        setError(REPEATED_RULES_TEXT);
        setNotice(null);
        focusFeedback();
        return;
      }
      // sent again after a cut answer: the profile may be on the list already (the name is not unique in the base)
      const wanted = draft.name.trim().toLowerCase();
      if (
        maybeSaved &&
        !editing &&
        !duplicateAsk &&
        profiles.some((profile) => profile.name.trim().toLowerCase() === wanted)
      ) {
        setDuplicateAsk(true);
        setError(null);
        setNotice(null);
        focusFeedback();
        return;
      }
      setPending(true);
      setError(null);
      setNotice(null);
      setUncertain(null);
      let saved = false;
      try {
        const rules = draft.rules.map(ruleInput);
        const name = draft.name.trim();
        if (editing) {
          await orpcClient.paymentProfile.update({
            expectedVersion: editing.version,
            id: editing.id,
            name,
            organizationId,
            rules,
          });
          setNotice(`Perfil “${name}” atualizado.`);
        } else {
          await orpcClient.paymentProfile.create({
            name,
            organizationId,
            rules,
          });
          setNotice(`Perfil “${name}” criado.`);
        }
        keptRef.current = null;
        setMaybeSaved(false);
        setDuplicateAsk(false);
        setFormOpen(false);
        saved = true;
        await loadProfiles();
      } catch (cause) {
        const notConfirmed = saveNotConfirmedText(cause);
        if (notConfirmed === null) {
          setError(errorText(cause));
        } else {
          setUncertain(notConfirmed);
          setMaybeSaved(true);
          readAgainIfAnswers();
        }
      } finally {
        setPending(false);
        // a save closes the form and the focus goes to the notice when it has closed (`finalFocus`); what failed is
        // said inside the form, which is still open
        if (!saved) {
          focusFeedback();
        }
      }
    },
    [
      draft,
      duplicateAsk,
      editing,
      focusFeedback,
      loadProfiles,
      maybeSaved,
      online,
      organizationId,
      profiles,
      readAgainIfAnswers,
    ]
  );
  const editProfile = useCallback((profile: PaymentProfileReadModel) => {
    // the "Editar" of the profile that opened the form
    originRef.current = () =>
      rootRef.current?.querySelector<HTMLElement>(
        `[data-profile-id="${profile.id}"] [data-profile-edit]`
      ) ?? null;
    if (keptRef.current !== profile.id) {
      setEditing(profile);
      setDraft(profileDraft(profile));
      setMaybeSaved(false);
    }
    keptRef.current = null;
    setDuplicateAsk(false);
    setFieldErrors({});
    setError(null);
    setNotice(null);
    setFormOpen(true);
  }, []);
  const changeLifecycle = useCallback(
    async (profile: PaymentProfileReadModel) => {
      setPending(true);
      setError(null);
      setNotice(null);
      setUncertain(null);
      try {
        const input = {
          expectedVersion: profile.version,
          id: profile.id,
          organizationId,
        };
        if (profile.status === "active") {
          await orpcClient.paymentProfile.archive(input);
          setNotice(`Perfil “${profile.name}” arquivado.`);
        } else {
          await orpcClient.paymentProfile.restore(input);
          setNotice(`Perfil “${profile.name}” restaurado.`);
        }
        await loadProfiles();
      } catch (cause) {
        if (isConnectionFailure(cause) || isPlatformCut(cause)) {
          setUncertain(
            isPlatformCut(cause) ? CHANGE_CUT_BY_SERVER : CHANGE_OUTCOME_UNKNOWN
          );
          readAgainIfAnswers();
        } else {
          setError(errorText(cause));
        }
      } finally {
        setPending(false);
        focusFeedback();
      }
    },
    [focusFeedback, loadProfiles, organizationId, readAgainIfAnswers]
  );
  const handleLifecycle = useCallback(
    (profile: PaymentProfileReadModel) => {
      // offline nothing leaves: the button says why (aria-describedby on the notice)
      if (online) {
        changeLifecycle(profile).catch(() => undefined);
      }
    },
    [changeLifecycle, online]
  );

  const visibleProfiles = profiles.filter(
    (profile) => showArchived || profile.status === "active"
  );
  return (
    <div ref={rootRef}>
      <div className="grid gap-4 font-sans text-foreground text-sm antialiased">
        <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div className="grid gap-1">
            <ScreenTitle>Formas de receber</ScreenTitle>
            <p className="text-muted-foreground text-support">
              Organize métodos, parcelamento, prazo de recebimento e taxas por
              perfil.
            </p>
          </div>
          <Button
            disabled={pending}
            onClick={handleNew}
            ref={newButtonRef}
            type="button"
          >
            <PlusIcon aria-hidden="true" data-icon="inline-start" />
            Novo perfil
          </Button>
        </header>
        {/* while the form is open it covers this part of the screen: what the actions say is said inside it */}
        {formOpen ? null : (
          <ActionFeedback
            error={error}
            notice={notice}
            regionRef={feedbackRef}
            uncertain={uncertain}
          />
        )}
        <PaymentProfileForm
          draft={draft}
          editingName={editing ? editing.name : null}
          errors={fieldErrors}
          feedback={
            formOpen ? (
              <ActionFeedback
                error={error}
                notice={null}
                regionRef={feedbackRef}
                uncertain={uncertain}
                uncertainAction={
                  uncertain === SAVE_NOT_CONFIRMED_TEXT
                    ? { label: CHECK_AND_CLOSE_LABEL, onClick: handleDismiss }
                    : undefined
                }
                warning={
                  duplicateAsk
                    ? `Já existe um perfil chamado “${draft.name.trim()}” na lista.`
                    : null
                }
              />
            ) : null
          }
          finalFocus={finalFocus}
          onAddRule={handleAddRule}
          onCancel={handleCancelEdit}
          onClosed={handleFormClosed}
          confirmDuplicate={duplicateAsk}
          onDismiss={handleDismiss}
          online={online}
          onNameChange={handleNameChange}
          onRemoveRule={handleRemoveRule}
          onSubmit={saveProfile}
          onUpdateRule={updateRule}
          open={formOpen}
          pending={pending}
        />
        <div className="grid items-start gap-4">
          <PaymentProfileList
            hasAnyProfile={profiles.length > 0}
            includeArchived={showArchived}
            loadError={loadError}
            loading={loading && online}
            notLoaded={notLoaded || (loading && !online)}
            onChangeLifecycle={handleLifecycle}
            onEdit={editProfile}
            onIncludeArchivedChange={setShowArchived}
            online={online}
            onRetry={handleRetry}
            pending={pending}
            profiles={visibleProfiles}
          />
        </div>
      </div>
    </div>
  );
}
