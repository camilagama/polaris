import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { NotFoundPage } from "../app-shell/not-found-page";
import { SessionEndedNotice } from "../app-shell/session-ended-notice";
import { signInPath } from "../lib/sign-in-path";
import { LogoutDialog } from "../offline/logout-dialog";
import { useLogout } from "../offline/runtime/logout-control";
import { useEntryMethods } from "./entry-methods";
import {
  EntryAlert,
  EntrySuccess,
  PasswordField,
  useReveal,
} from "./entry-parts";
import { changeOutcome, newPasswordProblem, postAuth } from "./password-model";
import {
  CHANGE_BUTTON,
  CHANGE_BUTTON_PENDING,
  CHANGE_DONE,
  CHANGE_NO_PASSWORD,
  CHANGE_QUEUE_NOTE,
  CHANGE_RECENT_BUTTON,
  CHANGE_RECENT_REQUIRED,
  CHANGE_SUPPORT,
  CHANGE_TITLE,
  CURRENT_PASSWORD_LABEL,
  CURRENT_PASSWORD_WRONG,
  failureText,
  NEW_PASSWORD_LABEL,
  newPasswordText,
  PAGE_LOADING,
  PAGE_UNAVAILABLE,
  PASSWORD_REQUIRED,
  PASSWORD_RULE,
  pausedText,
  TRY_AGAIN,
} from "./password-texts";

const ACCOUNT_SECURITY_PATH = "/conta/seguranca";
/** A live but old login: "Sair" (the queue protected first), then back here, as in Aparelhos. */
const SIGN_IN_AGAIN = signInPath({
  reason: "recente",
  returnTo: ACCOUNT_SECURITY_PATH,
});

type Notice =
  | { kind: "alert"; text: string }
  | { kind: "done" }
  | { kind: "recent" }
  | { kind: "session-ended" }
  | null;

function RecentLoginRequired() {
  const logout = useLogout(SIGN_IN_AGAIN);
  return (
    <>
      <EntryAlert>{CHANGE_RECENT_REQUIRED}</EntryAlert>
      {logout.message ? <p>{logout.message}</p> : null}
      <button
        className="primary-button"
        disabled={logout.busy}
        onClick={logout.start}
        type="button"
      >
        {CHANGE_RECENT_BUTTON}
      </button>
      {logout.blocked ? (
        <LogoutDialog
          blocked={logout.blocked}
          busy={logout.busy}
          errorMessage={null}
          onCancel={logout.cancel}
          onDiscard={logout.discard}
          onRetry={logout.start}
          onShowAttention={logout.showAttention}
        />
      ) : null}
    </>
  );
}

function ChangePasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [currentVisible, toggleCurrent, hideCurrent] = useReveal();
  const [nextVisible, toggleNext, hideNext] = useReveal();
  const [currentError, setCurrentError] = useState<string | null>(null);
  const [nextError, setNextError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [pending, setPending] = useState(false);
  const currentRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLInputElement>(null);

  const submit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (pending) {
        return;
      }
      hideCurrent();
      hideNext();
      setNotice(null);
      const currentIssue = current.length === 0 ? PASSWORD_REQUIRED : null;
      const nextIssue = newPasswordProblem(next);
      setCurrentError(currentIssue);
      setNextError(nextIssue ? newPasswordText(nextIssue) : null);
      if (currentIssue) {
        currentRef.current?.focus();
        return;
      }
      if (nextIssue) {
        nextRef.current?.focus();
        return;
      }
      setPending(true);
      const outcome = changeOutcome(
        await postAuth("/api/auth/change-password", {
          currentPassword: current,
          newPassword: next,
        })
      );
      setPending(false);
      switch (outcome.kind) {
        case "done":
          setCurrent("");
          setNext("");
          setNotice({ kind: "done" });
          return;
        case "current-wrong":
          setCurrent("");
          setCurrentError(CURRENT_PASSWORD_WRONG);
          currentRef.current?.focus();
          return;
        case "password":
          setNextError(newPasswordText(outcome.problem));
          nextRef.current?.focus();
          return;
        case "locked":
          setCurrent("");
          setNotice({
            kind: "alert",
            text: pausedText(Math.ceil(outcome.retryAfterSeconds / 60)),
          });
          return;
        case "no-password":
          setNotice({ kind: "alert", text: CHANGE_NO_PASSWORD });
          return;
        case "recent-required":
          setNotice({ kind: "recent" });
          return;
        case "session-ended":
          setNotice({ kind: "session-ended" });
          return;
        default:
          setNotice({
            kind: "alert",
            text: failureText(outcome.failure, "other"),
          });
      }
    },
    [current, hideCurrent, hideNext, next, pending]
  );

  return (
    <>
      {notice?.kind === "done" ? (
        <EntrySuccess>{CHANGE_DONE}</EntrySuccess>
      ) : null}
      {notice?.kind === "alert" ? <EntryAlert>{notice.text}</EntryAlert> : null}
      {notice?.kind === "recent" ? <RecentLoginRequired /> : null}
      {notice?.kind === "session-ended" ? (
        <SessionEndedNotice returnTo={ACCOUNT_SECURITY_PATH} />
      ) : null}
      <form className="sign-in-form" noValidate onSubmit={submit}>
        <PasswordField
          autoComplete="current-password"
          error={currentError}
          fieldRef={currentRef}
          label={CURRENT_PASSWORD_LABEL}
          name="current-password"
          onChange={setCurrent}
          onToggle={toggleCurrent}
          value={current}
          visible={currentVisible}
        />
        <PasswordField
          autoComplete="new-password"
          error={nextError}
          fieldRef={nextRef}
          hint={PASSWORD_RULE}
          label={NEW_PASSWORD_LABEL}
          name="new-password"
          onChange={setNext}
          onToggle={toggleNext}
          value={next}
          visible={nextVisible}
        />
        <button
          aria-busy={pending}
          className="sign-in-primary"
          disabled={pending}
          type="submit"
        >
          {pending ? CHANGE_BUTTON_PENDING : CHANGE_BUTTON}
        </button>
      </form>
    </>
  );
}

/**
 * "Trocar senha" inside the app (AC-57, ADR 0044 item "baixo"): the current and the new password. The
 * server revokes the other sessions, changes the epoch of the leases and keeps this session; it asks for
 * a login of the last 15 minutes, as revoking a device does. Only with the password on (AC-46).
 */
export function ChangePasswordPage() {
  const { methods, retry } = useEntryMethods(undefined, false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  if (methods.state === "off") {
    return <NotFoundPage pathname={window.location.pathname} />;
  }
  return (
    <div className="account-security-page">
      <section className="categories-heading">
        <div>
          <p className="categories-eyebrow">Segurança</p>
          <h1 ref={headingRef} tabIndex={-1}>
            {CHANGE_TITLE}
          </h1>
          <p className="categories-intro-copy">{CHANGE_SUPPORT}</p>
          <p className="categories-intro-copy">{CHANGE_QUEUE_NOTE}</p>
        </div>
      </section>
      {methods.state === "loading" ? (
        <p className="sign-in-status" role="status">
          {PAGE_LOADING}
        </p>
      ) : null}
      {methods.state === "unavailable" ? (
        <>
          <EntryAlert>{PAGE_UNAVAILABLE}</EntryAlert>
          <button className="sign-in-retry" onClick={retry} type="button">
            {TRY_AGAIN}
          </button>
        </>
      ) : null}
      {methods.state === "ready" ? <ChangePasswordForm /> : null}
    </div>
  );
}
