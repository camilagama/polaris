import CircleAlertIcon from "lucide-react/dist/esm/icons/circle-alert";
import { useCallback, useRef } from "react";
import { Alert, AlertDescription } from "@/ui/alert";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import { Checkbox } from "@/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/ui/field";
import {
  confirmLabel,
  type DeviceRow,
  END_OTHER_SESSIONS_HELP,
  END_OTHER_SESSIONS_LABEL,
  END_OTHER_SESSIONS_WARNING,
  REVOKE_TITLE,
  REVOKE_WARNING,
  REVOKE_WARNING_NOTE,
  REVOKING_LABEL,
} from "./devices-model";

/** Where the focus goes when the confirmation closes without a cancel: the heading of the screen. */
export const DEVICES_HEADING_ID = "devices-title";

interface RowProps {
  /** What went wrong with the last attempt, said inside the confirmation, right above the buttons. */
  actionError: string | null;
  busy: boolean;
  confirming: boolean;
  endOtherSessions: boolean;
  offline: boolean;
  onAsk: (id: string) => void;
  onCancel: () => void;
  onChoose: (endOtherSessions: boolean) => void;
  /** There is a connection: Sair can revoke this device on the server before it leaves. */
  online: boolean;
  onRevoke: (id: string) => void;
  /** The line of the screen that says why the button is off (offline, or this browser's device not known yet). */
  reasonId?: string | undefined;
  row: DeviceRow;
  /** The session is over (the panel above says so): no promise about what Sair does. */
  sessionGone: boolean;
}

const THIS_DEVICE_ONLINE_HELP = (
  <>
    Para tirar este aparelho, use <strong>Sair</strong>: no celular ele está em
    Mais; em tela grande, no menu ⋯ do cartão da loja, no pé da barra lateral.
  </>
);
const THIS_DEVICE_OFFLINE_HELP =
  "Sair sem internet não tira este aparelho da lista. Ele sai quando você sair conectado, ou pode ser revogado de outro aparelho.";

interface RevokeFormProps {
  actionError: string | null;
  busy: boolean;
  endOtherSessions: boolean;
  offline: boolean;
  onCancel: () => void;
  onChoose: (endOtherSessions: boolean) => void;
  onRevoke: () => void;
  /** The line of the screen that says why the confirm is off; it is read from the page even behind the dialog. */
  reasonId?: string | undefined;
  row: DeviceRow;
}

/**
 * The rest of the confirmation of a revocation, in the order of the rule: the extra choice (always
 * unticked on opening), the error of the attempt right above the buttons, then the buttons.
 */
export function RevokeForm({
  actionError,
  busy,
  endOtherSessions,
  offline,
  onCancel,
  onChoose,
  onRevoke,
  reasonId,
  row,
}: RevokeFormProps) {
  const blocked = busy || offline;
  const helpId = `${row.id}-help`;
  return (
    <>
      <Field orientation="horizontal">
        <Checkbox
          aria-describedby={helpId}
          checked={endOtherSessions}
          disabled={blocked}
          id={`${row.id}-end-others`}
          onCheckedChange={onChoose}
        />
        <FieldContent>
          <FieldLabel htmlFor={`${row.id}-end-others`}>
            {END_OTHER_SESSIONS_LABEL}
          </FieldLabel>
          <FieldDescription id={helpId}>
            {END_OTHER_SESSIONS_HELP}
          </FieldDescription>
        </FieldContent>
      </Field>
      {endOtherSessions ? (
        <p className="font-medium">{END_OTHER_SESSIONS_WARNING}</p>
      ) : null}
      {actionError ? (
        <Alert variant="destructive">
          <CircleAlertIcon aria-hidden="true" />
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}
      <DialogFooter className="gap-3">
        <Button
          aria-disabled={busy || undefined}
          onClick={busy ? undefined : onCancel}
          type="button"
          variant="outline"
        >
          Cancelar
        </Button>
        <Button
          aria-describedby={offline ? reasonId : undefined}
          aria-disabled={blocked || undefined}
          // the label is long ("…e encerrar as outras sessões"): it wraps, so it fits a 320 px dialog
          className="h-auto! min-h-ctl-md whitespace-normal py-1.5 text-center"
          onClick={blocked ? undefined : onRevoke}
          type="button"
          variant="destructive"
        >
          {busy ? REVOKING_LABEL : confirmLabel(endOtherSessions)}
        </Button>
      </DialogFooter>
    </>
  );
}

/** The confirmation, in a dialog: the effect first (title and the two sentences), then the form. */
function RevokeBody(props: RevokeFormProps) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {REVOKE_TITLE}
          <span className="sr-only"> ({props.row.labelText})</span>
        </DialogTitle>
        <DialogDescription className="grid gap-2" render={<div />}>
          <p>{REVOKE_WARNING}</p>
          <p>{REVOKE_WARNING_NOTE}</p>
        </DialogDescription>
      </DialogHeader>
      <RevokeForm {...props} />
    </>
  );
}

