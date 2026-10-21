import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { useReveal } from "./entry-parts";
import { isCompleteEmail } from "./entry-progressive";
import {
  ChallengeArea,
  EmailInput,
  EntryAlert,
  PasswordInput,
  Progressive,
  SubmitButton,
  TEXT_LINK,
  useProgressive,
} from "./entry-ui";
import { emailProblem, postAuth, signInOutcome } from "./password-model";
import {
  CREATE_ACCOUNT_LINK,
  EMAIL_INVALID,
  EMAIL_LABEL,
  emailText,
  FORGOT_PASSWORD_LINK,
  failureText,
  GOOGLE_ACCOUNT_HELP,
  INCORRECT_CREDENTIALS,
  PASSWORD_LABEL,
  PASSWORD_REQUIRED,
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
 * The e-mail and password form of `/entrar` (AC-50, AC-62 to AC-65, AC-71, AC-72), v5.2: only the e-mail at
 * first; the password, "Esqueci a senha" and "Entrar" open when the address has a complete shape, with no
 * question to the server. A wrong password and an e-mail with no account get the same line; the pause of an
 * e-mail turns "Entrar" off for that e-mail only, until it ends (V4). The password never leaves this component
 * except in the body of the request.
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
  const formId = useId();
  const alertId = `${formId}-alert`;
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
  const progressive = useProgressive(passwordRef, pending);
  const { followEmail, followPassword } = progressive;

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
  const incorrect = alert?.help === true;

  const handleEmail = useCallback(
    (value: string) => {
      setEmail(value);
      followEmail(value);
      // the local error of an incomplete address goes as soon as the address is complete
      if (isCompleteEmail(value)) {
        setEmailError(null);
      }
      // an empty e-mail closes the password: it is hidden again, so it never comes back shown
      if (value.trim() === "") {
        hide();
      }
    },
    [followEmail, hide]
  );
  const handlePassword = useCallback(
    (value: string) => {
      setPassword(value);
      followPassword(value);
    },
    [followPassword]
  );
  const handleEmailKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) =>
      progressive.emailKeyDown(event, (value) =>
        setEmailError(emailText(emailProblem(value)) ?? EMAIL_INVALID)
      ),
    [progressive]
  );

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
          // the password goes, the e-mail stays and the focus goes to the password, the field to type again;
          // the alert is read with both fields (UX review of the P9)
          setPassword("");
          setAlert({ help: true, text: INCORRECT_CREDENTIALS });
          passwordRef.current?.focus();
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
      className="flex flex-col gap-4"
      noValidate
      onSubmit={submit}
    >
      {paused && pause ? (
        <EntryAlert>{pausedText(pause.minutes)}</EntryAlert>
      ) : null}
      {alert ? (
        <EntryAlert focus={false} id={alertId}>
          {alert.text}
          {alert.help ? (
            <>
              <br />
              {GOOGLE_ACCOUNT_HELP}
            </>
          ) : null}
        </EntryAlert>
      ) : null}
      <EmailInput
        autoComplete="username"
        describedById={incorrect ? alertId : undefined}
        disabled={disabled}
        error={emailError}
        fieldRef={emailRef}
        id={`${formId}-email`}
        label={EMAIL_LABEL}
        name="email"
        onChange={handleEmail}
        onKeyDown={handleEmailKeyDown}
        value={email}
      />
      <Progressive open={progressive.open}>
        <PasswordInput
          autoComplete="current-password"
          describedById={incorrect ? alertId : undefined}
          error={passwordError}
          fieldRef={passwordRef}
          id={`${formId}-password`}
          label={PASSWORD_LABEL}
          name="password"
          onChange={handlePassword}
          onToggle={toggleVisible}
          value={password}
          visible={visible}
        />
        <ChallengeArea challenge={challenge} />
        <SubmitButton
          disabled={disabled || paused || challenge.state === "loading"}
          pending={pending}
          pendingText={SIGN_IN_BUTTON_PENDING}
        >
          {SIGN_IN_BUTTON}
        </SubmitButton>
      </Progressive>
      {/* below the button and apart from it: their touch areas never meet the button's nor the field's */}
      <p className="mt-2 flex flex-wrap justify-between gap-x-6 gap-y-3 text-sm">
        {progressive.open ? (
          <a className={TEXT_LINK} href="/esqueci-a-senha">
            {FORGOT_PASSWORD_LINK}
          </a>
        ) : null}
        <a className={TEXT_LINK} href="/criar-conta">
          {CREATE_ACCOUNT_LINK}
        </a>
      </p>
    </form>
  );
}
