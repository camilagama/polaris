import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
import { type RefObject, useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/ui/alert";
import { Badge } from "@/ui/badge";
import { Block, BlockHeader, BlockPanel } from "@/ui/block";
import { InsetBlock } from "@/ui/inset-block";
import { TextLink } from "@/ui/text-link";
import { OfflineNotice } from "../app-shell/offline-notice";
import { formatBrlAmount } from "../lib/format";
import type { LocalWorkspace } from "../offline/runtime/use-local-workspace";
import type { PendingSale } from "../offline/sale-confirm";
import {
  pendingDateTime,
  pendingStateLabels,
  usePendingSales,
} from "./pending-sales";
import { SaleCountLabel } from "./sale-count-label";
import type { SaleCount } from "./sale-count-text";
import { type QueuedSaleView, SALE_METHOD_CARDS } from "./sale-form-model";
import { Money } from "./sale-summary-panel";

/** Said at the top of the sale form while there is no connection. */
export function OfflineSaleNotice() {
  return (
    <OfflineNotice>
      Pode vender: a venda fica guardada neste aparelho e vai quando a conexão
      voltar. Se o estoque não bastar, ela fica em{" "}
      <TextLink inline href="/attention">
        Pendências
      </TextLink>{" "}
      para você corrigir.
    </OfflineNotice>
  );
}

/** One line of the card of saved sales, from the queue or (the sale kept just now) from what the form knew. */
export interface SavedSaleLine {
  commandId: string;
  /** Lines and units of the sale; null only for the sale kept just now, before the queue was read again. */
  count: SaleCount | null;
  justSaved: boolean;
  /** Null when there is no date to show yet. */
  occurredAt: string | null;
  /** "Pix + Crédito" for a sale paid in parts; null for a sale paid in one go, whose line stays as it always was. */
  partsText: string | null;
  state: PendingSale["state"];
  /** The lines the device's stock does not seem to cover (only for the sale kept just now). */
  stockWarnings: readonly string[];
  /** As formatBrlAmount writes it; null when the total cannot be known (never shown as zero). */
  totalText: string | null;
}

const METHOD_LABELS = new Map<string, string>(SALE_METHOD_CARDS);

function lineOf(sale: PendingSale): SavedSaleLine {
  return {
    commandId: sale.commandId,
    count: { lines: sale.lineCount, units: sale.unitCount },
    justSaved: false,
    occurredAt: sale.occurredAt,
    partsText:
      sale.partMethods
        ?.map((method) => METHOD_LABELS.get(method) ?? "Outro")
        .join(" + ") ?? null,
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
        count: null,
        justSaved: true,
        occurredAt: null,
        partsText: null,
        state: "pending",
        stockWarnings: justSaved.stockWarnings,
        totalText: justSaved.totalDue,
      };
  return [first, ...others];
}

/** The sale kept just now carries a ring on its `InsetBlock`, so it reads as the one to look at. */
const ROW_JUST_SAVED = "ring-1 ring-foreground/70";

/** "lines-and-units" on the sale screen; "items" (the lines alone, as before) in the history. */
export type SavedSaleCountStyle = "items" | "lines-and-units";

function SavedSaleWhen({
  countStyle,
  line,
}: {
  countStyle: SavedSaleCountStyle;
  line: SavedSaleLine;
}) {
  const date = line.occurredAt
    ? pendingDateTime.format(new Date(line.occurredAt))
    : null;
  if (countStyle === "items") {
    const lines = line.count?.lines ?? null;
    return (
      <span className="tabular-nums">
        {[
          date,
          lines === null ? null : `${lines} ${lines === 1 ? "item" : "itens"}`,
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
    );
  }
  return (
    <span className="tabular-nums">
      {date}
      {date && line.count ? (
        <>
          <span aria-hidden="true"> · </span>
          <span className="sr-only">, </span>
        </>
      ) : null}
      {line.count ? <SaleCountLabel count={line.count} /> : null}
    </span>
  );
}

export function SavedSaleRow({
  countStyle = "lines-and-units",
  line,
}: {
  countStyle?: SavedSaleCountStyle;
  line: SavedSaleLine;
}) {
  const attention =
    line.state === "needs_attention" || line.state === "rejected";
  return (
    <li>
      <InsetBlock
        className={`grid gap-1.5 p-3 ${line.justSaved ? ROW_JUST_SAVED : ""}`}
      >
        {line.justSaved ? (
          // a status with its text in the tree: it is what the screen reader says when the sale is kept
          <p role="status">
            <strong>Venda guardada neste aparelho.</strong> O formulário abaixo
            foi reiniciado para uma nova venda.
          </p>
        ) : null}
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <SavedSaleWhen countStyle={countStyle} line={line} />
          {line.totalText === null ? (
            <span className="text-muted-foreground text-support">
              valor indisponível
            </span>
          ) : (
            <Money className="font-medium" text={line.totalText} />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {line.partsText === null ? null : (
            <span className="text-muted-foreground text-support">
              {line.partsText}
            </span>
          )}
          <Badge variant={attention ? "destructive" : "outline"}>
            {pendingStateLabels[line.state]}
          </Badge>
          {attention ? (
            <TextLink className="text-support" href="/attention">
              Resolver em Pendências
            </TextLink>
          ) : null}
        </div>
        {line.stockWarnings.length > 0 ? (
          <Alert role="note" variant="warning">
            <TriangleAlertIcon aria-hidden="true" />
            <AlertDescription className="[&_p]:mb-1!">
              <p>
                O estoque do aparelho parece não cobrir{" "}
                {line.stockWarnings.length === 1 ? "este item" : "estes itens"}.
                A venda foi guardada mesmo assim; o servidor confere e pode
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
      </InsetBlock>
    </li>
  );
}

/**
 * The one card of the sales this device keeps for the server, on the sale screen and in the history. The sale kept
 * just now (`justSaved`) is its first line, highlighted, and the card takes the focus (`panelRef`) when it appears:
 * it is NOT an official sale yet. Each line says when, how many lines and units (on the sale screen) or how many
 * items (`countStyle="items"`, the history), how much and where it stands; the texts that explain it are said once,
 * under the list.
 */
export function SavedSalesCard({
  countStyle = "lines-and-units",
  justSaved = null,
  panelRef,
  workspace,
}: {
  countStyle?: SavedSaleCountStyle;
  justSaved?: QueuedSaleView | null;
  panelRef?: RefObject<HTMLElement | null> | undefined;
  workspace: LocalWorkspace | null;
}) {
  const sales = usePendingSales(workspace);
  const focusTarget = useCallback(
    (node: HTMLDivElement | null) => {
      if (panelRef) {
        panelRef.current = node;
      }
    },
    [panelRef]
  );
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
    <Block
      aria-labelledby="sale-saved-title"
      className="focus-ring"
      ref={focusTarget}
      tabIndex={-1}
    >
      <BlockHeader
        id="sale-saved-title"
        title="Vendas guardadas neste aparelho"
      />
      <BlockPanel className="items-start">
        <ul className="grid w-full gap-2">
          {lines.map((line) => (
            <SavedSaleRow
              countStyle={countStyle}
              key={line.commandId}
              line={line}
            />
          ))}
        </ul>
        <p className="text-muted-foreground text-support">
          Só viram vendas confirmadas quando o servidor aceitar, assim que
          houver conexão.
        </p>
        <TextLink href="/attention">Acompanhar em Pendências</TextLink>
      </BlockPanel>
    </Block>
  );
}
