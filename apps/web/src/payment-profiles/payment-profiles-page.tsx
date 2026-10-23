import type { PaymentProfileReadModel } from "@polaris/contracts";
import CircleAlertIcon from "lucide-react/dist/esm/icons/circle-alert";
import CircleCheckIcon from "lucide-react/dist/esm/icons/circle-check";
import {
  type FormEvent,
  type Ref,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Alert, AlertDescription } from "@/ui/alert";
import { useCurrentOrganization } from "../lib/current-organization";
import { focusLater } from "../lib/focus";
import { orpcClient } from "../lib/orpc";
import { legalAcceptanceMessage } from "../lib/rpc-error";
import { useReportUnsentWork } from "../lib/unsent-work";
import {
  blankDraft,
  blankRule,
  draftProblems,
  hasRepeatedRules,
  NAME_ID,
  type ProfileDraft,
  profileDraft,
  profileDraftKey,
  type RuleDraft,
  ruleFieldId,
  ruleInput,
} from "./payment-profile-draft";
import { PaymentProfileForm } from "./payment-profile-form";
import { PaymentProfileList } from "./payment-profile-list";

const REPEATED_RULES_TEXT =
  "Remova regras repetidas para o mesmo método e combinação de parcelas.";

const GENERIC_ERROR_TEXT =
  "Não foi possível concluir a operação. Revise os dados e tente novamente.";
const LOAD_ERROR_TEXT = "Não foi possível carregar os perfis. Tente novamente.";

function errorText(
  error: unknown,
  subject?: string,
  fallback = GENERIC_ERROR_TEXT
): string {
  const unaccepted = legalAcceptanceMessage(error, subject);
  if (unaccepted !== undefined) {
    return unaccepted;
  }
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  if (code === "UNAUTHORIZED") {
    return "Não foi possível concluir a operação com o perfil de pagamento.";
  }
  if (code === "FORBIDDEN") {
    return "Sua conta não tem acesso a esta organização ou ação.";
  }
  if (code === "BAD_REQUEST") {
    return "Revise o método, as parcelas, o prazo e os valores das taxas.";
  }
  if (code === "CONFLICT") {
    return "Este perfil foi alterado em outra solicitação. Atualize a lista e tente novamente.";
  }
  if (code === "NOT_FOUND") {
    return "Este perfil não existe mais nesta organização.";
  }
  return fallback;
}

interface FeedbackProps {
  error: string | null;
  notice: string | null;
  /** The focus goes here when an action ends, so a person far down the page reads the result. */
  regionRef: Ref<HTMLDivElement>;
}

/** What the last action did, at the top of the screen; nothing is drawn (not even a gap) without a message. */
function ActionFeedback({ error, notice, regionRef }: FeedbackProps) {
  if (!(error || notice)) {
    return null;
  }
  return (
    <div className="grid gap-2 outline-none" ref={regionRef} tabIndex={-1}>
      {error ? (
        <Alert variant="destructive">
          <CircleAlertIcon aria-hidden="true" />
          <AlertDescription>{error}</AlertDescription>
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
  const feedbackRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // the list stays on screen while it is read again after a save; "Carregando perfis…" is for the first read
  const readOnce = useRef<boolean>(false);
  useReportUnsentWork(
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

  const loadProfiles = useCallback(async () => {
    if (!readOnce.current) {
      setLoading(true);
    }
    setLoadError(null);
    try {
      const result = await orpcClient.paymentProfile.list({
        organizationId,
        status: "all",
      });
      setProfiles(result.profiles);
      readOnce.current = true;
    } catch (cause) {
      setLoadError(errorText(cause, "os perfis de pagamento", LOAD_ERROR_TEXT));
    } finally {
      setLoading(false);
    }
  }, [organizationId]);
  useEffect(() => {
    loadProfiles().catch(() => undefined);
  }, [loadProfiles]);
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

  /** Back to where the person was: the "Editar" of the profile that was open. */
  const focusEditButton = useCallback((profileId: string | undefined) => {
    focusLater(() =>
      rootRef.current
        ?.querySelector<HTMLElement>(
          `[data-profile-id="${profileId}"] [data-profile-edit]`
        )
        ?.focus()
    );
  }, []);
  const handleCancelEdit = useCallback(() => {
    focusEditButton(editing?.id);
    setEditing(null);
    setDraft(blankDraft());
    setFieldErrors({});
    setError(null);
  }, [editing, focusEditButton]);

  const saveProfile = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!draft.rules.length) {
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
      setPending(true);
      setError(null);
      setNotice(null);
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
        setEditing(null);
        setDraft(blankDraft());
        await loadProfiles();
      } catch (cause) {
        setError(errorText(cause));
      } finally {
        setPending(false);
        focusFeedback();
      }
    },
    [draft, editing, focusFeedback, loadProfiles, organizationId]
  );
  const editProfile = useCallback((profile: PaymentProfileReadModel) => {
    setEditing(profile);
    setDraft(profileDraft(profile));
    setFieldErrors({});
    setError(null);
    setNotice(null);
    focusLater(() => document.getElementById(NAME_ID)?.focus());
  }, []);
  const changeLifecycle = useCallback(
    async (profile: PaymentProfileReadModel) => {
      setPending(true);
      setError(null);
      setNotice(null);
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
        setError(errorText(cause));
      } finally {
        setPending(false);
        focusFeedback();
      }
    },
    [focusFeedback, loadProfiles, organizationId]
  );
  const handleLifecycle = useCallback(
    (profile: PaymentProfileReadModel) => {
      changeLifecycle(profile).catch(() => undefined);
    },
    [changeLifecycle]
  );

  const visibleProfiles = profiles.filter(
    (profile) => showArchived || profile.status === "active"
  );
  return (
    <div ref={rootRef}>
      <div
        className="grid gap-4 font-sans text-foreground text-sm antialiased"
        data-ui=""
      >
        <header className="grid gap-1">
          <h1 className="text-title">Perfis de pagamento</h1>
          <p className="text-muted-foreground text-support">
            Organize métodos, parcelamento, prazo de recebimento e taxas por
            perfil.
          </p>
        </header>
        <ActionFeedback error={error} notice={notice} regionRef={feedbackRef} />
        <div className="grid items-start gap-4 min-[56.25rem]:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <PaymentProfileForm
            draft={draft}
            editingName={editing ? editing.name : null}
            errors={fieldErrors}
            onAddRule={handleAddRule}
            onCancel={handleCancelEdit}
            onNameChange={handleNameChange}
            onRemoveRule={handleRemoveRule}
            onSubmit={saveProfile}
            onUpdateRule={updateRule}
            pending={pending}
          />
          <PaymentProfileList
            includeArchived={showArchived}
            loadError={loadError}
            loading={loading}
            onChangeLifecycle={handleLifecycle}
            onEdit={editProfile}
            onIncludeArchivedChange={setShowArchived}
            hasAnyProfile={profiles.length > 0}
            onRetry={handleRetry}
            pending={pending}
            profiles={visibleProfiles}
          />
        </div>
      </div>
    </div>
  );
}
