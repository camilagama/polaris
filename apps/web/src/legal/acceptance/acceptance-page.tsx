import {
  formatEffectiveFrom,
  LEGAL_PATHS,
  LEGAL_PENDING_EFFECTIVE_FROM,
  type LegalDocumentId,
} from "@polaris/domain/legal/legal-documents";
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { documentTitle } from "../../app-shell/navigation-model";
import {
  acceptanceReturnPath,
  announceLegalAcceptance,
} from "../../lib/legal-acceptance";
import { orpcClient } from "../../lib/orpc";
import { signInPath } from "../../lib/sign-in-path";
import { LogoutControl } from "../../offline/runtime/logout-control";
import { IdleRuntimeProvider } from "../../offline/runtime/runtime-provider";
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
import "../../sign-in/sign-in.css";
import "./acceptance.css";

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
    <ul className="acceptance-links">
      {(["terms", "privacy"] as const).map((document) => (
        <li key={document}>
          <a
            href={LEGAL_PATHS[document]}
            rel="noopener noreferrer"
            target="_blank"
          >
            {READ_LINK_TEXT[document]}
            <span className="visually-hidden"> ({NEW_TAB_HINT})</span>
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
    <ul className="acceptance-documents">
      {pending.map((item) => (
        <li key={item.document}>
          <p className="acceptance-document-title">
            {LEGAL_PAGE_TITLES[item.document]}
          </p>
          <p className="acceptance-document-version">{versionLine(item)}</p>
          {item.changes ? (
            <div className="acceptance-changes">
              <p className="acceptance-changes-title">
                {ACCEPTANCE_WHAT_CHANGED}
              </p>
              <p>{item.changes}</p>
            </div>
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
  const checkboxRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  // the missing box takes the focus itself (the alert is still announced); any other error takes it
  useEffect(() => {
    if (error && error !== ACCEPTANCE_CHECKBOX_MISSING) {
      errorRef.current?.focus();
    }
  }, [error]);

  const handleChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setChecked(event.target.checked);
    if (event.target.checked) {
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

  return (
    <form className="acceptance-form" noValidate onSubmit={handleSubmit}>
      <div className="acceptance-check">
        <input
          aria-describedby={error ? "acceptance-error" : undefined}
          aria-invalid={error === ACCEPTANCE_CHECKBOX_MISSING}
          checked={checked}
          id="acceptance-checkbox"
          onChange={handleChange}
          ref={checkboxRef}
          type="checkbox"
        />
        <label htmlFor="acceptance-checkbox">
          {acceptanceCheckboxLabel(pending)}
        </label>
      </div>
      {error ? (
        <p
          className="sign-in-alert"
          id="acceptance-error"
          ref={errorRef}
          role="alert"
          tabIndex={-1}
        >
          <span aria-hidden="true" className="sign-in-alert-icon">
            !
          </span>
          <span>{error}</span>
        </p>
      ) : null}
      <button
        aria-busy={saving}
        className="primary-button acceptance-continue"
        type="submit"
      >
        {saving ? ACCEPTANCE_SAVING : ACCEPTANCE_CONTINUE}
      </button>
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
    return (
      <p className="sign-in-status" role="status">
        {ACCEPTANCE_LOADING}
      </p>
    );
  }
  if (load.status === "session_required") {
    return (
      <p className="sign-in-status" role="status">
        {ACCEPTANCE_OPENING}
      </p>
    );
  }
  if (load.status === "error") {
    return (
      <>
        <p className="sign-in-alert" role="alert">
          <span aria-hidden="true" className="sign-in-alert-icon">
            !
          </span>
          <span>
            {load.offline ? ACCEPTANCE_OFFLINE : ACCEPTANCE_LOAD_FAILED}
          </span>
        </p>
        <button className="sign-in-retry" onClick={onRetry} type="button">
          {ACCEPTANCE_RETRY}
        </button>
      </>
    );
  }
  if (load.status === "done") {
    return (
      <>
        <p className="sign-in-support" role="status">
          {ACCEPTANCE_DONE}
        </p>
        <a className="primary-button acceptance-continue" href={returnTo}>
          {ACCEPTANCE_GO_ON}
        </a>
      </>
    );
  }
  return (
    <>
      <p className="sign-in-support">{acceptanceIntro(load.pending)}</p>
      <PendingList pending={load.pending} />
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
 * accept can leave. Kept minimal on purpose: the visual redesign restyles it later.
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
    <div className="ui-root sign-in-root">
      <main className="sign-in-main" id="conteudo">
        <section
          aria-labelledby="acceptance-title"
          className="sign-in-card acceptance-card"
        >
          <p className="sign-in-brand">
            <span aria-hidden="true" className="sign-in-brand-mark">
              P
            </span>
            <span>Polaris</span>
          </p>
          <h1 id="acceptance-title">{ACCEPTANCE_TITLE}</h1>
          {leaving ? (
            <p className="sign-in-status" role="status">
              {ACCEPTANCE_OPENING}
            </p>
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
          <ReadLinks />
          <IdleRuntimeProvider>
            <LogoutControl />
          </IdleRuntimeProvider>
        </section>
      </main>
    </div>
  );
}
