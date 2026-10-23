import CircleAlertIcon from "lucide-react/dist/esm/icons/circle-alert";
import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import {
  type AttentionAction,
  type AttentionItem,
  type AttentionSummary,
  discardWarning,
} from "./attention";

/**
 * The panel of operations that need attention (plan PR58). It lists what the
 * server refused, says why in plain words and offers only the actions that are
 * honest for each cause. There is deliberately no button that forces the
 * synchronization: nothing here applies a refused operation anyway.
 *
 * Discarding is a two-step action: the first click says what will be lost, the
 * second confirms. The panel holds no data of its own; the owner of the outbox
 * passes the summary and the handlers.
 */
export interface AttentionPanelProps {
  /** The command being resolved right now, if any (its buttons are disabled). */
  busyCommandId?: string | null;
  /** Shown when the last attempt to resolve an item failed. */
  errorMessage?: string | null;
  onDiscard: (item: AttentionItem) => void;
  onResubmit: (item: AttentionItem) => void;
  onReviewAccount: (item: AttentionItem) => void;
  summary: AttentionSummary;
}

const ACTION_LABEL: Record<AttentionAction, string> = {
  discard: "Descartar…",
  resubmit: "Reenviar venda",
  resubmit_without_profile: "Reenviar sem perfil de pagamento",
  retry: "Tentar de novo",
  review_account: "Revisar acesso e plano",
};

/** The causes about the account or the plan, not about the data: they are said in the error tone. */
const ACCOUNT_CAUSES: ReadonlySet<AttentionItem["cause"]> = new Set([
  "authorization_revoked",
  "entitlement_changed",
  "session_changed",
]);

const isResubmission = (action: AttentionAction) =>
  action === "resubmit" ||
  action === "resubmit_without_profile" ||
  action === "retry";

const discardButtonId = (item: AttentionItem) =>
  `attention-discard-${item.commandId}`;

/** The frame of the page of attention: the title, then what the page has to say. */
export function AttentionFrame({ children }: { children: ReactNode }) {
  return (
    <div
      className="grid gap-4 font-sans text-foreground text-sm antialiased"
      data-ui=""
    >
      <header className="grid gap-1">
        <h1 className="text-title" id="attention-title">
          Operações que precisam de atenção
        </h1>
      </header>
      {children}
    </div>
  );
}

/** A state of the page that is one line in a card: empty, the offline mode off or still getting ready. */
export function AttentionStateCard({
  children,
  role,
}: {
  children: ReactNode;
  role?: "status" | undefined;
}) {
  return (
    <Card className="items-center px-(--card-spacing) text-center" role={role}>
      <p className="text-muted-foreground">{children}</p>
    </Card>
  );
}

interface ActionButtonProps {
  action: AttentionAction;
  busy: boolean;
  item: AttentionItem;
  onAct: (action: AttentionAction) => void;
}

function ActionButton({ action, busy, item, onAct }: ActionButtonProps) {
  const act = useCallback(() => onAct(action), [action, onAct]);
  let variant: "default" | "destructive" | "outline" = "outline";
  if (isResubmission(action)) {
    variant = "default";
  } else if (action === "discard") {
    variant = "destructive";
  }
  return (
    <Button
      disabled={busy}
      id={action === "discard" ? discardButtonId(item) : undefined}
      onClick={act}
      type="button"
      variant={variant}
    >
      {ACTION_LABEL[action]}
    </Button>
  );
}

interface ItemCardProps {
  busy: boolean;
  item: AttentionItem;
  onDiscard: (item: AttentionItem) => void;
  onResubmit: (item: AttentionItem) => void;
  onReviewAccount: (item: AttentionItem) => void;
}

