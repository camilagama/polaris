import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { documentTitle } from "../app-shell/navigation-model";
import {
  ChallengeSlot,
  EmailField,
  EntryAlert,
  EntryFrame,
  EntryLinkButton,
  EntrySuccess,
  PasswordGate,
} from "./entry-parts";
import {
  commonFailure,
  emailProblem,
  type LinkOutcome,
  linkOutcome,
  postAuth,
  takeFragmentToken,
} from "./password-model";
import {
  BACK_TO_SIGN_IN,
  CONFIRM_CHECKING,
  CONFIRM_DONE,
  CONFIRM_DONE_TITLE,
  CONFIRM_EXPIRED,
  CONFIRM_GOOGLE_WAY,
  CONFIRM_INVALID,
  CONFIRM_NO_LINK,
  CONFIRM_NOT_ARRIVED,
  CONFIRM_PAGE_TITLE,
  CONFIRM_TITLE,
  EMAIL_LABEL,
  emailText,
  failureText,
  GO_TO_SIGN_IN,
  RESEND_ASK_EMAIL,
  RESEND_BUTTON,
  RESEND_BUTTON_PENDING,
  RESENT,
  RESENT_TYPED,
  TRY_AGAIN,
} from "./password-texts";
import { challengeToken, useChallenge } from "./turnstile";

/**
 * "Confirme seu e-mail" with the resend (AC-48, V1). The address comes from memory only (the form the
 * person just sent); without it (a reload, the link page) the panel asks for it. Never in the URL or
 * in storage.
 */
export function ConfirmEmailPanel({
  email,
  intro,
  siteKey,
}: {
  email: string | null;
  intro: string;
  siteKey: string | null;
}) {
  const challenge = useChallenge(siteKey, "verification_email");
  const [typed, setTyped] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [resent, setResent] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  const submit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (pending) {
        return;
      }
      const address = email ?? typed.trim();
      setAlert(null);
      setResent(false);
      if (email === null) {
        const problem = emailText(emailProblem(typed));
        setEmailError(problem);
        if (problem) {
          emailRef.current?.focus();
          return;
        }
      }
      setPending(true);
      const challenged = await challengeToken(challenge);
      if ("failure" in challenged) {
        setPending(false);
        setAlert(failureText(challenged.failure, "email"));
        return;
      }
      const answer = await postAuth(
        "/api/auth/send-verification-email",
        { email: address },
        { turnstileToken: challenged.token }
      );
      setPending(false);
      if (answer.status >= 200 && answer.status < 300) {
        setResent(true);
        return;
      }
      setAlert(failureText(commonFailure(answer), "email"));
    },
    [challenge, email, pending, typed]
  );

  return (
    <EntryFrame title={CONFIRM_TITLE}>
      <p className="sign-in-support">{intro}</p>
      {resent ? (
        // the address typed on this page gets the same answer with or without an account (AC-49): no promise
        <EntrySuccess>{email === null ? RESENT_TYPED : RESENT}</EntrySuccess>
      ) : null}
      {alert ? <EntryAlert>{alert}</EntryAlert> : null}
      <form className="sign-in-form" noValidate onSubmit={submit}>
        <h2 className="sign-in-subtitle">{CONFIRM_NOT_ARRIVED}</h2>
        {email === null ? (
          <>
            <p className="sign-in-support">{RESEND_ASK_EMAIL}</p>
            <EmailField
              autoComplete="username"
              error={emailError}
              fieldRef={emailRef}
              label={EMAIL_LABEL}
              name="email"
              onChange={setTyped}
              value={typed}
            />
          </>
        ) : null}
        <ChallengeSlot challenge={challenge} />
        <button
          aria-busy={pending}
          className="sign-in-secondary"
          disabled={pending || challenge.state === "loading"}
          type="submit"
        >
          {pending ? RESEND_BUTTON_PENDING : RESEND_BUTTON}
        </button>
      </form>
      <p className="sign-in-support">{CONFIRM_GOOGLE_WAY}</p>
      <p className="sign-in-links">
        <a href="/entrar">{BACK_TO_SIGN_IN}</a>
      </p>
    </EntryFrame>
  );
}

type Verification = "checking" | LinkOutcome;

function VerifyLink({
  siteKey,
  token,
}: {
  siteKey: string | null;
  token: string;
}) {
  const [state, setState] = useState<Verification>("checking");
  const startedRef = useRef<boolean>(false);

  const verify = useCallback(() => {
    setState("checking");
    postAuth("/api/email-verification", { token })
      .then((answer) => setState(linkOutcome(answer)))
      .catch(() => setState("unavailable"));
  }, [token]);

  useEffect(() => {
    // one request per page load; "Tentar de novo" asks again
    if (!startedRef.current) {
      startedRef.current = true;
      verify();
    }
  }, [verify]);

  if (state === "done") {
    return (
      <EntryFrame title={CONFIRM_DONE_TITLE}>
        <EntrySuccess>{CONFIRM_DONE}</EntrySuccess>
        <EntryLinkButton href="/entrar">{GO_TO_SIGN_IN}</EntryLinkButton>
      </EntryFrame>
    );
  }
  if (state === "expired" || state === "invalid") {
    return (
      <ConfirmEmailPanel
        email={null}
        intro={state === "expired" ? CONFIRM_EXPIRED : CONFIRM_INVALID}
        siteKey={siteKey}
      />
    );
  }
  return (
    <EntryFrame title={CONFIRM_TITLE}>
      {state === "checking" ? (
        <p className="sign-in-status" role="status">
          {CONFIRM_CHECKING}
        </p>
      ) : (
        <>
          <EntryAlert>
            {failureText(state === "limit" ? "limit" : "unavailable", "other")}
          </EntryAlert>
          <button className="sign-in-retry" onClick={verify} type="button">
            {TRY_AGAIN}
          </button>
        </>
      )}
    </EntryFrame>
  );
}

/**
 * `/confirmar-email#token=…` (AC-48): the token leaves the address bar on the first render and goes in
 * the body of `POST /api/email-verification`. A link used before answers "confirmed" again, so a reload
 * never shows a false "link expired" (V2); with no token the page offers a new e-mail.
 */
export function ConfirmEmailPage() {
  const [token] = useState(() =>
    takeFragmentToken(window.location, window.history)
  );
  useEffect(() => {
    document.title = documentTitle(CONFIRM_PAGE_TITLE);
  }, []);
  return (
    <PasswordGate title={CONFIRM_TITLE}>
      {(siteKey) =>
        token ? (
          <VerifyLink siteKey={siteKey} token={token} />
        ) : (
          <ConfirmEmailPanel
            email={null}
            intro={CONFIRM_NO_LINK}
            siteKey={siteKey}
          />
        )
      }
    </PasswordGate>
  );
}
