import CloudOffIcon from "lucide-react/dist/esm/icons/cloud-off";
import { useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import { documentTitle } from "../app-shell/navigation-model";
import { parseSignInSearch } from "../lib/sign-in-path";
import { ConfirmEmailPanel } from "./confirm-email-page";
import { EmailSignInForm } from "./email-sign-in-form";
import {
  EntryAlert,
  EntryScreen,
  EntryStatus,
  GoogleButton,
  OrSeparator,
} from "./entry-ui";
import { useGoogleStart } from "./google-start";
import { CONFIRM_PENDING_SIGN_IN } from "./password-texts";
import {
  type AuthMethodsView,
  hasSession,
  loadAuthMethods,
  type SignInFailure,
} from "./sign-in-model";
import {
  errorText,
  GOOGLE_ERROR_HELP,
  GOOGLE_NOT_OFFERED,
  GOOGLE_RETRY,
  reasonText,
  SIGN_IN_BACK_ONLINE,
  SIGN_IN_CHECKING,
  SIGN_IN_ENTERING,
  SIGN_IN_FIRST_TIME,
  SIGN_IN_LIMIT,
  SIGN_IN_OFFLINE,
  SIGN_IN_PAGE_TITLE,
  SIGN_IN_TITLE,
  SIGN_IN_UNAVAILABLE,
} from "./sign-in-texts";

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

/** Always mounted, so a screen reader announces the change when the connection goes or returns. */
function ConnectionNotice({
  online,
  reconnected,
}: {
  online: boolean;
  reconnected: boolean;
}) {
  return (
    // always in the tree, so the change is announced; empty, it gives back the gap of the column
    <div className="grid empty:-mb-4" role="status">
      {online ? null : (
        // the region around it is the live one: the alert itself is no second status
        <Alert role="presentation" variant="warning">
          <CloudOffIcon aria-hidden="true" />
          <AlertDescription>{SIGN_IN_OFFLINE}</AlertDescription>
        </Alert>
      )}
      {online && reconnected ? (
        <p className="text-sm">{SIGN_IN_BACK_ONLINE}</p>
      ) : null}
    </div>
  );
}

type Unverified = (unverified: {
  email: string;
  siteKey: string | null;
}) => void;

/** Whether the password form shows, and the key of its challenge; no answer means Google alone. */
function passwordMethod(methods: AuthMethodsView | null): {
  on: boolean;
  siteKey: string | null;
} {
  return methods?.emailPassword
    ? { on: true, siteKey: methods.turnstileSiteKey }
    : { on: false, siteKey: null };
}

/** "ou" and the e-mail form, under the Google button: only with the password on (AC-46). */
function PasswordSection({
  onSignedIn,
  onUnverified,
  online,
  password,
  phase,
}: {
  onSignedIn: () => void;
  onUnverified: Unverified;
  online: boolean;
  password: { on: boolean; siteKey: string | null };
  phase: Phase;
}) {
  const { siteKey } = password;
  const handleUnverified = useCallback(
    (email: string) => onUnverified({ email, siteKey }),
    [onUnverified, siteKey]
  );
  // only once the lookups are done: someone who is already in never sees the form flash
  if (!password.on || phase !== "ready") {
    return null;
  }
  return (
    <>
      <OrSeparator />
      <EmailSignInForm
        disabled={!online}
        onSignedIn={onSignedIn}
        onUnverified={handleUnverified}
        siteKey={siteKey}
      />
    </>
  );
}

/**
 * `/entrar` (ADR 0100), v5.2: outside the app shell, with no organization; "Continuar com o Google" first, the
 * only ink button of the first state, and under "ou" the e-mail that opens the password. It only talks to the
 * auth server: the Google start, and a session lookup that sends someone who is already in (or just back from
 * Google) to `voltar`. Nothing is written to the browser: no token, no code, no e-mail.
 */
function SignInScreen({ onUnverified }: { onUnverified: Unverified }) {
  // read once: `voltar`, `motivo` and `erro` are the only things the address carries
  const [search] = useState(() => parseSignInSearch(window.location.search));
  const [online, setOnline] = useState(isOnline);
  // offline there is nothing to look up: the screen shows the button, off, with the reason
  const [phase, setPhase] = useState<Phase>(() =>
    isOnline() ? "checking" : "ready"
  );
  const [slowCheck, setSlowCheck] = useState(false);
  const [googleOff, setGoogleOff] = useState(false);
  // the password form shows only with the password on (AC-46), and with it the public key of the challenge
  const [password, setPassword] = useState<{
    on: boolean;
    siteKey: string | null;
  }>({ on: false, siteKey: null });
  const google = useGoogleStart(search.returnTo);
  const { startedRef } = google;
  const [reconnected, setReconnected] = useState(false);
  // bumped by "Tentar de novo" (Google off): the lookups run again
  const [lookupRound, setLookupRound] = useState(0);

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
          // the person already tapped the button while this was running: the Google start is under way, leave it be
          if (startedRef.current) {
            return;
          }
          setPhase("entering");
          window.location.replace(search.returnTo ?? "/");
          return;
        }
        setGoogleOff(methods?.google === false);
        setPassword(passwordMethod(methods));
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
  }, [online, search.reason, search.returnTo, lookupRound, startedRef]);

  const handleSignedIn = useCallback(() => {
    setPhase("entering");
    window.location.replace(search.returnTo ?? "/");
  }, [search.returnTo]);

  const handleRetry = useCallback(() => {
    setSlowCheck(false);
    setPhase("checking");
    setLookupRound((round) => round + 1);
  }, []);

  const alertText = google.failure
    ? failureText[google.failure]
    : (errorText(search.error) ?? (googleOff ? GOOGLE_NOT_OFFERED : null));
  const showGoogleHelp = google.failure === null && search.error === "google";

  const reason = reasonText(search.reason);
  // The button does not wait for the lookups, which only send away someone who is already in or turn it off: once
  // the check is slow it is there, active, beside "Verificando…". A quick check (the return from Google) never
  // shows it, so it does not flash before "Entrando…".
  const showButton =
    phase !== "entering" && (phase === "ready" || slowCheck || googleOff);

  return (
    <EntryScreen title={SIGN_IN_TITLE}>
      {reason ? <p className="text-sm">{reason}</p> : null}

      {alertText ? (
        <EntryAlert key={alertText}>
          {alertText}
          {showGoogleHelp ? (
            <>
              <br />
              {GOOGLE_ERROR_HELP}
            </>
          ) : null}
        </EntryAlert>
      ) : null}

      <ConnectionNotice online={online} reconnected={reconnected} />

      {phase === "entering" ? (
        <EntryStatus>{SIGN_IN_ENTERING}</EntryStatus>
      ) : null}
      {phase === "checking" && slowCheck ? (
        <EntryStatus>{SIGN_IN_CHECKING}</EntryStatus>
      ) : null}

      {showButton ? (
        <div className="grid gap-2">
          <GoogleButton
            disabled={!online || googleOff}
            onClick={google.start}
            pending={google.starting}
          />
          <p className="text-muted-foreground text-support">
            {SIGN_IN_FIRST_TIME}
          </p>
        </div>
      ) : null}

      {googleOff && online ? (
        <Button
          className="w-full"
          disabled={phase === "checking"}
          onClick={handleRetry}
          size="lg"
          type="button"
          variant="outline"
        >
          {GOOGLE_RETRY}
        </Button>
      ) : null}

      <PasswordSection
        online={online}
        onSignedIn={handleSignedIn}
        onUnverified={onUnverified}
        password={password}
        phase={phase}
      />
    </EntryScreen>
  );
}

/**
 * `/entrar`, or "Confirme seu e-mail" after a right password on an e-mail not yet confirmed: the address
 * stays in memory only (AC-50), never in the URL or in storage.
 */
export function SignInPage() {
  const [unverified, setUnverified] = useState<{
    email: string;
    siteKey: string | null;
  } | null>(null);
  if (unverified) {
    return (
      <ConfirmEmailPanel
        email={unverified.email}
        intro={CONFIRM_PENDING_SIGN_IN}
        siteKey={unverified.siteKey}
      />
    );
  }
  return <SignInScreen onUnverified={setUnverified} />;
}
