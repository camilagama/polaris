import { useCallback, useState } from "react";
import type { BlockedWorkspace, LogoutBlockReason } from "./logout-guard";
import "./logout-dialog.css";

/**
 * What the person sees when logging out would lose work (plan PR59). It never
 * ends the session itself and has no "log out anyway": the ways out are to send
 * the queue (try again), to look at what the server refused, to stay signed in,
 * or to discard the queued operations on purpose, in two steps that say what
 * will be lost.
 */
export interface LogoutDialogProps {
  blocked: readonly BlockedWorkspace[];
  busy?: boolean;
  errorMessage?: string | null;
  onCancel: () => void;
  onDiscard: () => void;
  onRetry: () => void;
  onShowAttention: () => void;
}

const REASON_TEXT: Record<LogoutBlockReason, string> = {
  offline:
    "Não foi possível enviar: sem conexão com o servidor. Conecte-se e tente de novo.",
  refused:
    "O servidor recusou operações. Elas precisam de uma decisão sua antes de sair.",
  still_pending: "Ainda há operações esperando na fila. Tente enviar de novo.",
};

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function LogoutDialog({
  blocked,
  busy = false,
  errorMessage = null,
  onCancel,
  onDiscard,
  onRetry,
  onShowAttention,
}: LogoutDialogProps) {
  const [confirming, setConfirming] = useState(false);
  const askDiscard = useCallback(() => setConfirming(true), []);
  const keep = useCallback(() => setConfirming(false), []);
  const confirmDiscard = useCallback(() => {
    setConfirming(false);
    onDiscard();
  }, [onDiscard]);

  const total = blocked.reduce((sum, item) => sum + item.total, 0);
  const sending = blocked.reduce((sum, item) => sum + item.sending, 0);
  const needsAttention = blocked.some(
    (item) => item.attention.items.length > 0
  );

  return (
    <section
      aria-labelledby="logout-title"
      className="logout-dialog"
      role="alertdialog"
    >
      <h2 id="logout-title">Há trabalho que ainda não foi enviado</h2>
      <p>
        Este aparelho guarda {plural(total, "operação", "operações")} que o
        servidor ainda não recebeu. Se você sair agora sem enviar, elas se
        perdem.
      </p>
      <ul className="logout-workspaces">
        {blocked.map((item) => (
          <li key={item.label}>
            <strong>{item.label}</strong>:{" "}
            {plural(item.total, "operação", "operações")}.{" "}
            {REASON_TEXT[item.reason]}
          </li>
        ))}
      </ul>
      {errorMessage ? (
        <p className="logout-error" role="alert">
          {errorMessage}
        </p>
      ) : null}
      {confirming ? (
        <div className="logout-confirm">
          <p>
            Isto apaga {plural(total, "operação", "operações")} deste aparelho,
            sem registrá-las no servidor, e depois encerra a sessão.
            {sending > 0
              ? ` ${plural(sending, "delas já foi enviada", "delas já foram enviadas")} e o servidor pode ter recebido: confira antes se ${sending === 1 ? "ela" : "elas"} apareceu no sistema.`
              : ""}
          </p>
          <button
            className="danger-button"
            disabled={busy}
            onClick={confirmDiscard}
            type="button"
          >
            Descartar e sair
          </button>
          <button className="secondary-button" onClick={keep} type="button">
            Voltar
          </button>
        </div>
      ) : (
        <div className="logout-actions">
          <button
            className="primary-button"
            disabled={busy}
            onClick={onRetry}
            type="button"
          >
            Tentar enviar de novo
          </button>
          {needsAttention ? (
            <button
              className="secondary-button"
              disabled={busy}
              onClick={onShowAttention}
              type="button"
            >
              Ver o que precisa de atenção
            </button>
          ) : null}
          <button
            className="secondary-button"
            disabled={busy}
            onClick={onCancel}
            type="button"
          >
            Ficar conectado
          </button>
          <button
            className="danger-button"
            disabled={busy}
            onClick={askDiscard}
            type="button"
          >
            Descartar e sair…
          </button>
        </div>
      )}
    </section>
  );
}
