import KeyRoundIcon from "lucide-react/dist/esm/icons/key-round";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
import { Separator } from "@/ui/separator";
import { NotFoundPage } from "../app-shell/not-found-page";
import { SessionEndedNotice } from "../app-shell/session-ended-notice";
import { signInPath } from "../lib/sign-in-path";
import { LogoutDialog } from "../offline/logout-dialog";
import { useLogout } from "../offline/runtime/logout-control";
import { useEntryMethods } from "./entry-methods";
import {
  EntryAlert,
  EntryRetry,
  EntryStatus,
  EntrySuccess,
  PasswordInput,
  SubmitButton,
  useReveal,
} from "./entry-ui";
import { changeOutcome, newPasswordProblem, postAuth } from "./password-model";
import {
  CHANGE_BUTTON,
  CHANGE_BUTTON_PENDING,
  CHANGE_CANCEL,
  CHANGE_CANCEL_LABEL,
  CHANGE_CARD_TITLE,
  CHANGE_DONE,
  CHANGE_NO_PASSWORD,
  CHANGE_RECENT_BUTTON,
  CHANGE_RECENT_REQUIRED,
  CHANGE_SUPPORT,
  CHANGE_TITLE,
  CURRENT_PASSWORD_LABEL,
  CURRENT_PASSWORD_WRONG,
  changePausedText,
  failureText,
  NEW_PASSWORD_LABEL,
  newPasswordText,
  PAGE_LOADING,
  PAGE_UNAVAILABLE,
  PASSWORD_REQUIRED,
  PASSWORD_RULE,
} from "./password-texts";

const ACCOUNT_SECURITY_PATH = "/conta/seguranca";
/** "Cancelar" goes back to where the page is reached from, without saving. */
const DEVICES_PATH = "/devices";
/** A live but old login: "Sair" (the queue protected first), then back here, as in Aparelhos. */
const SIGN_IN_AGAIN = signInPath({
  reason: "recente",
  returnTo: ACCOUNT_SECURITY_PATH,
});

type Notice =
  | { kind: "alert"; text: string }
  | { kind: "done" }
  | { kind: "no-password" }
  | { kind: "recent" }
  | { kind: "session-ended" }
  | null;

/**
 * A block of the page in the new interface. The page is inside the app shell, whose notices and dialogs are still
 * the old markup and keep to themselves: only what is drawn here is under `data-ui`.
 */
function UiBlock({ children }: { children: ReactNode }) {
  return (
    // the gap is the block's own padding, so the background of the new interface runs unbroken from one block to the next
    <div className="grid gap-4 pb-4 last:pb-0" data-ui="">
      {children}
    </div>
  );
}

function RecentLoginRequired() {
  const logout = useLogout(SIGN_IN_AGAIN);
  return (
    <>
      <UiBlock>
        <Card>
          <CardContent className="grid gap-3">
            <EntryAlert>{CHANGE_RECENT_REQUIRED}</EntryAlert>
            {logout.message ? (
              <p className="text-muted-foreground text-support">
                {logout.message}
              </p>
            ) : null}
            <Button
              className="w-full sm:w-fit"
              disabled={logout.busy}
              onClick={logout.start}
              size="lg"
              type="button"
            >
              {CHANGE_RECENT_BUTTON}
            </Button>
          </CardContent>
        </Card>
      </UiBlock>
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
  const currentId = useId();
  const nextId = useId();
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
            text: changePausedText(Math.ceil(outcome.retryAfterSeconds / 60)),
          });
          return;
        case "no-password":
          setCurrent("");
          setNext("");
          setNotice({ kind: "no-password" });
          return;
        case "recent-required":
          // the form is hidden: nothing typed stays in memory
          setCurrent("");
          setNext("");
          setNotice({ kind: "recent" });
          return;
        case "session-ended":
          setCurrent("");
          setNext("");
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
      {notice?.kind === "done" ||
      notice?.kind === "alert" ||
      notice?.kind === "no-password" ? (
        <UiBlock>
          {notice.kind === "done" ? (
            <EntrySuccess>{CHANGE_DONE}</EntrySuccess>
          ) : null}
          {notice.kind === "alert" ? (
            <EntryAlert>{notice.text}</EntryAlert>
          ) : null}
          {notice.kind === "no-password" ? (
            <EntryAlert>{CHANGE_NO_PASSWORD}</EntryAlert>
          ) : null}
        </UiBlock>
      ) : null}
      {notice?.kind === "session-ended" ? (
        <SessionEndedNotice returnTo={ACCOUNT_SECURITY_PATH} />
      ) : null}
      {/* the login is too old: the only way on is "Entrar de novo", which signs out and clears the form */}
      {notice?.kind === "recent" ? (
        <RecentLoginRequired />
      ) : (
        <UiBlock>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <KeyRoundIcon
                  aria-hidden="true"
                  className="size-4 text-muted-foreground"
                />
                {CHANGE_CARD_TITLE}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form
                className="flex flex-col gap-4"
                noValidate
                onSubmit={submit}
              >
                <PasswordInput
                  autoComplete="current-password"
                  error={currentError}
                  fieldRef={currentRef}
                  id={currentId}
                  label={CURRENT_PASSWORD_LABEL}
                  name="current-password"
                  onChange={setCurrent}
                  onToggle={toggleCurrent}
                  value={current}
                  visible={currentVisible}
                />
                <PasswordInput
                  autoComplete="new-password"
                  error={nextError}
                  fieldRef={nextRef}
                  hint={PASSWORD_RULE}
                  id={nextId}
                  label={NEW_PASSWORD_LABEL}
                  name="new-password"
                  onChange={setNext}
                  onToggle={toggleNext}
                  value={next}
                  visible={nextVisible}
                />
                <Separator />
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <SubmitButton
                    className="sm:w-fit"
                    // an account of Google has no password to change: the alert says so, the button stays off
                    disabled={notice?.kind === "no-password"}
                    pending={pending}
                    pendingText={CHANGE_BUTTON_PENDING}
                  >
                    {CHANGE_BUTTON}
                  </SubmitButton>
                  <a
                    aria-label={CHANGE_CANCEL_LABEL}
                    className={cn(
                      buttonVariants({ size: "lg", variant: "outline" }),
                      "w-full sm:w-fit"
                    )}
                    href={DEVICES_PATH}
                  >
                    {CHANGE_CANCEL}
                  </a>
                </div>
              </form>
            </CardContent>
          </Card>
        </UiBlock>
      )}
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
    <div className="grid max-w-[34rem]">
      <UiBlock>
        <h1 className="text-title" ref={headingRef} tabIndex={-1}>
          {CHANGE_TITLE}
        </h1>
        <p className="text-pretty text-muted-foreground text-support">
          {CHANGE_SUPPORT}
        </p>
        {methods.state === "loading" ? (
          <EntryStatus>{PAGE_LOADING}</EntryStatus>
        ) : null}
        {methods.state === "unavailable" ? (
          <>
            <EntryAlert>{PAGE_UNAVAILABLE}</EntryAlert>
            <EntryRetry onClick={retry} />
          </>
        ) : null}
      </UiBlock>
      {methods.state === "ready" ? <ChangePasswordForm /> : null}
    </div>
  );
}
