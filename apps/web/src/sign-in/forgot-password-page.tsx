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
  EntrySuccess,
  PasswordGate,
} from "./entry-parts";
import { commonFailure, emailProblem, postAuth } from "./password-model";
import {
  BACK_TO_SIGN_IN,
  EMAIL_LABEL,
  emailText,
  FORGOT_BUTTON,
  FORGOT_BUTTON_PENDING,
  FORGOT_SENT,
  FORGOT_SUPPORT,
  FORGOT_TITLE,
  failureText,
} from "./password-texts";
import { challengeToken, useChallenge } from "./turnstile";

function ForgotPasswordForm({ siteKey }: { siteKey: string | null }) {
  const challenge = useChallenge(siteKey, "password_reset_request");
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  const submit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (pending) {
        return;
      }
      const problem = emailText(emailProblem(email));
      setEmailError(problem);
      setAlert(null);
      if (problem) {
        emailRef.current?.focus();
        return;
      }
      setPending(true);
      const token = await challengeToken(challenge);
      if ("failure" in token) {
        setPending(false);
        setAlert(failureText(token.failure, "email"));
        return;
      }
      const answer = await postAuth(
        "/api/auth/request-password-reset",
        { email: email.trim() },
        { turnstileToken: token.token }
      );
      setPending(false);
      // the same answer whether the e-mail has an account or not (AC-49): only a refusal of the request differs
      if (answer.status >= 200 && answer.status < 300) {
        setSent(true);
        return;
      }
      setAlert(failureText(commonFailure(answer), "email"));
    },
    [challenge, email, pending]
  );

  return (
    <EntryFrame title={FORGOT_TITLE}>
      <p className="sign-in-support">{FORGOT_SUPPORT}</p>
      {sent ? <EntrySuccess>{FORGOT_SENT}</EntrySuccess> : null}
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
        <ChallengeSlot challenge={challenge} />
        <button
          aria-busy={pending}
          className="sign-in-primary"
          disabled={pending || challenge.state === "loading"}
          type="submit"
        >
          {pending ? FORGOT_BUTTON_PENDING : FORGOT_BUTTON}
        </button>
      </form>
      <p className="sign-in-links">
        <a href="/entrar">{BACK_TO_SIGN_IN}</a>
      </p>
    </EntryFrame>
  );
}

/** `/esqueci-a-senha` (AC-53): an e-mail, the challenge, and an answer that never says who has an account. */
export function ForgotPasswordPage() {
  useEffect(() => {
    document.title = documentTitle(FORGOT_TITLE);
  }, []);
  return (
    <PasswordGate title={FORGOT_TITLE}>
      {(siteKey) => <ForgotPasswordForm siteKey={siteKey} />}
    </PasswordGate>
  );
}
