import type { PeriodSummaryReadModel } from "@polaris/contracts";
import CheckIcon from "lucide-react/dist/esm/icons/check";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/ui/button";
import { OnDemandSparkline } from "@/ui/charts/on-demand";
import { isIncompleteEstimate } from "../dashboard/dashboard-model";
import { IncompleteBadge } from "../dashboard/result-cards";
import { formatBrlAmount, formatQuantity } from "../lib/format";
import {
  chartValue,
  checklistLink,
  checklistNext,
  lastDays,
  monthComparison,
  monthTitle,
  monthUntilToday,
  salesCountText,
  todayFigures,
} from "./home-model";
import { HomeBlock } from "./home-parts";
import type { HomeChecklist, HomeFigures } from "./use-home";

/**
 * Hoje, Mês, Mais vendidos and the checklist of a store with no sale (AC-5 to AC-9, AC-16, AC-22). Every value is
 * written; a miniature is only a reinforcement beside it, `aria-hidden` and with no axis (AC-8).
 */

const VALUE = "font-semibold text-value-lg tabular-nums tracking-[-0.035em]";
const LABEL =
  "font-medium text-muted-foreground text-xs uppercase tracking-wide";
const MAKE_A_SALE = cn(buttonVariants({ variant: "outline" }), "w-fit");

function Miniature({ values }: { values: readonly number[] }) {
  // the miniature is aria-hidden by itself; the box keeps its height while the charts chunk loads
  return (
    <div aria-hidden="true" className="h-8">
      <OnDemandSparkline values={values} />
    </div>
  );
}

export function TodayBlock({ figures }: { figures: HomeFigures }) {
  const today = todayFigures(figures.month.daily ?? [], figures.today);
  const week = lastDays(
    figures.before.daily ?? [],
    figures.month.daily ?? [],
    figures.today,
    7
  );
  const sold = today.salesCount > 0;
  return (
    <HomeBlock id="home-today" title="Hoje">
      {sold ? (
        <>
          <p className="grid gap-0.5">
            <span className={VALUE}>{formatBrlAmount(today.netSales)}</span>
            <span className="text-muted-foreground text-support">
              {`Vendas líquidas · ${salesCountText(today.salesCount)}`}
            </span>
          </p>
          <Miniature values={week.map((day) => chartValue(day.netSales))} />
        </>
      ) : (
        <p className="text-muted-foreground">Nenhuma venda hoje ainda</p>
      )}
    </HomeBlock>
  );
}

export function MonthBlock({ figures }: { figures: HomeFigures }) {
  const { before, month, today } = figures;
  const { cards, quality } = month;
  const comparison = monthComparison(
    before.daily ?? [],
    month.daily ?? [],
    today
  );
  const negative = cards.operatingResult.trim().startsWith("-");
  return (
    <HomeBlock
      action={
        <a
          className="touch-hit focus-ring rounded-sm text-sm underline decoration-input underline-offset-4 hover:decoration-foreground"
          href="/dashboard"
        >
          Ver o resultado
        </a>
      }
      id="home-month"
      title={monthTitle(today)}
    >
      {cards.salesCount === 0 ? (
        <div className="grid gap-3">
          <p className="text-muted-foreground">Nenhuma venda este mês ainda</p>
          <a className={MAKE_A_SALE} href="/sales">
            Fazer uma venda
          </a>
        </div>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3">
            <div className="grid content-start gap-1">
              <dt className={LABEL}>Vendas líquidas</dt>
              <dd className={VALUE}>{formatBrlAmount(cards.netSales)}</dd>
            </div>
            <div className="grid content-start gap-1">
              <dt className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className={LABEL}>Resultado estimado</span>
                {isIncompleteEstimate(quality) ? <IncompleteBadge /> : null}
              </dt>
              <dd className={cn(VALUE, negative && "text-destructive")}>
                {formatBrlAmount(cards.operatingResult)}
              </dd>
            </div>
          </dl>
          <p className="text-muted-foreground text-support">
            Não é lucro líquido nem dinheiro já recebido.
          </p>
          {comparison ? <p className="text-support">{comparison}</p> : null}
          <Miniature
            values={monthUntilToday(month.daily ?? [], today).map((day) =>
              chartValue(day.netSales)
            )}
          />
        </>
      )}
    </HomeBlock>
  );
}

type TopProducts = NonNullable<PeriodSummaryReadModel["topProducts"]>;

/** The three most sold products of the month, by units net of returns; none sold, no block (AC-16). */
export function TopProductsBlock({ products }: { products: TopProducts }) {
  return (
    <HomeBlock id="home-top" title="Mais vendidos do mês">
      <ol className="grid">
        {products.map((product, index) => {
          const content = (
            <>
              <span className="w-4 shrink-0 text-muted-foreground tabular-nums">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 truncate">{product.name}</span>
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {`${formatQuantity(product.quantity)} un.`}
              </span>
            </>
          );
          const row = "flex min-h-11 items-center gap-3 py-1";
          return (
            <li className="border-t first:border-t-0" key={product.productId}>
              {product.deleted ? (
                // a deleted product has no panel to open: the line has no link
                <span className={row}>{content}</span>
              ) : (
                <a
                  className={cn(row, "focus-ring rounded-sm hover:bg-muted/60")}
                  href={`/products?produto=${encodeURIComponent(product.productId)}`}
                >
                  {content}
                </a>
              )}
            </li>
          );
        })}
      </ol>
    </HomeBlock>
  );
}

const STEPS = ["Loja criada", "Cadastrar o 1º produto", "Fazer a 1ª venda"];

/**
 * The store that never sold (AC-22, § 5.4): three steps from its real data, with one button to the next one; when
 * the first product has no stock, the next step is "Dar entrada no estoque" on its panel.
 */
export function ChecklistBlock({ checklist }: { checklist: HomeChecklist }) {
  const next = checklistNext(checklist.firstProductId, checklist.hasStock);
  const link = checklistLink(next);
  const done = [true, checklist.firstProductId !== null, false];
  return (
    <HomeBlock
      className="lg:col-span-2"
      id="home-checklist"
      title="Primeiros passos"
    >
      <ol className="grid gap-2">
        {STEPS.map((step, index) => (
          <li className="flex items-center gap-2.5" key={step}>
            <span
              aria-hidden="true"
              className={cn(
                "grid size-5 shrink-0 place-items-center rounded-full border text-xs tabular-nums",
                done[index] &&
                  "border-primary bg-primary text-primary-foreground"
              )}
            >
              {done[index] ? <CheckIcon className="size-3" /> : index + 1}
            </span>
            <span className={done[index] ? "text-muted-foreground" : ""}>
              {step}
              {done[index] ? <span className="sr-only"> (feito)</span> : null}
            </span>
          </li>
        ))}
      </ol>
      <a className={cn(buttonVariants(), "w-fit")} href={link.href}>
        {link.label}
      </a>
    </HomeBlock>
  );
}
