import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  tryConnectionNow,
  useConnectionOnline,
} from "../lib/browser-connection";

/**
 * The one notice of the screens that work only with a connection (`ONLINE_ONLY_ROUTES`), shown by the
 * shell while the tab does not reach the Worker (emenda do ADR 0043). Two forms: with a form on screen
 * the typed text stays (only in memory, while the page is open: nothing is written to the disk); without,
 * the screen loads by itself when the connection returns. A control that needs the connection points to
 * the sentence with `aria-describedby` (`CONNECTION_NOTICE_TEXT_ID`).
 */
export const CONNECTION_NOTICE_TEXT_ID = "connection-required-text";

export const CONNECTION_NOTICE_WITH_FORM =
  "Sem internet. Esta tela precisa de conexão. O que você digitou fica aqui enquanto esta página estiver aberta.";
export const CONNECTION_NOTICE_WITHOUT_FORM =
  "Sem internet. Esta tela precisa de conexão. Ela carrega sozinha quando a conexão voltar.";

// ---------------------------------------------------- which form the screen shows
let declaredForm: boolean | null = null;
const formListeners = new Set<() => void>();

function declareForm(value: boolean | null) {
  declaredForm = value;
  for (const listener of formListeners) {
    listener();
  }
}

function subscribeForm(listener: () => void) {
  formListeners.add(listener);
  return () => {
    formListeners.delete(listener);
  };
}

/**
 * A screen says whether a form is on it right now (the public catalog has one only after it loaded); the
 * route's default stands when no screen says.
 */
export function useConnectionNoticeForm(form: boolean) {
  useEffect(() => {
    declareForm(form);
    return () => declareForm(null);
  }, [form]);
}

export function ConnectionRequiredNotice({ form }: { form: boolean }) {
  const [trying, setTrying] = useState(false);
  const handleTry = useCallback(() => {
    if (trying) {
      return;
    }
    setTrying(true);
    tryConnectionNow().finally(() => setTrying(false));
  }, [trying]);
  return (
    <section aria-label="Sem internet" className="connection-required-notice">
      <p id={CONNECTION_NOTICE_TEXT_ID} role="status">
        {form ? CONNECTION_NOTICE_WITH_FORM : CONNECTION_NOTICE_WITHOUT_FORM}
      </p>
      <button
        aria-busy={trying}
        className="quiet-button"
        onClick={handleTry}
        type="button"
      >
        {trying ? "Tentando…" : "Tentar agora"}
      </button>
    </section>
  );
}

/** The notice while the tab is offline, in the form the screen declared (or the route's default). */
export function ConnectionRequiredSlot({ form }: { form: boolean }) {
  const online = useConnectionOnline();
  const declared = useSyncExternalStore(subscribeForm, () => declaredForm);
  return online ? null : <ConnectionRequiredNotice form={declared ?? form} />;
}

/**
 * A control that needs the connection, while there is none: still focusable, it says why (the notice's
 * sentence) and its handler sends nothing (the pattern of a control off with a reason).
 */
export function connectionControlProps(online: boolean): {
  "aria-describedby"?: string;
  "aria-disabled"?: true;
} {
  return online
    ? {}
    : {
        "aria-describedby": CONNECTION_NOTICE_TEXT_ID,
        "aria-disabled": true,
      };
}
