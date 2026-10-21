import { useCallback, useEffect, useRef, useState } from "react";
import { documentTitle } from "../app-shell/navigation-model";
import {
  EntryAlert,
  EntryGate,
  EntryLinkButton,
  EntryNotice,
  EntryRetry,
  EntryScreen,
  EntryStatus,
  EntrySuccess,
  TEXT_LINK,
} from "./entry-ui";
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
    <EntryScreen title={UNLOCK_TITLE}>
      {neutral ? (
        <EntryNotice>{text}</EntryNotice>
      ) : (
        <EntryAlert>{text}</EntryAlert>
      )}
      <EntryLinkButton href="/entrar">{GO_TO_SIGN_IN}</EntryLinkButton>
      <p className="mt-2 flex text-sm">
        <a className={TEXT_LINK} href="/esqueci-a-senha">
          {FORGOT_PASSWORD_LINK}
        </a>
      </p>
    </EntryScreen>
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
      <EntryScreen title={UNLOCK_TITLE}>
        <EntrySuccess>{UNLOCK_DONE}</EntrySuccess>
        <EntryLinkButton href="/entrar">{GO_TO_SIGN_IN}</EntryLinkButton>
      </EntryScreen>
    );
  }
  if (state === "expired" || state === "invalid") {
    return <UnlockLinkFailed text={UNLOCK_INVALID} />;
  }
  return (
    <EntryScreen title={UNLOCK_TITLE}>
      {state === "checking" ? (
        <EntryStatus>{UNLOCK_CHECKING}</EntryStatus>
      ) : (
        <>
          <EntryAlert>
            {failureText(state === "limit" ? "limit" : "unavailable", "other")}
          </EntryAlert>
          <EntryRetry onClick={unlock} />
        </>
      )}
    </EntryScreen>
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
    <EntryGate title={UNLOCK_TITLE}>
      {() =>
        token ? (
          <Unlock token={token} />
        ) : (
          <UnlockLinkFailed neutral text={UNLOCK_NO_LINK} />
        )
      }
    </EntryGate>
  );
}
