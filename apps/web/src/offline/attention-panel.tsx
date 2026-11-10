import CircleAlertIcon from "lucide-react/dist/esm/icons/circle-alert";
import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { MASKED_SPOKEN, maskMoney, useHiddenValues } from "@/lib/hidden-values";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { Button, buttonVariants } from "@/ui/button";
import { Card } from "@/ui/card";
import { MoneyText } from "@/ui/hidden-values";
import { ActionStrip } from "../app-shell/action-strip";
import { tabHref } from "../app-shell/navigation-model";
import {
  type AttentionAction,
  type AttentionItem,
  type AttentionSummary,
  discardWarning,
} from "./attention";
import {
  isBrowserFailure,
  PLAN_REFUSED_REASON,
} from "./runtime/offline-runtime";
import { type RedoLineProblem, redoProblemText } from "./sale-redo";

export interface RedoProblem {
  commandId: string;
  /** The lines that stopped the form from being filled; empty when the message says it all. */
  lines: readonly RedoLineProblem[];
  message: string;
}

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
  /** What the last attempt to resolve an item said, drawn inside the card of that item. */
  error?: AttentionError | null;
  onDiscard: (item: AttentionItem) => void;
  onRedo?: (item: AttentionItem) => void;
  onResubmit: (item: AttentionItem) => void;
  /** What the sign-out has to say (its failure, the work it would lose), under the list. */
  notices?: ReactNode;
  onSignInAgain: (item: AttentionItem) => void;
  /** Why "Refazer esta venda" did not open Vender, shown in the card of that sale. */
  redoProblem?: RedoProblem | null;
  /** A sign-out is under way: "Sair e entrar de novo" is off in every card. */
  signingOut?: boolean;
  summary: AttentionSummary;
}

export interface AttentionError {
  commandId: string;
  message: string;
}

const ACTION_LABEL: Record<AttentionAction, string> = {
  discard: "Descartar…",
  redo_sale: "Refazer esta venda",
  resubmit: "Reenviar venda",
  resubmit_without_profile: "Reenviar sem perfil de pagamento",
  retry: "Tentar novamente",
  open_subscription: "Ver Assinatura",
  sign_in_again: "Sair e entrar de novo",
};

const SUBSCRIPTION_HREF = tabHref("settings", "assinatura");

/** The causes about the account or the plan, not about the data: they are said in the error tone. */
const ACCOUNT_CAUSES: ReadonlySet<AttentionItem["cause"]> = new Set([
  "authorization_revoked",
  "entitlement_changed",
  "session_changed",
]);

const actionLabel = (action: AttentionAction, item: AttentionItem) =>
  action === "discard" && item.redone
    ? "Descartar a venda recusada…"
    : ACTION_LABEL[action];

const isResubmission = (action: AttentionAction) =>
  action === "resubmit" ||
  action === "resubmit_without_profile" ||
  action === "retry";

const discardButtonId = (item: AttentionItem) =>
  `attention-discard-${item.commandId}`;

/** The button that starts a sign-out: the focus comes back to it when the sign-out is not done. */
export const signInAgainButtonId = (commandId: string) =>
  `attention-sign-in-${commandId}`;

function buttonIdOf(
  action: AttentionAction,
  item: AttentionItem
): string | undefined {
  if (action === "discard") {
    return discardButtonId(item);
  }
  return action === "sign_in_again"
    ? signInAgainButtonId(item.commandId)
    : undefined;
}

const ATTENTION_SUBTITLE = "O que o servidor recusou e precisa da sua decisão.";

