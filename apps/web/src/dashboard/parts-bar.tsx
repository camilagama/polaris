import { MoneyText } from "@/ui/hidden-values";
import { Money } from "@polaris/domain/money/money";
import { formatBrlAmount } from "../lib/format";
import type { PeriodChain, PeriodQuality } from "./dashboard-model";
import { type CostPartId, costParts } from "./result-series";

/** The color of each part is a token of the chart palette: the cost of goods in ink, the fees in the mid grey, the expenses third. */
const PART_COLORS: Readonly<Record<CostPartId, string>> = {
  expenses: "bg-(--chart-2)",
  fees: "bg-(--chart-3)",
  goods: "bg-(--chart-5)",
};

/** The width of a part in the bar: its share of the cost. Only for the drawing; the value is written beside it. */
function share(value: string, total: string): number {
  const whole = Number(Money.from(total).minorUnits);
  return whole > 0 ? (Number(Money.from(value).minorUnits) / whole) * 100 : 0;
}

/**
 * "Para onde vão os custos" (AC-12): the cost of goods, the fees and the expenses of the period as a bar and, under it,
 * the name and the value of each part in text. The parts add up to the cost of the period; a part with an unknown input
 * says "incompleto" and the bar never pretends to be whole.
 */
export function PartsBar({
  chain,
  quality,
}: {
  chain: PeriodChain;
  quality: PeriodQuality;
}) {
  const { parts, total } = costParts(chain, quality);
  return (
    <div className="grid gap-2">
      <p className="font-medium text-sm">Para onde vão os custos</p>
      {/* the legend below says every figure: the bar is a reinforcement */}
      <div
        aria-hidden="true"
        className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
        data-parts-bar=""
      >
        {parts.map((part) => (
          <div
            className={PART_COLORS[part.id]}
            key={part.id}
            style={{ width: `${share(part.value, total)}%` }}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {parts.map((part) => (
          <li className="flex items-center gap-1.5" key={part.id}>
            <span
              aria-hidden="true"
              className={`size-2 shrink-0 rounded-full ${PART_COLORS[part.id]}`}
            />
            <span>{part.label}</span>
            <span className="font-medium tabular-nums">
              <MoneyText text={formatBrlAmount(part.value)} />
            </span>
            {part.incomplete ? (
              <span className="text-warning text-xs italic">incompleto</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
