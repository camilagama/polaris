import { LEGAL_PATHS } from "@polaris/domain/legal/legal-documents";
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { documentTitle } from "../app-shell/navigation-model";
import { ConfirmEmailPanel } from "./confirm-email-page";
import {
  ChallengeSlot,
  EmailField,
  EntryAlert,
  EntryFrame,
  PasswordField,
  PasswordGate,
  useReveal,
} from "./entry-parts";
import {
  emailProblem,
  newPasswordProblem,
  postAuth,
  signUpLegalAcceptance,
  signUpOutcome,
} from "./password-model";
import {
  ACCEPT_AND,
  ACCEPT_PREFIX,
  ACCEPT_REQUIRED,
  confirmSentText,
  EMAIL_LABEL,
  emailText,
  failureText,
  GO_TO_SIGN_IN,
  HAVE_ACCOUNT,
  newPasswordText,
  PASSWORD_LABEL,
  PASSWORD_RULE,
  SIGN_UP_BUTTON,
  SIGN_UP_BUTTON_PENDING,
  SIGN_UP_PAGE_TITLE,
  SIGN_UP_SUPPORT,
  SIGN_UP_TITLE,
} from "./password-texts";
import { NEW_TAB_HINT, PRIVACY_LINK, TERMS_LINK } from "./sign-in-texts";
import { challengeToken, useChallenge } from "./turnstile";

function SignUpForm({ siteKey }: { siteKey: string | null }) {
  const challenge = useChallenge(siteKey, "signup");
  const acceptId = useId();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [visible, toggleVisible, hide] = useReveal();
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // the address the confirmation was sent to: memory only, gone with a reload
  const [sentTo, setSentTo] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const acceptRef = useRef<HTMLInputElement>(null);

  const handleAccept = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setAccepted(event.target.checked);
    if (event.target.checked) {
      setAcceptError(null);
    }
  }, []);

  const submit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (pending) {
        return;
      }
      hide();
      setAlert(null);
      const emailIssue = emailText(emailProblem(email));
      const passwordIssue = newPasswordProblem(password);
      // the button is never off for want of the box (V6): the screen says what is missing
      const acceptIssue = accepted ? null : ACCEPT_REQUIRED;
      setEmailError(emailIssue);
      setPasswordError(passwordIssue ? newPasswordText(passwordIssue) : null);
      setAcceptError(acceptIssue);
      if (emailIssue) {
        emailRef.current?.focus();
        return;
      }
      if (passwordIssue) {
        passwordRef.current?.focus();
        return;
      }
      if (acceptIssue) {
        acceptRef.current?.focus();
        return;
      }
      setPending(true);
      const challenged = await challengeToken(challenge);
      if ("failure" in challenged) {
        setPending(false);
        setAlert(failureText(challenged.failure, "email"));
        return;
      }
      const address = email.trim();
      const outcome = signUpOutcome(
        await postAuth(
          "/api/auth/sign-up/email",
          {
            email: address,
            legalAcceptance: signUpLegalAcceptance(),
            name: "",
            password,
          },
          { turnstileToken: challenged.token }
        )
      );
      setPending(false);
      switch (outcome.kind) {
        case "created":
          setPassword("");
          setSentTo(address);
          return;
        case "acceptance":
          setAcceptError(ACCEPT_REQUIRED);
          acceptRef.current?.focus();
          return;
        case "password":
          setPasswordError(newPasswordText(outcome.problem));
          passwordRef.current?.focus();
          return;
        default:
          setAlert(failureText(outcome.failure, "email"));
      }
    },
    [accepted, challenge, email, hide, password, pending]
  );

  if (sentTo !== null) {
    return (
      <ConfirmEmailPanel
        email={sentTo}
        intro={confirmSentText(sentTo)}
        siteKey={siteKey}
      />
    );
  }

  return (
    <EntryFrame title={SIGN_UP_TITLE}>
      <p className="sign-in-support">{SIGN_UP_SUPPORT}</p>
      {alert ? <EntryAlert>{alert}</EntryAlert> : null}
      <form className="sign-in-form" noValidate onSubmit={submit}>
        <EmailField
          autoComplete="username"
          error={emailError}
          fieldRef={emailRef}
          label={EMAIL_LABEL}
          name="email"
          onChange={setEmail}
          value={email}
        />
        <PasswordField
          autoComplete="new-password"
          error={passwordError}
          fieldRef={passwordRef}
          hint={PASSWORD_RULE}
          label={PASSWORD_LABEL}
          name="new-password"
          onChange={setPassword}
          onToggle={toggleVisible}
          value={password}
          visible={visible}
        />
        <div className="sign-in-accept">
          <input
            aria-describedby={acceptError ? `${acceptId}-error` : undefined}
            aria-invalid={acceptError !== null}
            checked={accepted}
            id={acceptId}
            onChange={handleAccept}
            ref={acceptRef}
            type="checkbox"
          />
          <label htmlFor={acceptId}>
            {ACCEPT_PREFIX}{" "}
            <a
              href={LEGAL_PATHS.terms}
              rel="noopener noreferrer"
              target="_blank"
            >
              {TERMS_LINK}
              <span className="visually-hidden"> ({NEW_TAB_HINT})</span>
            </a>{" "}
            {ACCEPT_AND}{" "}
            <a
              href={LEGAL_PATHS.privacy}
              rel="noopener noreferrer"
              target="_blank"
            >
              {PRIVACY_LINK}
              <span className="visually-hidden"> ({NEW_TAB_HINT})</span>
            </a>
            .
          </label>
          {acceptError ? (
            <p className="sign-in-field-error" id={`${acceptId}-error`}>
              {acceptError}
            </p>
          ) : null}
        </div>
        <ChallengeSlot challenge={challenge} />
        <button
          aria-busy={pending}
          className="sign-in-primary"
          disabled={pending || challenge.state === "loading"}
          type="submit"
        >
          {pending ? SIGN_UP_BUTTON_PENDING : SIGN_UP_BUTTON}
        </button>
      </form>
      <p className="sign-in-links">
        {HAVE_ACCOUNT} <a href="/entrar">{GO_TO_SIGN_IN}</a>
      </p>
    </EntryFrame>
  );
}

/**
 * `/criar-conta` (AC-47, AC-49, AC-68): e-mail, password with the rule said before typing, the acceptance
 * box (unchecked, refused by the server too) and the challenge. An e-mail that has an account gets the
 * same "Confirme seu e-mail" as a new one.
 */
export function SignUpPage() {
  useEffect(() => {
    document.title = documentTitle(SIGN_UP_PAGE_TITLE);
  }, []);
  return (
    <PasswordGate title={SIGN_UP_TITLE}>
      {(siteKey) => <SignUpForm siteKey={siteKey} />}
    </PasswordGate>
  );
}
