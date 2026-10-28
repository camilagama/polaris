import type { PeriodSummaryReadModel } from "@polaris/contracts";
import CheckIcon from "lucide-react/dist/esm/icons/check";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/ui/button";
import { Money } from "@polaris/domain/money/money";
import { MoneyText } from "@/ui/hidden-values";
import { formatBrlAmount, formatQuantity } from "../lib/format";
import { checklistLink, checklistNext } from "./home-model";
import { HomeBlock } from "./home-parts";
import type { HomeChecklist } from "./use-home";

/**
 * Mais vendidos and the checklist of a store with no sale (AC-16, AC-22). The KPI cards are in home-kpi-cards.tsx.
 */

type TopProducts = NonNullable<PeriodSummaryReadModel["topProducts"]>;

/** The width of a product's bar: its net sales over the first one's, in whole percents (CSS only, v7 § 3 item 11). */
function barWidth(netSales: string, top: bigint): number {
  const cents = Money.from(netSales).minorUnits;
  if (top <= 0n || cents <= 0n) {
    return 0;
  }
  return Number((cents * 100n) / top);
}

/**
 * The three most sold products of the month, by units net of returns; none sold, no block (AC-16). Each line has its
 * position in a circle, the name (cut with an ellipsis only when it does not fit), the net sales and the units, and a green bar proportional to the net sales
 * (v7 § 3 item 11), drawn in CSS: it says the same as the value beside it.
 */
export function TopProductsBlock({ products }: { products: TopProducts }) {
  const top = products.reduce((max, product) => {
    const cents = Money.from(product.netSales).minorUnits;
    return cents > max ? cents : max;
  }, 0n);
  return (
    <HomeBlock id="home-top" title="Mais vendidos do mês">
      <ol className="grid min-w-0">
        {products.map((product, index) => {
          const content = (
            <>
              <span className="flex min-w-0 items-center gap-3">
                <span className="grid size-[1.375rem] shrink-0 place-items-center rounded-full bg-muted font-semibold text-xs tabular-nums">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate">{product.name}</span>
                <span className="shrink-0 font-semibold tabular-nums">
                  <MoneyText text={formatBrlAmount(product.netSales)} />
                </span>
                <span className="w-12 shrink-0 text-right text-muted-foreground tabular-nums">
                  {`${formatQuantity(product.quantity)} un.`}
                </span>
              </span>
              <span
                aria-hidden="true"
                className="ml-[2.125rem] block h-1.5 overflow-hidden rounded-full bg-muted"
              >
                <span
                  className="block h-full rounded-full bg-chart-sales"
                  data-top-bar=""
                  style={{ width: `${barWidth(product.netSales, top)}%` }}
                />
              </span>
            </>
          );
          const row = "grid min-h-12 content-center gap-1.5 py-2";
          return (
            <li
              className="min-w-0 border-t first:border-t-0"
              key={product.productId}
            >
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

/** The two ways of the step "Cadastrar o 1º produto" while it is not done (corte 2.5, T-5): by hand or a spreadsheet. */
const FIRST_PRODUCT_WAYS = [
  { href: "/products?novo=1", label: "À mão" },
  { href: "/products?importar=1", label: "Importar planilha" },
] as const;

function FirstProductWays() {
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1">
      {FIRST_PRODUCT_WAYS.map((way) => (
        <a
          className={buttonVariants({ size: "sm", variant: "link" })}
          href={way.href}
          key={way.href}
        >
          {way.label}
        </a>
      ))}
    </span>
  );
}

/**
 * The store that never sold (AC-22, § 5.4): three steps from its real data. While the first product is missing its
 * step has two ways and no button; after it, one button goes to the next step ("Dar entrada no estoque" on the
 * first product's panel while it has no stock).
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
            <span
              className={cn(
                "flex flex-wrap items-center gap-x-3",
                done[index] && "text-muted-foreground"
              )}
            >
              <span>
                {step}
                {done[index] ? <span className="sr-only"> (feito)</span> : null}
              </span>
              {index === 1 && next.kind === "product" ? (
                <FirstProductWays />
              ) : null}
            </span>
          </li>
        ))}
      </ol>
      {link ? (
        <a className={cn(buttonVariants(), "w-fit")} href={link.href}>
          {link.label}
        </a>
      ) : null}
    </HomeBlock>
  );
}
