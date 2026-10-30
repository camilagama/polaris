import { LEGAL_PATHS } from "@polaris/domain/legal/legal-documents";
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useRef,
  useState,
} from "react";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/ui/field";
import { Input } from "@/ui/input";
import {
  ConnectionRequiredDialogNotice,
  connectionControlProps,
  connectionDialogReasonId,
} from "../app-shell/connection-required-notice";
import { useConnectionOnline } from "../lib/browser-connection";
import { closedStorePath } from "../lib/closed-store-path";
import { useCurrentOrganization } from "../lib/current-organization";
import { orpcClient } from "../lib/orpc";
import { INLINE_LINK, TEXT_LINK } from "../sign-in/entry-ui";
import { NEW_TAB_HINT } from "../sign-in/sign-in-texts";
import {
  CLOSE_BACK_BUTTON,
  CLOSE_CONFIRM_BUTTON,
  CLOSE_OPEN_BUTTON,
  CLOSE_SECTION_TEXT,
  CLOSE_SECTION_TITLE,
  CLOSE_SENDING_BUTTON,
  CLOSE_WARNINGS_INTRO,
  type CloseGate,
  type CloseRefusal,
  closeDialogTitle,
  closeGate,
  closeRefusal,
  closureWarnings,
  confirmationLabel,
  OTHER_DEVICES_TEXT,
  type QueueState,
  NAME_MISSING_TEXT,
  queueNotice,
} from "./closure-model";
import { useDeviceQueue } from "./use-device-queue";

const SECTION_TITLE_ID = "close-store-title";
const FIELD_ID = "close-store-name";
const GATE_REASON_ID = "close-store-reason";
const QUEUE_ID = "close-store-queue";

