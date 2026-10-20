import { useCallback, useEffect, useRef, useState } from "react";
import { documentTitle } from "../app-shell/navigation-model";
import {
  EntryAlert,
  EntryFrame,
  EntryLinkButton,
  EntryNotice,
  EntrySuccess,
  PasswordGate,
} from "./entry-parts";
import {
  type LinkOutcome,
  linkOutcome,
  postAuth,
  takeFragmentToken,
} from "./password-model";
import {
  FORGOT_PASSWORD_LINK,
  failureText,
  GO_TO_SIGN_IN,
  TRY_AGAIN,
  UNLOCK_CHECKING,
  UNLOCK_DONE,
  UNLOCK_INVALID,
  UNLOCK_NO_LINK,
  UNLOCK_PAGE_TITLE,
  UNLOCK_TITLE,
} from "./password-texts";

/** `neutral`: the page was opened without its link, which is an instruction and not a failure. */
function UnlockLinkFailed({
  neutral = false,
  text,
}: {
  neutral?: boolean;
  text: string;
}) {
  return (
    <EntryFrame title={UNLOCK_TITLE}>
      {neutral ? (
        <EntryNotice>{text}</EntryNotice>
      ) : (
        <EntryAlert>{text}</EntryAlert>
      )}
      <EntryLinkButton href="/entrar">{GO_TO_SIGN_IN}</EntryLinkButton>
      <p className="sign-in-links">
        <a href="/esqueci-a-senha">{FORGOT_PASSWORD_LINK}</a>
      </p>
    </EntryFrame>
  );
}

function Unlock({ token }: { token: string }) {
  const [state, setState] = useState<"checking" | LinkOutcome>("checking");
  const startedRef = useRef<boolean>(false);

  const unlock = useCallback(() => {
    setState("checking");
    postAuth("/api/login-unlock", { token })
      .then((answer) => setState(linkOutcome(answer)))
      .catch(() => setState("unavailable"));
  }, [token]);

  useEffect(() => {
    if (!startedRef.current) {
      startedRef.current = true;
      unlock();
    }
  }, [unlock]);

  if (state === "done") {
    return (
      <EntryFrame title={UNLOCK_TITLE}>
        <EntrySuccess>{UNLOCK_DONE}</EntrySuccess>
        <EntryLinkButton href="/entrar">{GO_TO_SIGN_IN}</EntryLinkButton>
      </EntryFrame>
    );
  }
  if (state === "expired" || state === "invalid") {
    return <UnlockLinkFailed text={UNLOCK_INVALID} />;
  }
  return (
    <EntryFrame title={UNLOCK_TITLE}>
      {state === "checking" ? (
        <p className="sign-in-status" role="status">
          {UNLOCK_CHECKING}
        </p>
      ) : (
        <>
          <EntryAlert>
            {failureText(state === "limit" ? "limit" : "unavailable", "other")}
          </EntryAlert>
          <button className="sign-in-retry" onClick={unlock} type="button">
            {TRY_AGAIN}
          </button>
        </>
      )}
    </EntryFrame>
  );
}

/**
 * `/desbloquear#token=…` (AC-64): the link of the unlock e-mail. The token leaves the address bar on the
 * first render and goes in the body of `POST /api/login-unlock`; the same link again answers "unlocked"
 * again. No challenge here, so this page keeps the policy of the app shell.
 */
export function UnlockPage() {
  const [token] = useState(() =>
    takeFragmentToken(window.location, window.history)
  );
  useEffect(() => {
    document.title = documentTitle(UNLOCK_PAGE_TITLE);
  }, []);
  return (
    <PasswordGate title={UNLOCK_TITLE}>
      {() =>
        token ? (
          <Unlock token={token} />
        ) : (
          <UnlockLinkFailed neutral text={UNLOCK_NO_LINK} />
        )
      }
    </PasswordGate>
  );
}
