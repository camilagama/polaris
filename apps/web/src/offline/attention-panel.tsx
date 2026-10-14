import { useCallback, useState } from "react";
import {
  type AttentionAction,
  type AttentionItem,
  type AttentionSummary,
  discardWarning,
} from "./attention";
import "./attention-panel.css";

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
  review_account: "Revisar acesso e plano",
};

interface ActionButtonProps {
  action: AttentionAction;
  busy: boolean;
  onAct: (action: AttentionAction) => void;
}

function ActionButton({ action, busy, onAct }: ActionButtonProps) {
  const act = useCallback(() => onAct(action), [action, onAct]);
  return (
    <button
      className={action === "resubmit" ? "primary-button" : "secondary-button"}
      disabled={busy}
      onClick={act}
      type="button"
    >
      {ACTION_LABEL[action]}
    </button>
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
  const act = useCallback(
    (action: AttentionAction) => {
      if (action === "discard") {
        setConfirming(true);
      } else if (action === "resubmit") {
        onResubmit(item);
      } else {
        onReviewAccount(item);
      }
    },
    [item, onResubmit, onReviewAccount]
  );
  const keep = useCallback(() => setConfirming(false), []);
  const confirmDiscard = useCallback(() => {
    setConfirming(false);
    onDiscard(item);
  }, [item, onDiscard]);
  return (
    <li className="attention-item" data-cause={item.cause}>
      <h3>{item.title}</h3>
      {item.blocksQueue ? (
        <p className="attention-blocking">
          Este registro está parando a fila: o que vem depois espera por ele.
        </p>
      ) : null}
      <p>{item.detail}</p>
      <p className="attention-code">Código: {item.code}</p>
      {confirming ? (
        <div className="attention-confirm" role="alertdialog">
          <p>{discardWarning(item)}</p>
          <button
            className="danger-button"
            disabled={busy}
            onClick={confirmDiscard}
            type="button"
          >
            Confirmar descarte
          </button>
          <button className="secondary-button" onClick={keep} type="button">
            Manter
          </button>
        </div>
      ) : (
        <div className="attention-actions">
          {item.actions.map((action) => (
            <ActionButton
              action={action}
              busy={busy}
              key={action}
              onAct={act}
            />
          ))}
        </div>
      )}
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
      <section aria-labelledby="attention-title" className="attention-panel">
        <h2 id="attention-title">Operações que precisam de atenção</h2>
        <p>Nada precisa de atenção. Tudo o que foi feito offline foi aceito.</p>
      </section>
    );
  }
  return (
    <section aria-labelledby="attention-title" className="attention-panel">
      <h2 id="attention-title">Operações que precisam de atenção</h2>
      <p>
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
        <p className="attention-error" role="alert">
          {errorMessage}
        </p>
      ) : null}
      <ul className="attention-list">
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
    </section>
  );
}