function Warnings({ billingSelfService }: { billingSelfService: boolean }) {
  return (
    <div className="grid gap-2">
      <p className="font-medium">{CLOSE_WARNINGS_INTRO}</p>
      <ul className="m-0 grid list-disc gap-1.5 pl-5">
        {closureWarnings(billingSelfService).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p>
        <a
          className={TEXT_LINK}
          href={LEGAL_PATHS.terms}
          rel="noopener noreferrer"
          target="_blank"
        >
          Leia os Termos de Uso
          <span className="sr-only"> ({NEW_TAB_HINT})</span>
        </a>
      </p>
    </div>
  );
}

function QueueLines({ queue }: { queue: QueueState }) {
  const notice = queueNotice(queue);
  return (
    <div className="grid gap-2" id={QUEUE_ID}>
      {notice.lines.length > 0 ? (
        <Alert role="status" variant="warning">
          <AlertDescription>
            {notice.lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </AlertDescription>
        </Alert>
      ) : null}
      <p className="text-muted-foreground">{OTHER_DEVICES_TEXT}</p>
    </div>
  );
}

function RefusalAlert({ refusal }: { refusal: CloseRefusal }) {
  return (
    <Alert role="alert" variant="destructive">
      <AlertDescription>
        {refusal.text}
        {refusal.panelLink ? (
          <>
            {" "}
            <a className={INLINE_LINK} href={closedStorePath()}>
              Ver a loja encerrada
            </a>
          </>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

const REASON_ID: Readonly<Record<"name" | "queue", string>> = {
  name: GATE_REASON_ID,
  queue: QUEUE_ID,
};

/** Off with a reason: the connection's notice, the queue's sentences or the name's; busy while it sends. */
function confirmProps(gate: CloseGate, sending: boolean) {
  if (gate.reason === "connection") {
    return connectionControlProps(false, connectionDialogReasonId);
  }
  if (sending || gate.reason === null) {
    return {};
  }
  return {
    "aria-describedby": REASON_ID[gate.reason],
    "aria-disabled": true as const,
  };
}

interface CloseDialogProps {
  billingSelfService: boolean;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  organizationId: string;
  storeName: string;
}

/**
 * "Encerrar a loja {nome}" (wireframe A): the fixed warnings, the queue of this device, the name to type and one
 * `organization.requestClosure` per tap, never sent again by the dialog. Recorded, the page goes to the panel.
 */
function CloseDialog({
  billingSelfService,
  onOpenChange,
  open,
  organizationId,
  storeName,
}: CloseDialogProps) {
  const online = useConnectionOnline();
  const queue = useDeviceQueue(organizationId, open);
  const [typed, setTyped] = useState("");
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<CloseRefusal | null>(null);
  // a second tap lands before React draws the disabled button
  const sendingRef = useRef(false);
  const gate = closeGate({ online, queue, storeName, typed });

  const handleTyped = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setTyped(event.target.value);
    setRefusal(null);
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      // the answer decides where the page goes: the dialog stays while it waits
      if (!(next || sendingRef.current)) {
        setTyped("");
        setRefusal(null);
      }
      if (next || !sendingRef.current) {
        onOpenChange(next);
      }
    },
    [onOpenChange]
  );

  const send = useCallback(async () => {
    if (!gate.enabled || sendingRef.current) {
      return;
    }
    sendingRef.current = true;
    setSending(true);
    setRefusal(null);
    try {
      await orpcClient.organization.requestClosure({
        confirmation: typed,
        organizationId,
      });
      // a new page: the store no longer opens, and the step back of the dialog's entry is left behind
      window.location.replace(
        closedStorePath({ justClosed: true, storeId: organizationId })
      );
    } catch (error) {
      setRefusal(closeRefusal(error));
      sendingRef.current = false;
      setSending(false);
    }
  }, [gate.enabled, organizationId, typed]);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      send().catch(() => undefined);
    },
    [send]
  );

  const handleBack = useCallback(
    () => handleOpenChange(false),
    [handleOpenChange]
  );

  return (
    <Dialog disablePointerDismissal onOpenChange={handleOpenChange} open={open}>
      <DialogContent layout="form" showCloseButton={!sending}>
        <DialogForm onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{closeDialogTitle(storeName)}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <Warnings billingSelfService={billingSelfService} />
            <QueueLines queue={queue} />
            <Field>
              <FieldLabel htmlFor={FIELD_ID}>
                {confirmationLabel(storeName)}
              </FieldLabel>
              <Input
                aria-describedby={
                  gate.reason === "name" ? GATE_REASON_ID : undefined
                }
                autoCapitalize="off"
                autoComplete="off"
                disabled={sending}
                id={FIELD_ID}
                onChange={handleTyped}
                spellCheck={false}
                value={typed}
              />
              {gate.reason === "name" ? (
                <FieldDescription id={GATE_REASON_ID}>
                  {NAME_MISSING_TEXT}
                </FieldDescription>
              ) : null}
            </Field>
            {refusal ? <RefusalAlert refusal={refusal} /> : null}
          </DialogBody>
          <ConnectionRequiredDialogNotice online={online} />
          <DialogFooter>
            <Button
              disabled={sending}
              onClick={handleBack}
              type="button"
              variant="outline"
            >
              {CLOSE_BACK_BUTTON}
            </Button>
            <Button
              aria-busy={sending}
              disabled={sending}
              type="submit"
              variant="destructive"
              {...confirmProps(gate, sending)}
            >
              {sending ? CLOSE_SENDING_BUTTON : CLOSE_CONFIRM_BUTTON}
            </Button>
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Encerrar a loja" at the end of Seus dados, for the owner of the active store (`organization:close`; the server
 * checks it again). Opening it needs the connection; nothing about the closure is ever kept for later.
 */
export function CloseStoreSection() {
  const { billingSelfService, organization, organizationId } =
    useCurrentOrganization();
  const online = useConnectionOnline();
  const [open, setOpen] = useState(false);

  const handleOpen = useCallback(() => {
    if (online) {
      setOpen(true);
    }
  }, [online]);

  return (
    <Card aria-labelledby={SECTION_TITLE_ID} role="region">
      <CardHeader>
        <CardTitle aria-level={3} id={SECTION_TITLE_ID} role="heading">
          {CLOSE_SECTION_TITLE}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid justify-items-start gap-3">
        <p className="text-muted-foreground">{CLOSE_SECTION_TEXT}</p>
        <Button
          className="max-sm:w-full"
          onClick={handleOpen}
          variant="destructive"
          {...connectionControlProps(online)}
        >
          {CLOSE_OPEN_BUTTON}
        </Button>
      </CardContent>
      <CloseDialog
        billingSelfService={billingSelfService}
        onOpenChange={setOpen}
        open={open}
        organizationId={organizationId}
        storeName={organization.name}
      />
    </Card>
  );
}
