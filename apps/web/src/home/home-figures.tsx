import type { PeriodSummaryReadModel } from "@polaris/contracts";
import { Money } from "@polaris/domain/money/money";
import CheckIcon from "lucide-react/dist/esm/icons/check";
import { useEffect, useMemo } from "react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/ui/button";
import { MoneyText } from "@/ui/hidden-values";
import {
  currentFirstStep,
  FIRST_STEPS_ANCHOR,
  firstStepsDone,
} from "../app-shell/first-steps";
import {
  ProductThumbnail,
  useThumbnailSequence,
} from "../catalog/product-thumbnail";
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

const ALL_RETURNED_TEXT = "As vendas do período foram devolvidas.";

/** From this many lines the list takes the height the card is given, a line each; fewer stay at the top. */
const SPREAD_FROM = 3;

/**
 * The five most sold products of the month, by units net of returns; none sold, or every sale of the period returned, the same box says so (AC-16). Each line has the
 * miniature of the product (its two initials when it has no photo or while it comes, in a box of the same size, so
 * nothing moves when the photo arrives) with the position in a small circle over its corner, the name, the net sales
 * and the units, and a green bar proportional to the net sales (v7 § 3 item 11), drawn in CSS: it says the same as
 * the value beside it. Each line is its own container: from 20.75 rem the five are one row, and the name is cut with
 * an ellipsis when it does not fit; under that (a phone, a narrow column, the browser font enlarged) the name takes its
 * own line, up to two, the miniature sits beside both lines, and the net sales and the units go to the line under
 * the name.
 */
export function TopProductsBlock({
  products,
  salesCount,
  title = "Mais vendidos do mês",
}: {
  products: TopProducts;
  /** Sales of the period: with some and no product left in the ranking, every one of them was returned. */
  salesCount: number;
  title?: string;
}) {
  const top = products.reduce((max, product) => {
    const cents = Money.from(product.netSales).minorUnits;
    return cents > max ? cents : max;
  }, 0n);
  const covers = useMemo(
    () => products.map((product) => product.coverAssetId),
    [products]
  );
  useThumbnailSequence(covers);
  if (products.length === 0) {
    return (
      <HomeBlock id="home-top" title={title}>
        <p className="grid flex-1 place-items-center text-center text-muted-foreground">
          {salesCount > 0 ? ALL_RETURNED_TEXT : "Sem vendas no período."}
        </p>
      </HomeBlock>
    );
  }
  const spread = products.length >= SPREAD_FROM;
  return (
    <HomeBlock id="home-top" title={title}>
      <ol className="flex min-w-0 flex-1 flex-col">
        {products.map((product, index) => {
          const content = (
            <>
              <span
                data-top-line=""
                className="@min-[20.75rem]:flex grid min-w-0 grid-cols-[32px_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5"
              >
                <span className="relative row-span-2 shrink-0 self-center">
                  <ProductThumbnail
                    assetId={product.coverAssetId}
                    name={product.name}
                    size={32}
                  />
                  <span className="absolute -top-1.5 -left-1.5 grid size-[1.125rem] place-items-center rounded-full bg-background font-semibold text-xs tabular-nums ring-1 ring-border">
                    {index + 1}
                  </span>
                </span>
                <span
                  data-top-name=""
                  className="line-clamp-2 @min-[20.75rem]:line-clamp-none min-w-0 @min-[20.75rem]:flex-1 @min-[20.75rem]:truncate break-words"
                >
                  {product.name}
                </span>
                <span
                  data-top-figures=""
                  className="col-start-2 flex @min-[20.75rem]:contents flex-wrap items-baseline gap-x-3"
                >
                  <span className="shrink-0 font-semibold tabular-nums">
                    <MoneyText text={formatBrlAmount(product.netSales)} />
                  </span>
                  <span className="@min-[20.75rem]:ml-0 ml-auto @min-[20.75rem]:w-12 @min-[20.75rem]:shrink-0 text-right text-muted-foreground tabular-nums">
                    {`${formatQuantity(product.quantity)} un.`}
                  </span>
                </span>
              </span>
              <span
                aria-hidden="true"
                className="ml-[calc(32px+0.75rem)] block h-1.5 overflow-hidden rounded-full bg-muted"
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
              className={cn(
                "@container grid min-w-0 border-t first:border-t-0",
                spread && "flex-1"
              )}
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
  { href: "/products?novo=1", label: "Cadastrar à mão", variant: "default" },
  {
    href: "/products?importar=1",
    label: "Importar planilha",
    variant: "outline",
  },
] as const;

function FirstProductWays() {
  return (
    <span className="flex flex-wrap gap-x-2 gap-y-4">
      {FIRST_PRODUCT_WAYS.map((way) => (
        <a
          className={buttonVariants({ size: "sm", variant: way.variant })}
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
 * step has two small buttons (by hand, spreadsheet) and no button under the steps; after it, one button goes to the next step ("Dar entrada no estoque" on the
 * first product's panel while it has no stock).
 */
export function ChecklistBlock({ checklist }: { checklist: HomeChecklist }) {
  // the foot of the menu links here from any screen: the block comes after the reads, past the browser's own scroll
  useEffect(() => {
    if (window.location.hash === `#${FIRST_STEPS_ANCHOR}`) {
      document
        .getElementById(FIRST_STEPS_ANCHOR)
        ?.scrollIntoView({ block: "center" });
    }
  }, []);
  const next = checklistNext(checklist.firstProductId, checklist.hasStock);
  const link = checklistLink(next);
  const done = firstStepsDone(checklist);
  const current = currentFirstStep(done);
  return (
    <HomeBlock
      className="lg:col-span-2"
      id={FIRST_STEPS_ANCHOR}
      title="Primeiros passos"
    >
      <ol className="grid gap-2">
        {STEPS.map((step, index) => {
          const withWays = index === 1 && next.kind === "product";
          // with the two buttons the step is taller: number and name sit on the height of the first line of buttons
          const line = withWays ? "h-ctl-sm" : "";
          return (
            <li
              aria-current={index === current ? "step" : undefined}
              className={cn(
                "flex gap-2.5",
                withWays ? "items-start" : "items-center"
              )}
              key={step}
            >
              <span className={cn("flex items-center", line)}>
                <span
                  aria-hidden="true"
                  className={cn(
                    "grid size-5 shrink-0 place-items-center rounded-full border text-xs tabular-nums",
                    done[index] &&
                      "border-primary bg-primary text-primary-foreground",
                    index === current &&
                      "border-mark bg-mark/10 text-mark-foreground dark:bg-mark/15"
                  )}
                >
                  {done[index] ? <CheckIcon className="size-3" /> : index + 1}
                </span>
              </span>
              <span
                className={cn(
                  "flex flex-wrap items-center gap-x-3 gap-y-2",
                  done[index] && "text-muted-foreground"
                )}
              >
                <span className={cn("flex items-center", line)}>
                  <span>
                    {step}
                    {done[index] ? (
                      <span className="sr-only"> (feito)</span>
                    ) : null}
                  </span>
                </span>
                {withWays ? <FirstProductWays /> : null}
              </span>
            </li>
          );
        })}
      </ol>
      {link ? (
        <a className={cn(buttonVariants(), "w-fit")} href={link.href}>
          {link.label}
        </a>
      ) : null}
    </HomeBlock>
  );
}
