import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ChallengeSlot,
  EmailField,
  EntryAlert,
  PasswordField,
  useReveal,
} from "./entry-parts";
import { emailProblem, postAuth, signInOutcome } from "./password-model";
import {
  CREATE_ACCOUNT_LINK,
  EMAIL_LABEL,
  emailText,
  FORGOT_PASSWORD_LINK,
  failureText,
  GOOGLE_ACCOUNT_HELP,
  INCORRECT_CREDENTIALS,
  PASSWORD_LABEL,
  PASSWORD_REQUIRED,
  PAUSED_BUTTON_HINT,
  pausedText,
  SIGN_IN_BUTTON,
  SIGN_IN_BUTTON_PENDING,
} from "./password-texts";
import { challengeToken, useChallenge } from "./turnstile";

interface Pause {
  email: string;
  minutes: number;
  until: number;
}

const sameEmail = (a: string, b: string) =>
  a.trim().normalize("NFC").toLowerCase() ===
  b.trim().normalize("NFC").toLowerCase();

/**
 * The e-mail and password form of `/entrar` (AC-50, AC-62 to AC-65, AC-71, AC-72). A wrong password and an
 * e-mail with no account get the same line; the pause of an e-mail turns "Entrar" off for that e-mail only,
 * until it ends (V4). The password never leaves this component except in the body of the request.
 */
export function EmailSignInForm({
  disabled,
  onSignedIn,
  onUnverified,
  siteKey,
}: {
  disabled: boolean;
  onSignedIn: () => void;
  onUnverified: (email: string) => void;
  siteKey: string | null;
}) {
  const challenge = useChallenge(siteKey, "login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [visible, toggleVisible, hide] = useReveal();
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [alert, setAlert] = useState<{ help: boolean; text: string } | null>(
    null
  );
  const [pending, setPending] = useState(false);
  const [pause, setPause] = useState<Pause | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  // the pause ends by itself: "Entrar" comes back without a reload
  useEffect(() => {
    if (!pause) {
      return;
    }
    const timer = setTimeout(
      () => setPause(null),
      Math.max(0, pause.until - Date.now())
    );
    return () => clearTimeout(timer);
  }, [pause]);

  const paused = pause !== null && sameEmail(pause.email, email);

  const submit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (pending || paused) {
        return;
      }
      hide();
      setAlert(null);
      const emailIssue = emailText(emailProblem(email));
      const passwordIssue = password.length === 0 ? PASSWORD_REQUIRED : null;
      setEmailError(emailIssue);
      setPasswordError(passwordIssue);
      if (emailIssue) {
        emailRef.current?.focus();
        return;
      }
      if (passwordIssue) {
        passwordRef.current?.focus();
        return;
      }
      setPending(true);
      const challenged = await challengeToken(challenge);
      if ("failure" in challenged) {
        setPending(false);
        setAlert({
          help: false,
          text: failureText(challenged.failure, "sign-in"),
        });
        return;
      }
      const address = email.trim();
      const outcome = signInOutcome(
        await postAuth(
          "/api/auth/sign-in/email",
          { email: address, password, rememberMe: true },
          { turnstileToken: challenged.token }
        )
      );
      switch (outcome.kind) {
        case "signed-in":
          setPassword("");
          // the button stays pending: the page leaves
          onSignedIn();
          return;
        case "unverified":
          setPending(false);
          setPassword("");
          onUnverified(address);
          return;
        case "incorrect":
          setPending(false);
          // the password goes, the e-mail stays, the focus goes to the e-mail (corte, "Credencial incorreta")
          setPassword("");
          setAlert({ help: true, text: INCORRECT_CREDENTIALS });
          emailRef.current?.focus();
          return;
        case "locked": {
          setPending(false);
          setPassword("");
          const minutes = Math.ceil(outcome.retryAfterSeconds / 60);
          setPause({
            email: address,
            minutes,
            until: Date.now() + outcome.retryAfterSeconds * 1000,
          });
          return;
        }
        default:
          setPending(false);
          setAlert({
            help: false,
            text: failureText(outcome.failure, "sign-in"),
          });
      }
    },
    [
      challenge,
      email,
      hide,
      onSignedIn,
      onUnverified,
      password,
      paused,
      pending,
    ]
  );

  return (
    <form
      aria-label={SIGN_IN_BUTTON}
      className="sign-in-form"
      noValidate
      onSubmit={submit}
    >
      {paused && pause ? (
        <EntryAlert>
          {pausedText(pause.minutes)} {PAUSED_BUTTON_HINT}
        </EntryAlert>
      ) : null}
      {alert ? (
        <EntryAlert focus={false}>
          {alert.text}
          {alert.help ? (
            <>
              <br />
              {GOOGLE_ACCOUNT_HELP}
            </>
          ) : null}
        </EntryAlert>
      ) : null}
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
        autoComplete="current-password"
        error={passwordError}
        fieldRef={passwordRef}
        label={PASSWORD_LABEL}
        name="password"
        onChange={setPassword}
        onToggle={toggleVisible}
        value={password}
        visible={visible}
      />
      <ChallengeSlot challenge={challenge} />
      <button
        aria-busy={pending}
        className="sign-in-primary"
        disabled={
          disabled || pending || paused || challenge.state === "loading"
        }
        type="submit"
      >
        {pending ? SIGN_IN_BUTTON_PENDING : SIGN_IN_BUTTON}
      </button>
      <p className="sign-in-links">
        <a href="/esqueci-a-senha">{FORGOT_PASSWORD_LINK}</a>
        <a href="/criar-conta">{CREATE_ACCOUNT_LINK}</a>
      </p>
    </form>
  );
}
