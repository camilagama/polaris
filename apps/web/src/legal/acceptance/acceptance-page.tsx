import {
  formatEffectiveFrom,
  LEGAL_PATHS,
  LEGAL_PENDING_EFFECTIVE_FROM,
  type LegalDocumentId,
} from "@polaris/domain/legal/legal-documents";
import InfoIcon from "lucide-react/dist/esm/icons/info";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/checkbox";
import { Field, FieldError, FieldLabel } from "@/ui/field";
import { documentTitle } from "../../app-shell/navigation-model";
import {
  acceptanceReturnPath,
  announceLegalAcceptance,
} from "../../lib/legal-acceptance";
import { orpcClient } from "../../lib/orpc";
import { signInPath } from "../../lib/sign-in-path";
import { LogoutControl } from "../../offline/runtime/logout-control";
import { IdleRuntimeProvider } from "../../offline/runtime/runtime-provider";
import {
  EntryAlert,
  EntryLinkButton,
  EntryScreen,
  EntryStatus,
  EntrySuccess,
  SubmitButton,
  TEXT_LINK,
} from "../../sign-in/entry-ui";
import { LEGAL_PAGE_TITLES } from "../legal-routes";
import {
  type AcceptanceLoad,
  acceptanceCheckboxLabel,
  acceptanceIntro,
  acceptanceLoadAfterFailure,
  acceptanceLoadFrom,
  acceptanceSubmitFailure,
  type PendingLegalDocument,
} from "./acceptance-model";
import {
  ACCEPTANCE_CHECKBOX_MISSING,
  ACCEPTANCE_CONTINUE,
  ACCEPTANCE_DONE,
  ACCEPTANCE_GO_ON,
  ACCEPTANCE_LOAD_FAILED,
  ACCEPTANCE_LOADING,
  ACCEPTANCE_OFFLINE,
  ACCEPTANCE_OPENING,
  ACCEPTANCE_READ_PRIVACY,
  ACCEPTANCE_READ_TERMS,
  ACCEPTANCE_RETRY,
  ACCEPTANCE_SAVE_FAILED,
  ACCEPTANCE_SAVING,
  ACCEPTANCE_TITLE,
  ACCEPTANCE_VERSION_CHANGED,
  ACCEPTANCE_WHAT_CHANGED,
  NEW_TAB_HINT,
} from "./acceptance-texts";

const READ_LINK_TEXT: Readonly<Record<LegalDocumentId, string>> = {
  privacy: ACCEPTANCE_READ_PRIVACY,
  terms: ACCEPTANCE_READ_TERMS,
};

function versionLine(item: PendingLegalDocument): string {
  const since =
    item.effectiveFrom === null
      ? LEGAL_PENDING_EFFECTIVE_FROM
      : formatEffectiveFrom(item.effectiveFrom);
  return `Versão ${item.version}. Em vigor desde: ${since}.`;
}

