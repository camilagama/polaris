import { LEGAL_PATHS } from "@polaris/domain/legal/legal-documents";
import { useCallback, useEffect, useRef, useState } from "react";
import { documentTitle } from "../app-shell/navigation-model";
import { parseSignInSearch } from "../lib/sign-in-path";
import { GoogleLogo } from "./google-logo";
import {
  hasSession,
  loadAuthMethods,
  type SignInFailure,
  startGoogleSignIn,
} from "./sign-in-model";
import {
  errorText,
  GOOGLE_BUTTON,
  GOOGLE_BUTTON_PENDING,
  GOOGLE_ERROR_HELP,
  GOOGLE_NOT_OFFERED,
  LEGAL_LINKS_INTRO,
  NEW_TAB_HINT,
  PRIVACY_LINK,
  reasonText,
  SIGN_IN_BACK_ONLINE,
  SIGN_IN_CHECKING,
  SIGN_IN_ENTERING,
  SIGN_IN_LIMIT,
  SIGN_IN_OFFLINE,
  SIGN_IN_PAGE_TITLE,
  SIGN_IN_SUPPORT,
  SIGN_IN_TITLE,
  SIGN_IN_UNAVAILABLE,
  TERMS_LINK,
} from "./sign-in-texts";
import "./sign-in.css";

/** A lookup that takes longer than this says it is looking, instead of showing nothing. */
const SLOW_CHECK_MS = 400;

type Phase = "checking" | "entering" | "ready";

function isOnline(): boolean {
  return navigator.onLine;
}

const failureText: Readonly<Record<SignInFailure, string>> = {
  indisponivel: SIGN_IN_UNAVAILABLE,
  limite: SIGN_IN_LIMIT,
};

/** The two legal pages open in another tab, so a half-done sign-in is not lost (L1 of the legal pages). */
function LegalLinks() {
  return (
    <p className="sign-in-legal">
      <span>{LEGAL_LINKS_INTRO}</span>
      <a href={LEGAL_PATHS.terms} rel="noopener noreferrer" target="_blank">
        {TERMS_LINK}
        <span className="visually-hidden"> ({NEW_TAB_HINT})</span>
      </a>
      <span>e a</span>
      <a href={LEGAL_PATHS.privacy} rel="noopener noreferrer" target="_blank">
        {PRIVACY_LINK}
        <span className="visually-hidden"> ({NEW_TAB_HINT})</span>
      </a>
    </p>
  );
}

/**
 * `/entrar` (ADR 0100): outside the app shell, with no organization. It only talks to the auth server:
 * the Google start, and a session lookup that sends someone who is already in (or just back from
 * Google) to `voltar`. Nothing is written to the browser: no token, no code, no e-mail.
 */
