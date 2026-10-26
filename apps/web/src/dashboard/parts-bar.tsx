import { MoneyText } from "@/ui/hidden-values";
import { Money } from "@polaris/domain/money/money";
import { formatBrlAmount } from "../lib/format";
import {
  EMPTY_VALUE,
  type PeriodChain,
  type PeriodQuality,
} from "./dashboard-model";
import { type CostPart, type CostPartId, costParts } from "./result-series";

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

/** The warning beside a part: no cost of the goods known at all, or an unknown input left out of it. */
function partMark(part: CostPart): string | null {
  if (part.value === null) {
    return "sem custo conhecido";
  }
  return part.incomplete ? "incompleto" : null;
}

/**
 * "Para onde vão os custos" (AC-12): the cost of goods, the fees and the expenses of the period as a bar and, under it,
 * the name and the value of each part in text. The parts add up to the cost of the period; a part with an unknown input
 * says "incompleto" and the bar never pretends to be whole. With no cost of the goods known there is no total to
 * divide: neither the bar nor its track is drawn, the goods read "—" and "sem custo conhecido", and a line says why.
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
      {total === null ? null : (
        <div
          aria-hidden="true"
          className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
          data-parts-bar=""
        >
          {parts.map((part) => (
            <div
              className={PART_COLORS[part.id]}
              key={part.id}
              style={{ width: `${share(part.value ?? "0", total)}%` }}
            />
          ))}
        </div>
      )}
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {parts.map((part) => (
          <li className="flex items-center gap-1.5" key={part.id}>
            <span
              aria-hidden="true"
              className={`size-2 shrink-0 rounded-full ${PART_COLORS[part.id]}`}
            />
            <span>{part.label}</span>
            <span className="font-medium tabular-nums">
              {part.value === null ? (
                <>
                  <span aria-hidden="true">{EMPTY_VALUE}</span>
                  <span className="sr-only">sem valor</span>
                </>
              ) : (
                <MoneyText text={formatBrlAmount(part.value)} />
              )}
            </span>
            {partMark(part) ? (
              <span className="text-warning text-xs italic">
                {partMark(part)}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {total === null ? (
        <p className="text-muted-foreground text-support">
          Sem o custo das mercadorias, a divisão dos custos não aparece.
        </p>
      ) : null}
    </div>
  );
}
