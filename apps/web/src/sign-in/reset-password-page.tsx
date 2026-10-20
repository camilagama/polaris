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
  EntryAlert,
  EntryFrame,
  EntryLinkButton,
  EntrySuccess,
  PasswordField,
  PasswordGate,
  useReveal,
} from "./entry-parts";
import {
  newPasswordProblem,
  postAuth,
  resetOutcome,
  takeFragmentToken,
} from "./password-model";
import {
  ASK_NEW_LINK,
  BACK_TO_SIGN_IN,
  failureText,
  GO_TO_SIGN_IN,
  NEW_PASSWORD_LABEL,
  newPasswordText,
  PASSWORD_RULE,
  RESET_BUTTON,
  RESET_BUTTON_PENDING,
  RESET_DONE,
  RESET_LINK_INVALID,
  RESET_NO_LINK,
  RESET_PAGE_TITLE,
  RESET_SUPPORT,
  RESET_TITLE,
} from "./password-texts";
import { challengeToken, useChallenge } from "./turnstile";

type ResetPhase = "done" | "form" | "link-invalid";

function ResetPasswordForm({
  siteKey,
  token,
}: {
  siteKey: string | null;
  token: string;
}) {
  const challenge = useChallenge(siteKey, "password_reset");
  const [password, setPassword] = useState("");
  const [visible, toggleVisible, hide] = useReveal();
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [phase, setPhase] = useState<ResetPhase>("form");
  const passwordRef = useRef<HTMLInputElement>(null);

  const submit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (pending) {
        return;
      }
      hide();
      setAlert(null);
      const problem = newPasswordProblem(password);
      setPasswordError(problem ? newPasswordText(problem) : null);
      if (problem) {
        passwordRef.current?.focus();
        return;
      }
      setPending(true);
      const challenged = await challengeToken(challenge);
      if ("failure" in challenged) {
        setPending(false);
        setAlert(failureText(challenged.failure, "other"));
        return;
      }
      const outcome = resetOutcome(
        await postAuth(
          "/api/auth/reset-password",
          { newPassword: password, token },
          { turnstileToken: challenged.token }
        )
      );
      setPending(false);
      switch (outcome.kind) {
        case "done":
          setPassword("");
          setPhase("done");
          return;
        case "link-invalid":
          setPassword("");
          setPhase("link-invalid");
          return;
        case "password":
          setPasswordError(newPasswordText(outcome.problem));
          passwordRef.current?.focus();
          return;
        default:
          setAlert(failureText(outcome.failure, "other"));
      }
    },
    [challenge, hide, password, pending, token]
  );

  if (phase === "done") {
    return (
      <EntryFrame title={RESET_TITLE}>
        <EntrySuccess>{RESET_DONE}</EntrySuccess>
        <EntryLinkButton href="/entrar">{GO_TO_SIGN_IN}</EntryLinkButton>
      </EntryFrame>
    );
  }
  if (phase === "link-invalid") {
    return <ResetLinkMissing text={RESET_LINK_INVALID} />;
  }
  return (
    <EntryFrame title={RESET_TITLE}>
      <p className="sign-in-support">{RESET_SUPPORT}</p>
      {alert ? <EntryAlert>{alert}</EntryAlert> : null}
      <form className="sign-in-form" noValidate onSubmit={submit}>
        <PasswordField
          autoComplete="new-password"
          error={passwordError}
          fieldRef={passwordRef}
          hint={PASSWORD_RULE}
          label={NEW_PASSWORD_LABEL}
          name="new-password"
          onChange={setPassword}
          onToggle={toggleVisible}
          value={password}
          visible={visible}
        />
        <ChallengeSlot challenge={challenge} />
        <button
          aria-busy={pending}
          className="sign-in-primary"
          disabled={pending || challenge.state === "loading"}
          type="submit"
        >
          {pending ? RESET_BUTTON_PENDING : RESET_BUTTON}
        </button>
      </form>
    </EntryFrame>
  );
}

function ResetLinkMissing({ text }: { text: string }) {
  return (
    <EntryFrame title={RESET_TITLE}>
      <EntryAlert>{text}</EntryAlert>
      <EntryLinkButton href="/esqueci-a-senha">{ASK_NEW_LINK}</EntryLinkButton>
      <p className="sign-in-links">
        <a href="/entrar">{BACK_TO_SIGN_IN}</a>
      </p>
    </EntryFrame>
  );
}

/**
 * `/redefinir-senha#token=…` (AC-53, ADR 0100): the token leaves the address bar on the first render,
 * before the challenge script loads, and lives only in memory. A reload has no token: the page asks for
 * the link again instead of saying it expired (V2).
 */
export function ResetPasswordPage() {
  const [token] = useState(() =>
    takeFragmentToken(window.location, window.history)
  );
  useEffect(() => {
    document.title = documentTitle(RESET_PAGE_TITLE);
  }, []);
  return (
    <PasswordGate title={RESET_TITLE}>
      {(siteKey) =>
        token ? (
          <ResetPasswordForm siteKey={siteKey} token={token} />
        ) : (
          <ResetLinkMissing text={RESET_NO_LINK} />
        )
      }
    </PasswordGate>
  );
}
