import { useCallback, useState } from "react";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Card, CardContent } from "@/ui/card";
import type { BlockedWorkspace, LogoutBlockReason } from "./logout-guard";

/**
 * What the person sees when logging out would lose work (plan PR59). It never
 * ends the session itself and has no "log out anyway": the ways out are to send
 * the queue (try again), to look at what the server refused, to stay signed in,
 * or to discard the queued operations on purpose, in two steps that say what
 * will be lost.
 *
 * It is a panel in the page (`alertdialog`), not a modal: the Base UI Dialog would add about 6 KB to the precache,
 * past the budget of the shell, and the panel is what the person already sees under "Sair".
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
    <Card
      aria-describedby="logout-description"
      aria-labelledby="logout-title"
      className="font-sans"
      role="alertdialog"
    >
      <CardContent className="grid gap-4">
        <div className="grid gap-2">
          <h2 className="text-section" id="logout-title">
            Há trabalho que ainda não foi enviado
          </h2>
          <p className="text-muted-foreground" id="logout-description">
            Este aparelho guarda {plural(total, "operação", "operações")} que o
            servidor ainda não recebeu. Se você sair agora sem enviar, elas se
            perdem.
          </p>
        </div>
        <ul className="m-0 grid list-none gap-1.5 p-0 text-support">
          {blocked.map((item) => (
            <li key={item.label}>
              <strong className="font-semibold">{item.label}</strong>:{" "}
              {plural(item.total, "operação", "operações")}.{" "}
              {REASON_TEXT[item.reason]}
            </li>
          ))}
        </ul>
        {errorMessage ? (
          <Alert variant="destructive">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}
        {confirming ? (
          <div className="grid gap-3">
            <Alert variant="destructive">
              <AlertDescription>
                Isto apaga {plural(total, "operação", "operações")} deste
                aparelho, sem registrá-las no servidor, e depois encerra a
                sessão.
                {sending > 0
                  ? ` ${plural(sending, "delas já foi enviada", "delas já foram enviadas")} e o servidor pode ter recebido: confira antes se ${sending === 1 ? "ela" : "elas"} apareceu no sistema.`
                  : ""}
              </AlertDescription>
            </Alert>
            <Button
              disabled={busy}
              onClick={confirmDiscard}
              type="button"
              variant="destructive"
            >
              Descartar e sair
            </Button>
            <Button onClick={keep} type="button" variant="outline">
              Voltar
            </Button>
          </div>
        ) : (
          <div className="grid gap-3">
            <Button disabled={busy} onClick={onRetry} type="button">
              Tentar enviar de novo
            </Button>
            {needsAttention ? (
              <Button
                disabled={busy}
                onClick={onShowAttention}
                type="button"
                variant="outline"
              >
                Ver o que precisa de atenção
              </Button>
            ) : null}
            <Button
              disabled={busy}
              onClick={onCancel}
              type="button"
              variant="outline"
            >
              Ficar conectado
            </Button>
            <Button
              disabled={busy}
              onClick={askDiscard}
              type="button"
              variant="destructive"
            >
              Descartar e sair…
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
