import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Card } from "@/ui/card";
import { formatQuantity } from "../lib/format";
import type { StoredPeriodSummary } from "../lib/period-summary-cache";
import {
  formatMoneyOrDash,
  formatPercentOrDash,
  isIncompleteEstimate,
} from "./dashboard-model";

interface ResultCardProps {
  badge?: ReactNode;
  className?: string | undefined;
  hint?: string | undefined;
  label: string;
  negative?: boolean | undefined;
  value: string;
}

/** A figure: its name in 12 px, the value large (26/30, 24/28 with touch) and, when there is one, a line of support. */
function ResultCard({
  badge,
  className,
  hint,
  label,
  negative,
  value,
}: ResultCardProps) {
  return (
    <Card
      className={cn("content-start gap-1.5 px-(--card-spacing)", className)}
    >
      <dt className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          {label}
        </span>
        {badge}
      </dt>
      <dd
        className={cn(
          "whitespace-nowrap font-semibold text-value-lg tabular-nums tracking-[-0.035em]",
          negative && "text-destructive"
        )}
      >
        {value}
      </dd>
      {hint ? (
        <dd className="text-muted-foreground text-support">{hint}</dd>
      ) : null}
    </Card>
  );
}

export function IncompleteBadge() {
  // two columns at 320 px leave less room than the words: the badge breaks its line inside its own box
  return (
    <Badge
      className="h-auto min-h-5 max-w-full whitespace-normal py-0.5 text-left leading-4"
      variant="warning"
    >
      estimativa incompleta
    </Badge>
  );
}

/** The six figures of the period; a figure that does not exist shows a dash. A loss keeps its minus sign. */
export function ResultCards({ summary }: { summary: StoredPeriodSummary }) {
  const { cards, quality } = summary;
  const incomplete = isIncompleteEstimate(quality);
  const negative = cards.operatingResult.trim().startsWith("-");
  // one column under 360 px: the value does not break, and two columns of a 320 px phone are too narrow for "R$ 4.958,50"
  return (
    <dl className="grid grid-cols-1 gap-3 md:grid-cols-3 min-[360px]:grid-cols-2">
      <ResultCard
        label="Vendas líquidas"
        value={formatMoneyOrDash(cards.netSales)}
      />
      <ResultCard
        badge={incomplete ? <IncompleteBadge /> : null}
        className="md:col-span-1 min-[360px]:col-span-2"
        hint="Não é lucro líquido nem dinheiro já recebido."
        label="Resultado estimado"
        negative={negative}
        value={formatMoneyOrDash(cards.operatingResult)}
      />
      <ResultCard
        badge={incomplete ? <IncompleteBadge /> : null}
        hint="Contribuição sobre as vendas líquidas."
        label="Margem"
        value={formatPercentOrDash(cards.marginPercent)}
      />
      <ResultCard label="Vendas" value={formatQuantity(cards.salesCount)} />
      <ResultCard
        label="Ticket médio"
        value={formatMoneyOrDash(cards.ticket)}
      />
      <ResultCard label="Itens vendidos" value={formatQuantity(cards.items)} />
    </dl>
  );
}