export function SignInPage() {
  // read once: `voltar`, `motivo` and `erro` are the only things the address carries
  const [search] = useState(() => parseSignInSearch(window.location.search));
  const [online, setOnline] = useState(isOnline);
  // offline there is nothing to look up: the screen shows the button, off, with the reason
  const [phase, setPhase] = useState<Phase>(() =>
    isOnline() ? "checking" : "ready"
  );
  const [slowCheck, setSlowCheck] = useState(false);
  const [googleOff, setGoogleOff] = useState(false);
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<SignInFailure | null>(null);
  const [reconnected, setReconnected] = useState(false);
  const startedRef = useRef<boolean>(false);
  const alertRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    document.title = documentTitle(SIGN_IN_PAGE_TITLE);
  }, []);

  useEffect(() => {
    const goOnline = () => {
      setOnline(true);
      setReconnected(true);
    };
    const goOffline = () => {
      setOnline(false);
      setReconnected(false);
    };
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  // The page can come back from the browser's cache (the Back button from Google, mostly on iOS) with the
  // button still pending: it is ready again.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        startedRef.current = false;
        setStarting(false);
      }
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  // Someone who is already in goes straight to the destination; the same lookup is what a return from
  // Google meets. With no connection nothing goes to the network: the screen says so and waits.
  useEffect(() => {
    if (!online) {
      return;
    }
    let current = true;
    const slowTimer = setTimeout(() => setSlowCheck(true), SLOW_CHECK_MS);
    Promise.all([hasSession(), loadAuthMethods()])
      .then(([inside, methods]) => {
        if (!current) {
          return;
        }
        clearTimeout(slowTimer);
        // `motivo=sessao` says the app was just refused with this very session: going back to `voltar` would
        // be refused again and bring the person here again, so the screen stays and offers the button
        if (inside && search.reason !== "sessao") {
          setPhase("entering");
          window.location.replace(search.returnTo ?? "/");
          return;
        }
        setGoogleOff(methods?.google === false);
        setPhase("ready");
      })
      .catch(() => {
        if (current) {
          clearTimeout(slowTimer);
          setPhase("ready");
        }
      });
    return () => {
      current = false;
      clearTimeout(slowTimer);
    };
  }, [online, search.reason, search.returnTo]);

  const handleGoogle = useCallback(() => {
    if (startedRef.current) {
      return;
    }
    startedRef.current = true;
    setStarting(true);
    setFailure(null);
    startGoogleSignIn(search.returnTo)
      .then((result) => {
        if (result.status === "redirect") {
          // the page leaves: the button stays pending until it does
          window.location.assign(result.url);
          return;
        }
        startedRef.current = false;
        setStarting(false);
        setFailure(result.failure);
      })
      .catch(() => {
        startedRef.current = false;
        setStarting(false);
        setFailure("indisponivel");
      });
  }, [search.returnTo]);

  const alertText = failure
    ? failureText[failure]
    : (errorText(search.error) ?? (googleOff ? GOOGLE_NOT_OFFERED : null));
  const showGoogleHelp = failure === null && search.error === "google";
  useEffect(() => {
    if (alertText) {
      alertRef.current?.focus();
    }
  }, [alertText]);

  const reason = reasonText(search.reason);
  const showButton = phase === "ready";
  const buttonDisabled = starting || !online || googleOff;

  return (
    <div className="ui-root sign-in-root">
      <main className="sign-in-main" id="conteudo">
        <section aria-labelledby="sign-in-title" className="sign-in-card">
          <p className="sign-in-brand">
            <span aria-hidden="true" className="sign-in-brand-mark">
              P
            </span>
            <span>Polaris</span>
          </p>
          <h1 id="sign-in-title">{SIGN_IN_TITLE}</h1>
          <p className="sign-in-support">{SIGN_IN_SUPPORT}</p>
          {reason ? <p className="sign-in-reason">{reason}</p> : null}

          {alertText ? (
            <p
              className="sign-in-alert"
              ref={alertRef}
              role="alert"
              tabIndex={-1}
            >
              <span aria-hidden="true" className="sign-in-alert-icon">
                !
              </span>
              <span>
                {alertText}
                {showGoogleHelp ? (
                  <>
                    <br />
                    {GOOGLE_ERROR_HELP}
                  </>
                ) : null}
              </span>
            </p>
          ) : null}

          {phase === "entering" ? (
            <p className="sign-in-status" role="status">
              {SIGN_IN_ENTERING}
            </p>
          ) : null}
          {phase === "checking" && slowCheck ? (
            <p className="sign-in-status" role="status">
              {SIGN_IN_CHECKING}
            </p>
          ) : null}

          {showButton ? (
            <button
              aria-busy={starting}
              className="sign-in-google"
              disabled={buttonDisabled}
              onClick={handleGoogle}
              type="button"
            >
              <GoogleLogo />
              <span>{starting ? GOOGLE_BUTTON_PENDING : GOOGLE_BUTTON}</span>
            </button>
          ) : null}

          {/* always mounted, so a screen reader announces the change when the connection goes or returns */}
          <div className="sign-in-live" role="status">
            {online ? null : (
              <p className="sign-in-offline">
                <span aria-hidden="true" className="sign-in-alert-icon">
                  ×
                </span>
                <span>{SIGN_IN_OFFLINE}</span>
              </p>
            )}
            {online && reconnected ? (
              <p className="sign-in-status">{SIGN_IN_BACK_ONLINE}</p>
            ) : null}
          </div>

          <LegalLinks />
        </section>
      </main>
    </div>
  );
}