export function DeviceItem({
  actionError,
  busy,
  confirming,
  endOtherSessions,
  offline,
  onAsk,
  onCancel,
  onChoose,
  onRevoke,
  online,
  reasonId,
  row,
  sessionGone,
}: RowProps) {
  const askRef = useRef<HTMLButtonElement>(null);
  const cancelled = useRef<boolean>(false);
  const handleAsk = useCallback(() => onAsk(row.id), [onAsk, row.id]);
  const handleRevoke = useCallback(() => onRevoke(row.id), [onRevoke, row.id]);
  const handleChoose = useCallback(
    (checked: boolean) => onChoose(checked),
    [onChoose]
  );
  const handleCancel = useCallback(() => {
    cancelled.current = true;
    onCancel();
  }, [onCancel]);
  // Escape and a press outside are a cancel too, but not while the call runs
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!(open || busy)) {
        handleCancel();
      }
    },
    [busy, handleCancel]
  );
  // back to "Revogar" after a cancel; after a revocation the row may be gone: the heading of the screen keeps the place
  const finalFocus = useCallback(() => {
    if (cancelled.current) {
      cancelled.current = false;
      return askRef.current;
    }
    return document.getElementById(DEVICES_HEADING_ID);
  }, []);
  return (
    <li>
      <Card className="gap-2 px-(--card-spacing)">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="font-medium [overflow-wrap:anywhere]">
            {row.labelText}
          </p>
          {row.isCurrent ? (
            <Badge variant="outline">Este aparelho</Badge>
          ) : null}
        </div>
        <p className="text-muted-foreground text-support">
          Registrado em {row.registeredText} · visto por último em{" "}
          {row.lastSeenText}
        </p>
        {row.isCurrent && !sessionGone ? (
          <p className="text-muted-foreground text-support">
            {online ? THIS_DEVICE_ONLINE_HELP : THIS_DEVICE_OFFLINE_HELP}
          </p>
        ) : null}
        {row.isCurrent ? null : (
          <>
            <Button
              aria-describedby={offline ? reasonId : undefined}
              aria-disabled={busy || offline || undefined}
              aria-label={`Revogar o aparelho ${row.labelText}`}
              className="mt-1 self-start"
              onClick={busy || offline ? undefined : handleAsk}
              ref={askRef}
              type="button"
              variant="destructive"
            >
              Revogar
            </Button>
            <Dialog onOpenChange={handleOpenChange} open={confirming}>
              <DialogContent
                className="sm:max-w-md"
                finalFocus={finalFocus}
                showCloseButton={false}
              >
                <RevokeBody
                  actionError={actionError}
                  busy={busy}
                  endOtherSessions={endOtherSessions}
                  offline={offline}
                  onCancel={handleCancel}
                  onChoose={handleChoose}
                  onRevoke={handleRevoke}
                  reasonId={reasonId}
                  row={row}
                />
              </DialogContent>
            </Dialog>
          </>
        )}
      </Card>
    </li>
  );
}
