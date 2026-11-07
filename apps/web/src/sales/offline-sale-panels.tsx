import CloudOffIcon from "lucide-react/dist/esm/icons/cloud-off";
import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
import { type RefObject, useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { Badge } from "@/ui/badge";
import { Card, CardContent, CardHeader } from "@/ui/card";
import { formatBrlAmount } from "../lib/format";
import type { LocalWorkspace } from "../offline/runtime/use-local-workspace";
import type { PendingSale } from "../offline/sale-confirm";
import {
  pendingDateTime,
  pendingStateLabels,
  usePendingSales,
} from "./pending-sales";
import type { QueuedSaleView } from "./sale-form-model";
import { Money } from "./sale-summary-panel";

const LINK =
  "focus-ring rounded-sm underline decoration-input underline-offset-4 hover:decoration-foreground";
/** A link on a line of its own (or in a row of controls): it gets the 44 px touch area; a link inside a sentence does not need it. */
const STANDALONE_LINK = `touch-hit ${LINK}`;

/** Said at the top of the sale form while there is no connection. */
export function OfflineSaleNotice() {
  return (
    <Alert variant="warning">
      <CloudOffIcon aria-hidden="true" />
      <AlertTitle>Sem internet.</AlertTitle>
      <AlertDescription>
        Pode vender: a venda fica guardada neste aparelho e vai quando a conexão
        voltar. O estoque é o do aparelho; se não bastar, o servidor recusa e a
        venda fica em{" "}
        <a className={LINK} href="/attention">
          Pendências
        </a>{" "}
        para você corrigir.
      </AlertDescription>
    </Alert>
  );
}

/** One line of the card of saved sales, from the queue or (the sale kept just now) from what the form knew. */
export interface SavedSaleLine {
  commandId: string;
  /** Null only for the sale kept just now, before the queue was read again. */
  itemCount: number | null;
  justSaved: boolean;
  /** Null when there is no date to show yet. */
  occurredAt: string | null;
  state: PendingSale["state"];
  /** The lines the device's stock does not seem to cover (only for the sale kept just now). */
  stockWarnings: readonly string[];
  /** As formatBrlAmount writes it; null when the total cannot be known (never shown as zero). */
  totalText: string | null;
}

function lineOf(sale: PendingSale): SavedSaleLine {
  return {
    commandId: sale.commandId,
    itemCount: sale.itemCount,
    justSaved: false,
    occurredAt: sale.occurredAt,
    state: sale.state,
    stockWarnings: [],
    totalText: sale.totalDue === null ? null : formatBrlAmount(sale.totalDue),
  };
}

/**
 * The saved sales in the order they are drawn: the one kept just now first (it is in the queue too, so it is not
 * listed twice), then the others in the order of the queue.
 */
export function savedSaleLines(
  sales: readonly PendingSale[],
  justSaved: QueuedSaleView | null
): SavedSaleLine[] {
  const others = sales
    .filter((sale) => sale.commandId !== justSaved?.commandId)
    .map(lineOf);
  if (!justSaved) {
    return others;
  }
  const queued = sales.find((sale) => sale.commandId === justSaved.commandId);
  const first: SavedSaleLine = queued
    ? {
        ...lineOf(queued),
        justSaved: true,
        stockWarnings: justSaved.stockWarnings,
      }
    : {
        commandId: justSaved.commandId,
        itemCount: null,
        justSaved: true,
        occurredAt: null,
        state: "pending",
        stockWarnings: justSaved.stockWarnings,
        totalText: justSaved.totalDue,
      };
  return [first, ...others];
}

/** The sale kept just now has the border and the ring of a chosen card (DESIGN.md), so it reads as the one to look at. */
const ROW_JUST_SAVED =
  "border-foreground/70 bg-secondary ring-1 ring-foreground/10";

function SavedSaleRow({ line }: { line: SavedSaleLine }) {
  const attention =
    line.state === "needs_attention" || line.state === "rejected";
  const when = [
    line.occurredAt ? pendingDateTime.format(new Date(line.occurredAt)) : null,
    line.itemCount === null
      ? null
      : `${line.itemCount} ${line.itemCount === 1 ? "item" : "itens"}`,
  ].filter(Boolean);
  return (
    <li
      className={`grid gap-1.5 rounded-lg border p-3 ${line.justSaved ? ROW_JUST_SAVED : "border-border"}`}
    >
      {line.justSaved ? (
        // a status with its text in the tree: it is what the screen reader says when the sale is kept
        <p role="status">
          <strong>Venda guardada neste aparelho.</strong> O formulário abaixo
          foi reiniciado para uma nova venda.
        </p>
      ) : null}
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="tabular-nums">{when.join(" · ")}</span>
        {line.totalText === null ? (
          <span className="text-muted-foreground text-support">
            valor indisponível
          </span>
        ) : (
          <Money className="font-medium" text={line.totalText} />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Badge variant={attention ? "destructive" : "outline"}>
          {pendingStateLabels[line.state]}
        </Badge>
        {attention ? (
          <a className={`${STANDALONE_LINK} text-support`} href="/attention">
            Resolver em Pendências
          </a>
        ) : null}
      </div>
      {line.stockWarnings.length > 0 ? (
        <Alert role="note" variant="warning">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertDescription className="[&_p]:mb-1!">
            <p>
              O estoque do aparelho parece não cobrir{" "}
              {line.stockWarnings.length === 1 ? "este item" : "estes itens"}. A
              venda foi guardada mesmo assim; o servidor confere e pode
              recusá-la.
            </p>
            <ul className="list-disc pl-4">
              {line.stockWarnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
    </li>
  );
}

/**
 * The one card of the sales this device keeps for the server, on the sale screen and in the history. The sale kept
 * just now (`justSaved`) is its first line, highlighted, and the card takes the focus (`panelRef`) when it appears:
 * it is NOT an official sale yet. Each line says when, how many items, how much and where it stands; the texts that
 * explain it are said once, under the list.
 */
export function SavedSalesCard({
  justSaved = null,
  panelRef,
  workspace,
}: {
  justSaved?: QueuedSaleView | null;
  panelRef?: RefObject<HTMLElement | null> | undefined;
  workspace: LocalWorkspace | null;
}) {
  const sales = usePendingSales(workspace);
  // The sale kept just now leaves the card once the server took it: the queue had it and no longer does. Before the
  // first read of the queue (or while it is read again) it is shown from what the form knew.
  const [seenInQueue, setSeenInQueue] = useState<string | null>(null);
  const inQueue =
    justSaved !== null &&
    sales.some((sale) => sale.commandId === justSaved.commandId);
  useEffect(() => {
    if (justSaved && inQueue) {
      setSeenInQueue(justSaved.commandId);
    }
  }, [inQueue, justSaved]);
  const accepted =
    justSaved !== null && !inQueue && seenInQueue === justSaved.commandId;
  const lines = savedSaleLines(sales, accepted ? null : justSaved);
  if (lines.length === 0) {
    return null;
  }
  return (
    <section
      aria-labelledby="sale-saved-title"
      className="focus-ring rounded-xl"
      ref={panelRef}
      tabIndex={-1}
    >
      <Card>
        <CardHeader>
          <h2 className="text-section" id="sale-saved-title">
            Vendas guardadas neste aparelho
          </h2>
        </CardHeader>
        <CardContent className="grid justify-items-start gap-3">
          <ul className="grid w-full gap-2">
            {lines.map((line) => (
              <SavedSaleRow key={line.commandId} line={line} />
            ))}
          </ul>
          <p className="text-muted-foreground text-support">
            Só viram vendas confirmadas quando o servidor aceitar, assim que
            houver conexão.
          </p>
          <a className={STANDALONE_LINK} href="/attention">
            Acompanhar em Pendências
          </a>
        </CardContent>
      </Card>
    </section>
  );
}
