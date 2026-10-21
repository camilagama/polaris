import CloudOffIcon from "lucide-react/dist/esm/icons/cloud-off";
import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
import type { RefObject } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { Badge } from "@/ui/badge";
import { Card, CardContent, CardHeader } from "@/ui/card";
import type { LocalWorkspace } from "../offline/runtime/use-local-workspace";
import type { PendingSale } from "../offline/sale-confirm";
import {
  pendingDateTime,
  pendingStateLabels,
  usePendingSales,
} from "./pending-sales-panel";
import type { QueuedSaleView } from "./sale-form-model";

const LINK =
  "focus-ring rounded-sm underline decoration-input underline-offset-4 hover:decoration-foreground";

/** Said at the top of the sale form while there is no connection. */
export function OfflineSaleNotice() {
  return (
    <Alert variant="warning">
      <CloudOffIcon aria-hidden="true" />
      <AlertTitle>Sem internet.</AlertTitle>
      <AlertDescription>
        Pode vender: a venda fica guardada neste aparelho e vai quando a conexão
        voltar. O estoque é o do aparelho; se não bastar, o servidor recusa e a
        venda fica em <a href="/attention">Pendências</a> para você corrigir.
      </AlertDescription>
    </Alert>
  );
}

/** After a sale was queued on the device: it is NOT an official sale yet. */
export function QueuedSalePanel({
  panelRef,
  sale,
}: {
  panelRef: RefObject<HTMLElement | null>;
  sale: QueuedSaleView;
}) {
  return (
    <section
      aria-labelledby="sale-queued-title"
      className="focus-ring rounded-xl"
      ref={panelRef}
      tabIndex={-1}
    >
      <Card>
        <CardHeader>
          <div role="status">
            <h2 className="text-section" id="sale-queued-title">
              Venda guardada neste aparelho
            </h2>
          </div>
        </CardHeader>
        <CardContent className="grid justify-items-start gap-3">
          <p>
            Total devido:{" "}
            <strong className="tabular-nums">{sale.totalDue}</strong>. Ela só
            vira uma venda confirmada quando o servidor aceitar, assim que
            houver conexão.
          </p>
          {sale.stockWarnings.length > 0 ? (
            <Alert role="note" variant="warning">
              <TriangleAlertIcon aria-hidden="true" />
              <AlertDescription className="[&_p]:mb-1!">
                <p>
                  O estoque do aparelho parece não cobrir{" "}
                  {sale.stockWarnings.length === 1
                    ? "este item"
                    : "estes itens"}
                  . A venda foi guardada mesmo assim; o servidor confere e pode
                  recusá-la.
                </p>
                <ul className="list-disc pl-4">
                  {sale.stockWarnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}
          <a className={LINK} href="/attention">
            Acompanhar em Pendências
          </a>
          <p className="text-muted-foreground text-support">
            O formulário abaixo foi reiniciado para uma nova venda.
          </p>
        </CardContent>
      </Card>
    </section>
  );
}

const ATTENTION_STATES: ReadonlySet<PendingSale["state"]> = new Set([
  "needs_attention",
  "rejected",
]);

/** The sales this device still holds for the server, with their state (the sale screen's card). */
export function PendingSalesCard({ workspace }: { workspace: LocalWorkspace }) {
  const sales = usePendingSales(workspace);
  if (sales.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby="sale-pending-title">
      <Card>
        <CardHeader>
          <h2 className="text-section" id="sale-pending-title">
            Vendas neste aparelho aguardando o servidor
          </h2>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-2">
            {sales.map((sale) => {
              const attention = ATTENTION_STATES.has(sale.state);
              return (
                <li
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-border border-t pt-2 first:border-t-0 first:pt-0"
                  key={sale.commandId}
                >
                  <span className="tabular-nums">
                    {pendingDateTime.format(new Date(sale.occurredAt))} ·{" "}
                    {sale.itemCount} {sale.itemCount === 1 ? "item" : "itens"}
                  </span>
                  <span className="flex items-center gap-2">
                    <Badge variant={attention ? "destructive" : "outline"}>
                      {pendingStateLabels[sale.state]}
                    </Badge>
                    {attention ? (
                      <a className={`${LINK} text-support`} href="/attention">
                        Resolver em Pendências
                      </a>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>
    </section>
  );
}