/** The frame of the page of attention: the title, then what the page has to say. */
export function AttentionFrame({
  children,
  withSubtitle = true,
}: {
  children: ReactNode;
  withSubtitle?: boolean;
}) {
  return (
    <div className="grid gap-4 font-sans text-foreground text-sm antialiased">
      <header className="grid gap-1">
        <h1 className="text-title" id="attention-title">
          Pendências
        </h1>
        {withSubtitle ? (
          <p className="text-muted-foreground" id="attention-subtitle">
            {ATTENTION_SUBTITLE}
          </p>
        ) : null}
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

export const OFFLINE_UNAVAILABLE_TITLE = "Sem modo offline neste aparelho";
export const OFFLINE_PLAN_REASON = "O modo offline faz parte do plano Pro.";
/** The first sentence of the text of Aparelhos for the same cause. */
export const OFFLINE_BROWSER_REASON =
  "Este navegador não conseguiu preparar o acesso offline.";
export const OFFLINE_NEUTRAL_REASON =
  "O modo offline não está disponível neste aparelho agora.";
const HOME_HREF = "/";

function unavailableSentence(reason: string | null): string {
  if (reason === PLAN_REFUSED_REASON) {
    return OFFLINE_PLAN_REASON;
  }
  return isBrowserFailure(reason)
    ? OFFLINE_BROWSER_REASON
    : OFFLINE_NEUTRAL_REASON;
}

/**
 * Pendências on a device where the offline mode is not available: the title, why, and the way back to the app. The
 * subtitle promises a list of refused records, which this device cannot read, so it is left out.
 */
export function AttentionUnavailable({ reason }: { reason: string | null }) {
  return (
    <AttentionFrame withSubtitle={false}>
      <Alert variant="warning">
        <TriangleAlertIcon aria-hidden="true" />
        <AlertTitle>{OFFLINE_UNAVAILABLE_TITLE}</AlertTitle>
        <AlertDescription>{unavailableSentence(reason)}</AlertDescription>
      </Alert>
      <div>
        <a className={buttonVariants()} href={HOME_HREF}>
          Voltar ao Início
        </a>
      </div>
    </AttentionFrame>
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
  if (action === "open_subscription") {
    return (
      <a
        className={buttonVariants({ variant: "outline" })}
        href={SUBSCRIPTION_HREF}
      >
        {ACTION_LABEL[action]}
      </a>
    );
  }
  let variant: "default" | "destructive" | "outline" = "outline";
  if (isResubmission(action) || action === "redo_sale") {
    variant = "default";
  } else if (action === "discard") {
    variant = "destructive";
  }
  return (
    <Button
      disabled={busy}
      id={buttonIdOf(action, item)}
      onClick={act}
      type="button"
      variant={variant}
    >
      {actionLabel(action, item)}
    </Button>
  );
}

interface ItemCardProps {
  busy: boolean;
  errorMessage: string | null;
  item: AttentionItem;
  onDiscard: (item: AttentionItem) => void;
  onRedo: (item: AttentionItem) => void;
  onResubmit: (item: AttentionItem) => void;
  onSignInAgain: (item: AttentionItem) => void;
  redoProblem: RedoProblem | null;
  signingOut: boolean;
}

function ItemCard({
  busy,
  errorMessage,
  item,
  onDiscard,
  onRedo,
  onResubmit,
  onSignInAgain,
  redoProblem,
  signingOut,
}: ItemCardProps) {
  const [confirming, setConfirming] = useState(false);
  const confirmRef = useRef<HTMLDivElement>(null);
  const focusDiscardAgain = useRef<boolean>(false);
  const [hidden] = useHiddenValues();
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
      } else if (action === "redo_sale") {
        onRedo(item);
      } else if (isResubmission(action)) {
        onResubmit(item);
      } else {
        onSignInAgain(item);
      }
    },
    [item, onRedo, onResubmit, onSignInAgain]
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
            <MoneyText text={item.title} />
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
            aria-label={`Descartar ${hidden ? maskMoney(item.title, MASKED_SPOKEN) : item.title}`}
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
                busy={busy || (action === "sign_in_again" && signingOut)}
                item={item}
                key={action}
                onAct={act}
              />
            ))}
          </div>
        )}
        {errorMessage ? (
          <Alert variant="destructive">
            <CircleAlertIcon aria-hidden="true" />
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}
        {redoProblem ? (
          <Alert variant="destructive">
            <CircleAlertIcon aria-hidden="true" />
            <AlertDescription className="grid gap-2">
              <p>{redoProblem.message}</p>
              {redoProblem.lines.length > 0 ? (
                <ul className="grid list-disc gap-1 pl-5">
                  {redoProblem.lines.map((line) => (
                    <li
                      className="[overflow-wrap:anywhere]"
                      key={`${line.kind}:${line.label}`}
                    >
                      <MoneyText text={redoProblemText(line)} />
                    </li>
                  ))}
                </ul>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}
      </Card>
    </li>
  );
}

/** "2 registros recusados · 1 na fila atrás deles": the refused, then the ones waiting behind them. */
export function refusedText(summary: AttentionSummary): string {
  const refused = summary.items.length;
  const text = `${refused} ${refused === 1 ? "registro recusado" : "registros recusados"}`;
  return summary.waitingBehind > 0
    ? `${text} · ${summary.waitingBehind} na fila atrás ${refused === 1 ? "dele" : "deles"}`
    : text;
}

const noRedo = () => undefined;

export function AttentionPanel({
  busyCommandId = null,
  error = null,
  notices = null,
  onDiscard,
  onRedo = noRedo,
  onResubmit,
  onSignInAgain,
  redoProblem = null,
  signingOut = false,
  summary,
}: AttentionPanelProps) {
  if (summary.items.length === 0) {
    return (
      <AttentionFrame>
        <AttentionStateCard>
          Nenhuma pendência de envio. Tudo o que foi feito sem internet foi
          aceito.
        </AttentionStateCard>
        {notices}
      </AttentionFrame>
    );
  }
  return (
    <AttentionFrame>
      <ActionStrip>{refusedText(summary)}</ActionStrip>
      <ul className="grid gap-3">
        {summary.items.map((item) => (
          <ItemCard
            busy={busyCommandId === item.commandId}
            errorMessage={
              error?.commandId === item.commandId ? error.message : null
            }
            item={item}
            key={item.commandId}
            onDiscard={onDiscard}
            onRedo={onRedo}
            onResubmit={onResubmit}
            onSignInAgain={onSignInAgain}
            redoProblem={
              redoProblem?.commandId === item.commandId ? redoProblem : null
            }
            signingOut={signingOut}
          />
        ))}
      </ul>
      {notices}
    </AttentionFrame>
  );
}
