import { useCallback, useEffect, useState } from "react";
import { currentReturnPath } from "../lib/sign-in-path";
import {
  SESSION_ENDED_MESSAGE,
  SIGN_IN_AGAIN_BUTTON,
  UNSENT_INPUT_WARNING,
} from "../lib/session-ended-text";
import { useOfflineRuntime } from "../offline/runtime/runtime-context";
import { leaveSessionOver } from "../offline/runtime/session-over";

/** Whether something typed in this page is still unsent: any filled text field of the main area. */
function hasUnsentInput(root: ParentNode): boolean {
  const fields = root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    "main textarea, main input"
  );
  return [...fields].some((field) => {
    if (field instanceof HTMLInputElement) {
      const filled = ["email", "number", "search", "tel", "text", "url"];
      return filled.includes(field.type) && field.value.trim().length > 0;
    }
    return field.value.trim().length > 0;
  });
}

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
 * novo", and, when there is something typed, the warning that it can be lost. The session is dead,
 * so the button does not go through "Sair": it drops the local copy and goes to `/entrar?motivo=sessao`,
 * and the queue stays where it is.
 */
export function SessionEndedNotice({
  alone = false,
  returnTo,
}: SessionEndedNoticeProps) {
  const runtime = useOfflineRuntime();
  const [leaving, setLeaving] = useState(false);
  const [unsent, setUnsent] = useState(false);
  useEffect(() => {
    setUnsent(hasUnsentInput(document));
  }, []);
  const handleClick = useCallback(() => {
    setLeaving(true);
    leaveSessionOver(runtime, returnTo ?? currentReturnPath(window.location));
  }, [returnTo, runtime]);

  return (
    <section
      aria-label="Sessão"
      className="session-ended-notice"
      role={alone ? "alert" : "status"}
    >
      <p>{SESSION_ENDED_MESSAGE}</p>
      {unsent ? <p>{UNSENT_INPUT_WARNING}</p> : null}
      <button
        className="primary-button"
        disabled={leaving}
        onClick={handleClick}
        type="button"
      >
        {SIGN_IN_AGAIN_BUTTON}
      </button>
    </section>
  );
}
