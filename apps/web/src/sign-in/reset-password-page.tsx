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
  EntryAlert,
  EntryGate,
  EntryLinkButton,
  EntryNotice,
  EntryScreen,
  EntrySuccess,
  PasswordInput,
  SubmitButton,
  useReveal,
} from "./entry-ui";
import {
  newPasswordProblem,
  postAuth,
  resetOutcome,
  takeFragmentToken,
} from "./password-model";
import {
  ASK_NEW_LINK,
  CHALLENGE_BLOCKED_LINK,
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
  const passwordId = useId();
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
        setAlert(failureText(challenged.failure, "reset"));
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
          setAlert(failureText(outcome.failure, "reset"));
      }
    },
    [challenge, hide, password, pending, token]
  );

  if (phase === "done") {
    return (
      <EntryScreen title={RESET_TITLE}>
        <EntrySuccess>{RESET_DONE}</EntrySuccess>
        <EntryLinkButton href="/entrar">{GO_TO_SIGN_IN}</EntryLinkButton>
      </EntryScreen>
    );
  }
  if (phase === "link-invalid") {
    return <ResetLinkMissing text={RESET_LINK_INVALID} />;
  }
  return (
    <EntryScreen title={RESET_TITLE}>
      {alert ? <EntryAlert>{alert}</EntryAlert> : null}
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={submit}
      >
        <PasswordInput
          autoComplete="new-password"
          error={passwordError}
          fieldRef={passwordRef}
          hint={PASSWORD_RULE}
          id={passwordId}
          label={NEW_PASSWORD_LABEL}
          name="new-password"
          onChange={setPassword}
          onToggle={toggleVisible}
          value={password}
          visible={visible}
        />
        {/* a reload would lose the link: the text sends the person back to the e-mail, with no retry here */}
        <ChallengeArea
          blockedText={CHALLENGE_BLOCKED_LINK}
          challenge={challenge}
          retry={false}
        />
        <SubmitButton
          disabled={challenge.state === "loading"}
          pending={pending}
          pendingText={RESET_BUTTON_PENDING}
        >
          {RESET_BUTTON}
        </SubmitButton>
      </form>
    </EntryScreen>
  );
}

/** `neutral`: the page was opened without its link, which is an instruction and not a failure. */
function ResetLinkMissing({
  neutral = false,
  text,
}: {
  neutral?: boolean;
  text: string;
}) {
  return (
    <EntryScreen title={RESET_TITLE}>
      {neutral ? (
        <EntryNotice>{text}</EntryNotice>
      ) : (
        <EntryAlert>{text}</EntryAlert>
      )}
      <EntryLinkButton href="/esqueci-a-senha">{ASK_NEW_LINK}</EntryLinkButton>
      <BackToSignIn />
    </EntryScreen>
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
    <EntryGate title={RESET_TITLE}>
      {(methods) =>
        token ? (
          <ResetPasswordForm siteKey={methods.siteKey} token={token} />
        ) : (
          <ResetLinkMissing neutral text={RESET_NO_LINK} />
        )
      }
    </EntryGate>
  );
}
