import {
  type FormEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { documentTitle } from "../app-shell/navigation-model";
import {
  BackToSignIn,
  ChallengeArea,
  challengeAlertId,
  EmailInput,
  EntryAlert,
  EntryGate,
  EntryScreen,
  EntrySuccess,
  SubmitButton,
} from "./entry-ui";
import { commonFailure, emailProblem, postAuth } from "./password-model";
import {
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
  const formId = useId();
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
        setSent(false);
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
      // a new refusal replaces the green line of the earlier send: the two never show together
      setSent(false);
      setAlert(failureText(commonFailure(answer), "email"));
    },
    [challenge, email, pending]
  );

  return (
    <EntryScreen support={FORGOT_SUPPORT} title={FORGOT_TITLE}>
      {sent ? <EntrySuccess>{FORGOT_SENT}</EntrySuccess> : null}
      {alert ? <EntryAlert>{alert}</EntryAlert> : null}
      <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
        <EmailInput
          autoComplete="username"
          error={emailError}
          fieldRef={emailRef}
          id={`${formId}-email`}
          label={EMAIL_LABEL}
          name="email"
          onChange={setEmail}
          value={email}
        />
        <ChallengeArea
          alertId={challengeAlertId(formId)}
          challenge={challenge}
        />
        <SubmitButton
          alertId={challengeAlertId(formId)}
          challenge={challenge}
          disabled={challenge.state === "loading"}
          pending={pending}
          pendingText={FORGOT_BUTTON_PENDING}
        >
          {FORGOT_BUTTON}
        </SubmitButton>
      </form>
      <BackToSignIn />
    </EntryScreen>
  );
}

/** `/esqueci-a-senha` (AC-53): an e-mail, the challenge, and an answer that never says who has an account. */
export function ForgotPasswordPage() {
  useEffect(() => {
    document.title = documentTitle(FORGOT_TITLE);
  }, []);
  return (
    <EntryGate title={FORGOT_TITLE}>
      {(methods) => <ForgotPasswordForm siteKey={methods.siteKey} />}
    </EntryGate>
  );
}