/** Both pages are linked, always, and open in another tab so the box keeps its state (AC-70, L1). */
function ReadLinks() {
  return (
    <ul className="m-0 flex list-none flex-wrap gap-x-6 p-0 text-sm">
      {(["terms", "privacy"] as const).map((document) => (
        <li className="flex min-h-8 touch:min-h-12 items-center" key={document}>
          <a
            className={TEXT_LINK}
            href={LEGAL_PATHS[document]}
            rel="noopener noreferrer"
            target="_blank"
          >
            {READ_LINK_TEXT[document]}
            <span className="sr-only"> ({NEW_TAB_HINT})</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

function PendingList({
  pending,
}: {
  pending: readonly PendingLegalDocument[];
}) {
  return (
    <ul className="m-0 grid list-none gap-3 p-0">
      {pending.map((item) => (
        <li className="grid gap-1.5" key={item.document}>
          <div className="grid">
            <p className="font-medium">{LEGAL_PAGE_TITLES[item.document]}</p>
            <p className="text-muted-foreground text-support">
              {versionLine(item)}
            </p>
          </div>
          {item.changes ? (
            <Alert className="bg-muted/60 text-foreground">
              <InfoIcon aria-hidden="true" className="text-muted-foreground" />
              <AlertTitle>{ACCEPTANCE_WHAT_CHANGED}</AlertTitle>
              <AlertDescription className="text-foreground">
                {item.changes}
              </AlertDescription>
            </Alert>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

interface AcceptanceFormProps {
  onAccepted: () => void;
  onSessionRequired: () => void;
  onVersionChanged: () => void;
  pending: readonly PendingLegalDocument[];
  versionChanged: boolean;
}

/**
 * The box starts unticked and "Continuar" is never disabled for want of it: the screen says what is
 * missing (V6). Only the server records the acceptance; this screen sends the versions it shows.
 */
function AcceptanceForm({
  onAccepted,
  onSessionRequired,
  onVersionChanged,
  pending,
  versionChanged,
}: AcceptanceFormProps) {
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(
    versionChanged ? ACCEPTANCE_VERSION_CHANGED : null
  );
  const checkboxRef = useRef<HTMLSpanElement>(null);

  const handleChange = useCallback((value: boolean) => {
    setChecked(value);
    if (value) {
      setError(null);
    }
  }, []);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (saving) {
        return;
      }
      if (!checked) {
        setError(ACCEPTANCE_CHECKBOX_MISSING);
        checkboxRef.current?.focus();
        return;
      }
      setSaving(true);
      setError(null);
      orpcClient.account
        .acceptLegal({
          documents: pending.map((item) => ({
            document: item.document,
            version: item.version,
          })),
        })
        .then((result) => {
          if (result.pending.length === 0) {
            onAccepted();
            return;
          }
          setSaving(false);
          onVersionChanged();
        })
        .catch((failure: unknown) => {
          setSaving(false);
          const kind = acceptanceSubmitFailure(failure);
          if (kind === "session_required") {
            onSessionRequired();
          } else if (kind === "version_changed") {
            onVersionChanged();
          } else {
            setError(
              navigator.onLine ? ACCEPTANCE_SAVE_FAILED : ACCEPTANCE_OFFLINE
            );
          }
        });
    },
    [checked, onAccepted, onSessionRequired, onVersionChanged, pending, saving]
  );

  // the missing box takes the focus itself and says so at the box; any other error is an alert of the page
  const boxMissing = error === ACCEPTANCE_CHECKBOX_MISSING;
  return (
    <form
      aria-label={ACCEPTANCE_TITLE}
      className="flex flex-col gap-5"
      noValidate
      onSubmit={handleSubmit}
    >
      <Field
        className="items-start gap-4"
        data-invalid={boxMissing || undefined}
        orientation="horizontal"
      >
        <Checkbox
          aria-describedby={boxMissing ? "acceptance-error" : undefined}
          aria-invalid={boxMissing || undefined}
          checked={checked}
          className="mt-0.5"
          id="acceptance-checkbox"
          onCheckedChange={handleChange}
          ref={checkboxRef}
        />
        <div className="grid gap-1">
          <FieldLabel
            className="block font-normal leading-5"
            htmlFor="acceptance-checkbox"
          >
            {acceptanceCheckboxLabel(pending)}
          </FieldLabel>
          {boxMissing ? (
            <FieldError id="acceptance-error">{error}</FieldError>
          ) : null}
        </div>
      </Field>
      {error && !boxMissing ? (
        <EntryAlert id="acceptance-error" key={error}>
          {error}
        </EntryAlert>
      ) : null}
      <SubmitButton pending={saving} pendingText={ACCEPTANCE_SAVING}>
        {ACCEPTANCE_CONTINUE}
      </SubmitButton>
    </form>
  );
}

function AcceptanceBody({
  load,
  onAccepted,
  onRetry,
  onSessionRequired,
  onVersionChanged,
  returnTo,
  round,
  versionChanged,
}: {
  load: AcceptanceLoad;
  onAccepted: () => void;
  onRetry: () => void;
  onSessionRequired: () => void;
  onVersionChanged: () => void;
  returnTo: string;
  round: number;
  versionChanged: boolean;
}) {
  if (load.status === "loading") {
    return <EntryStatus>{ACCEPTANCE_LOADING}</EntryStatus>;
  }
  if (load.status === "session_required") {
    return <EntryStatus>{ACCEPTANCE_OPENING}</EntryStatus>;
  }
  if (load.status === "error") {
    return (
      <>
        <EntryAlert>
          {load.offline ? ACCEPTANCE_OFFLINE : ACCEPTANCE_LOAD_FAILED}
        </EntryAlert>
        <Button
          className="w-full"
          onClick={onRetry}
          size="lg"
          type="button"
          variant="outline"
        >
          {ACCEPTANCE_RETRY}
        </Button>
      </>
    );
  }
  if (load.status === "done") {
    return (
      <>
        <EntrySuccess>{ACCEPTANCE_DONE}</EntrySuccess>
        <EntryLinkButton href={returnTo}>{ACCEPTANCE_GO_ON}</EntryLinkButton>
      </>
    );
  }
  return (
    <>
      <PendingList pending={load.pending} />
      {/* the reading comes before the box and the button: "li" has to be true */}
      <ReadLinks />
      <AcceptanceForm
        // a new read (the versions changed) starts the form again, with the box unticked
        key={round}
        onAccepted={onAccepted}
        onSessionRequired={onSessionRequired}
        onVersionChanged={onVersionChanged}
        pending={load.pending}
        versionChanged={versionChanged}
      />
    </>
  );
}

/**
 * `/aceite` (ADR 0100): outside the shell, with no menu and no organization. It reads what is still to
 * accept, records the acceptance and goes back to `voltar`. "Sair" stays, so a person who does not
 * accept can leave. On the entry card of the interface v5.1.
 */
export function AcceptancePage() {
  const [returnTo] = useState(() =>
    acceptanceReturnPath(window.location.search)
  );
  const [load, setLoad] = useState<AcceptanceLoad>({ status: "loading" });
  const [round, setRound] = useState(0);
  const [versionChanged, setVersionChanged] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    document.title = documentTitle(ACCEPTANCE_TITLE);
  }, []);

  useEffect(() => {
    let current = true;
    setLoad({ status: "loading" });
    orpcClient.account
      .legalStatus()
      .then((status) => {
        if (current) {
          setLoad(acceptanceLoadFrom(status.pending));
        }
      })
      .catch((error: unknown) => {
        if (current) {
          setLoad(acceptanceLoadAfterFailure(error, navigator.onLine));
        }
      });
    return () => {
      current = false;
    };
  }, [round]);

  // no session: the sign-in screen, coming back here afterwards
  useEffect(() => {
    if (load.status === "session_required") {
      window.location.assign(
        signInPath({
          reason: "sessao",
          returnTo: `${window.location.pathname}${window.location.search}`,
        })
      );
    }
  }, [load.status]);

  // offline, the retry happens by itself when the connection comes back
  useEffect(() => {
    if (load.status !== "error" || !load.offline) {
      return;
    }
    const retry = () => setRound((value) => value + 1);
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [load]);

  const handleRetry = useCallback(() => {
    setVersionChanged(false);
    setRound((value) => value + 1);
  }, []);
  const handleVersionChanged = useCallback(() => {
    setVersionChanged(true);
    setRound((value) => value + 1);
  }, []);
  const handleSessionRequired = useCallback(
    () => setLoad({ status: "session_required" }),
    []
  );
  const handleAccepted = useCallback(() => {
    setLeaving(true);
    announceLegalAcceptance();
    window.location.replace(returnTo);
  }, [returnTo]);

  return (
    <EntryScreen
      legalLinks={false}
      support={
        load.status === "pending" ? acceptanceIntro(load.pending) : undefined
      }
      title={ACCEPTANCE_TITLE}
      width="wide"
    >
      {leaving ? (
        <EntryStatus>{ACCEPTANCE_OPENING}</EntryStatus>
      ) : (
        <AcceptanceBody
          load={load}
          onAccepted={handleAccepted}
          onRetry={handleRetry}
          onSessionRequired={handleSessionRequired}
          onVersionChanged={handleVersionChanged}
          returnTo={returnTo}
          round={round}
          versionChanged={versionChanged}
        />
      )}
      {leaving || load.status !== "pending" ? <ReadLinks /> : null}
      <IdleRuntimeProvider>
        <LogoutControl shell />
      </IdleRuntimeProvider>
    </EntryScreen>
  );
}