function ItemCard({
  busy,
  item,
  onDiscard,
  onResubmit,
  onReviewAccount,
}: ItemCardProps) {
  const [confirming, setConfirming] = useState(false);
  const confirmRef = useRef<HTMLDivElement>(null);
  const focusDiscardAgain = useRef<boolean>(false);
  const account = ACCOUNT_CAUSES.has(item.cause);
  const Icon = account ? CircleAlertIcon : TriangleAlertIcon;
  // the confirmation takes the place of the buttons: focus goes to it, and back to "Descartar…" when it is kept
  useEffect(() => {
    if (confirming) {
      confirmRef.current?.focus();
    } else if (focusDiscardAgain.current) {
      focusDiscardAgain.current = false;
      document.getElementById(discardButtonId(item))?.focus();
    }
  }, [confirming, item]);
  const act = useCallback(
    (action: AttentionAction) => {
      if (action === "discard") {
        setConfirming(true);
      } else if (isResubmission(action)) {
        onResubmit(item);
      } else {
        onReviewAccount(item);
      }
    },
    [item, onResubmit, onReviewAccount]
  );
  const keep = useCallback(() => {
    focusDiscardAgain.current = true;
    setConfirming(false);
  }, []);
  const confirmDiscard = useCallback(() => {
    setConfirming(false);
    onDiscard(item);
  }, [item, onDiscard]);
  return (
    <li data-cause={item.cause}>
      <Card className="gap-3 px-(--card-spacing)">
        <div className="flex items-start gap-2">
          <Icon
            aria-hidden="true"
            className={cn(
              "mt-0.5 size-4 shrink-0",
              account ? "text-destructive" : "text-warning"
            )}
          />
          <h2 className="text-section [overflow-wrap:anywhere]">
            {item.title}
          </h2>
        </div>
        {item.blocksQueue ? (
          <p className="font-medium text-support text-warning">
            Este registro está parando a fila: o que vem depois espera por ele.
          </p>
        ) : null}
        <p className="[overflow-wrap:anywhere]">{item.detail}</p>
        <p className="font-mono text-muted-foreground text-xs [overflow-wrap:anywhere]">
          Código: {item.code}
        </p>
        {confirming ? (
          <div
            aria-label={`Descartar ${item.title}`}
            className="grid gap-3 rounded-lg bg-muted/50 p-3 outline-none ring-1 ring-destructive/30 focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-2"
            ref={confirmRef}
            role="alertdialog"
            tabIndex={-1}
          >
            <p>{discardWarning(item)}</p>
            <div className="flex flex-wrap gap-3">
              <Button
                disabled={busy}
                onClick={confirmDiscard}
                type="button"
                variant="destructive"
              >
                Confirmar descarte
              </Button>
              <Button onClick={keep} type="button" variant="outline">
                Manter
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-3">
            {item.actions.map((action) => (
              <ActionButton
                action={action}
                busy={busy}
                item={item}
                key={action}
                onAct={act}
              />
            ))}
          </div>
        )}
      </Card>
    </li>
  );
}

export function AttentionPanel({
  busyCommandId = null,
  errorMessage = null,
  onDiscard,
  onResubmit,
  onReviewAccount,
  summary,
}: AttentionPanelProps) {
  if (summary.items.length === 0) {
    return (
      <AttentionFrame>
        <AttentionStateCard>
          Nada precisa de atenção. Tudo o que foi feito offline foi aceito.
        </AttentionStateCard>
      </AttentionFrame>
    );
  }
  return (
    <AttentionFrame>
      <p className="text-muted-foreground text-support">
        O servidor recusou{" "}
        {summary.items.length === 1
          ? "1 registro"
          : `${summary.items.length} registros`}{" "}
        feito{summary.items.length === 1 ? "" : "s"} offline.
        {summary.waitingBehind > 0
          ? ` ${summary.waitingBehind} ${summary.waitingBehind === 1 ? "registro espera" : "registros esperam"} na fila atrás ${summary.waitingBehind === 1 ? "dele" : "deles"}.`
          : ""}
      </p>
      {errorMessage ? (
        <Alert variant="destructive">
          <CircleAlertIcon aria-hidden="true" />
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      ) : null}
      <ul className="grid gap-3">
        {summary.items.map((item) => (
          <ItemCard
            busy={busyCommandId === item.commandId}
            item={item}
            key={item.commandId}
            onDiscard={onDiscard}
            onResubmit={onResubmit}
            onReviewAccount={onReviewAccount}
          />
        ))}
      </ul>
    </AttentionFrame>
  );
}
