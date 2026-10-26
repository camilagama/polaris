import CloudOffIcon from "lucide-react/dist/esm/icons/cloud-off";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { Button } from "@/ui/button";
import { FORM_NOTICE_CLASS } from "@/ui/dialog-layout";
import {
  tryConnectionNow,
  useConnectionOnline,
} from "../lib/browser-connection";

/**
 * The one notice of the screens that work only with a connection (`ONLINE_ONLY_ROUTES`), shown by the
 * shell while the tab does not reach the Worker (emenda do ADR 0043). Two forms: with a form on screen
 * the typed text stays (only in memory, while the page is open: nothing is written to the disk); without,
 * the screen loads by itself when the connection returns. A control that needs the connection points to
 * the sentence with `aria-describedby` (`CONNECTION_NOTICE_TEXT_ID`). The notice is the v5.1 `Alert` (warning):
 * any online-only screen takes it as `<ConnectionRequiredSlot form={connectionForm} />`, with the `connectionForm` of
 * its route in `navigation-model.ts`.
 */
const CONNECTION_NOTICE_TEXT_ID = "connection-required-text";
/** The same sentence inside a form dialog, whose veil covers the strip of the shell. */
const CONNECTION_DIALOG_TEXT_ID = "connection-required-dialog-text";

const CONNECTION_NOTICE_TITLE = "Sem internet.";
const CONNECTION_NOTICE_WITH_FORM =
  "Esta tela precisa de conexão. O que você digitou fica aqui enquanto esta página estiver aberta.";
const CONNECTION_NOTICE_WITHOUT_FORM =
  "Esta tela precisa de conexão. Ela carrega sozinha quando a conexão voltar.";

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

function ConnectionRequiredNotice({ form }: { form: boolean }) {
  const [trying, setTrying] = useState(false);
  const handleTry = useCallback(() => {
    if (trying) {
      return;
    }
    setTrying(true);
    tryConnectionNow().finally(() => setTrying(false));
  }, [trying]);
  return (
    <Alert className="mb-4 font-sans" variant="warning">
      <CloudOffIcon aria-hidden="true" />
      <AlertTitle>{CONNECTION_NOTICE_TITLE}</AlertTitle>
      <AlertDescription
        className="grid justify-items-start gap-2"
        id={CONNECTION_NOTICE_TEXT_ID}
      >
        {form ? CONNECTION_NOTICE_WITH_FORM : CONNECTION_NOTICE_WITHOUT_FORM}
        <Button
          aria-busy={trying}
          onClick={handleTry}
          size="sm"
          type="button"
          variant="outline"
        >
          {trying ? "Tentando…" : "Tentar agora"}
        </Button>
      </AlertDescription>
    </Alert>
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
 * sentence) and its handler sends nothing (the pattern of a control off with a reason). In a form dialog the
 * sentence is the one of `ConnectionRequiredDialogNotice`, above the buttons: the strip is under the veil.
 */
export function connectionControlProps(
  online: boolean,
  reasonId: string = CONNECTION_NOTICE_TEXT_ID
): {
  "aria-describedby"?: string;
  "aria-disabled"?: true;
} {
  return online
    ? {}
    : {
        "aria-describedby": reasonId,
        "aria-disabled": true,
      };
}

/** The id the buttons of a form dialog point at while there is no connection (`connectionControlProps`). */
export const connectionDialogReasonId = CONNECTION_DIALOG_TEXT_ID;

/**
 * The reason a button of a form dialog is off while there is no connection, with the sentence of the strip of the
 * shell (which the dialog covers): over the footer, always in view, nothing drawn while there is a connection.
 */
export function ConnectionRequiredDialogNotice({
  online,
}: {
  online: boolean;
}) {
  if (online) {
    return null;
  }
  return (
    <div className={FORM_NOTICE_CLASS}>
      <Alert className="font-sans" variant="warning">
        <CloudOffIcon aria-hidden="true" />
        <AlertTitle>{CONNECTION_NOTICE_TITLE}</AlertTitle>
        <AlertDescription id={CONNECTION_DIALOG_TEXT_ID}>
          {CONNECTION_NOTICE_WITH_FORM}
        </AlertDescription>
      </Alert>
    </div>
  );
}
