import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import {
  SESSION_ENDED_MESSAGE,
  SIGN_IN_AGAIN_BUTTON,
  SIGN_IN_AGAIN_OPENING,
  UNSENT_INPUT_WARNING,
} from "../lib/session-ended-text";
import { currentReturnPath } from "../lib/sign-in-path";
import { useHasUnsentWork } from "../lib/unsent-work";
import { useOfflineRuntime } from "../offline/runtime/runtime-context";
import { leaveSessionOver } from "../offline/runtime/session-over";

interface SessionEndedNoticeProps {
  /**
   * The notice is the only thing the page says about it (an alert). Beside a screen that already shows
   * the error where it happened, it is a polite status: one announcement, not two.
   */
  alone?: boolean;
  /** Where to come back to after signing in; the page the person is on when not given. */
  returnTo?: string;
}

/**
 * The one component for "the session is over" (AC-17, AC-18): the sentence, the button "Entrar de
 * novo", and, when a screen holds something typed or picked, the warning that it can be lost. The
 * session is dead, so the button does not go through "Sair": it drops the local copy and goes to
 * `/entrar?motivo=sessao`, and the queue stays where it is.
 */
export function SessionEndedNotice({
  alone = false,
  returnTo,
}: SessionEndedNoticeProps) {
  const runtime = useOfflineRuntime();
  const [leaving, setLeaving] = useState(false);
  // each screen says by itself that it holds something typed or picked and not sent
  const unsent = useHasUnsentWork();
  const noticeRef = useRef<HTMLDivElement>(null);
  // the notice can appear far from where the person is (a long sale): bring it into view and put the focus on it,
  // unless a field is active
  useEffect(() => {
    const notice = noticeRef.current;
    // with a field active the person is typing, maybe with the keyboard open: the page must not move
    // (the field would leave the screen) and the keys must not be lost, so the notice only appears (it is a status)
    const typing = document.activeElement?.closest(
      "input, textarea, select, [contenteditable='true']"
    );
    if (typing) {
      return;
    }
    notice?.scrollIntoView?.({ block: "center" });
    notice?.focus({ preventScroll: true });
  }, []);
  const handleClick = useCallback(() => {
    setLeaving(true);
    leaveSessionOver(runtime, returnTo ?? currentReturnPath(window.location));
  }, [returnTo, runtime]);

  return (
    <Alert
      aria-label="Sua sessão acabou"
      className="focus-ring mb-4 font-sans"
      data-notice="session-ended"
      ref={noticeRef}
      role={alone ? "alert" : "status"}
      tabIndex={-1}
      variant="warning"
    >
      <TriangleAlertIcon aria-hidden="true" />
      <AlertTitle>{SESSION_ENDED_MESSAGE}</AlertTitle>
      <AlertDescription className="grid justify-items-start gap-2 [&_p:not(:last-child)]:mb-0">
        {unsent ? <p>{UNSENT_INPUT_WARNING}</p> : null}
        <Button
          aria-busy={leaving}
          disabled={leaving}
          onClick={handleClick}
          type="button"
        >
          {leaving ? SIGN_IN_AGAIN_OPENING : SIGN_IN_AGAIN_BUTTON}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
