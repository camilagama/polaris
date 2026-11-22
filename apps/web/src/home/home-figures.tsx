import type { PeriodSummaryReadModel } from "@polaris/contracts";
import { Money } from "@polaris/domain/money/money";
import CheckIcon from "lucide-react/dist/esm/icons/check";
import ShoppingBagIcon from "lucide-react/dist/esm/icons/shopping-bag";
import StoreIcon from "lucide-react/dist/esm/icons/store";
import TagIcon from "lucide-react/dist/esm/icons/tag";
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { COLLAPSIBLE_QUERY } from "@/lib/breakpoints";
import { cn } from "@/lib/utils";
import { useMediaQuery } from "@/lib/use-mobile";
import { buttonVariants } from "@/ui/button";
import { MoneyText } from "@/ui/hidden-values";
import { ProgressRing } from "@/ui/progress-ring";
import { SkeletonArt, type SkeletonArtKind } from "@/ui/skeleton-art";
import {
  currentFirstStep,
  FIRST_STEPS_ANCHOR,
  FIRST_STEPS_TOTAL,
  firstStepsDone,
} from "../app-shell/first-steps";
import {
  ProductThumbnail,
  useThumbnailSequence,
} from "../catalog/product-thumbnail";
import { formatBrlAmount, formatQuantity } from "../lib/format";
import { type ChecklistNext, checklistLink, checklistNext } from "./home-model";
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

const RANKING_FOOTER = {
  capability: "catalog:read",
  href: "/products",
  label: "Ver os produtos",
} as const;

const unitsText = (quantity: number) => `${formatQuantity(quantity)} un.`;

const ALL_RETURNED_TEXT = "As vendas do período foram devolvidas.";

/** From this many lines the list takes the height the card is given, a line each; fewer stay at the top. */
const SPREAD_FROM = 3;

/** The widest of the formatted texts, in characters: with tabular figures a character is at most one `ch`, so it bounds the column. */
function widestCh(texts: readonly string[]): number {
  return texts.reduce((widest, text) => Math.max(widest, text.length), 0);
}

/**
 * The five most sold products of the month, by units net of returns; none sold, or every sale of the period returned, the same box says so (AC-16). Each line is
 * a grid of columns that are the same in every line: the position (a figure, right-aligned), the miniature of the
 * product (its two initials when it has no photo or while it comes, in a box of the same size, so nothing moves when
 * the photo arrives), the name, the net sales and the units (both right-aligned, in the width of the widest of the
 * five lines, so every line ends at the same x), and under them a green bar proportional to the net sales (v7 § 3
 * item 11), drawn in CSS, from the name column to the units column: it says the same as the value beside it. Each
 * line is its own container: from 20.75 rem the five columns are one row and the name is cut with an ellipsis when
 * it does not fit; under that (a phone, a narrow column, the browser font enlarged) the name takes the width of the
 * name and units columns, up to two lines, the miniature sits beside both rows, and the net sales and the units
 * go to the row under the name.
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
      <HomeBlock footer={RANKING_FOOTER} id="home-top" title={title}>
        <p className="grid flex-1 place-items-center text-center text-muted-foreground">
          {salesCount > 0 ? ALL_RETURNED_TEXT : "Sem vendas no período."}
        </p>
      </HomeBlock>
    );
  }
  const spread = products.length >= SPREAD_FROM;
  const columns = {
    "--top-units": `${widestCh(products.map((product) => unitsText(product.quantity)))}ch`,
    "--top-value": `${widestCh(products.map((product) => formatBrlAmount(product.netSales)))}ch`,
  } as CSSProperties;
  return (
    <HomeBlock footer={RANKING_FOOTER} id="home-top" title={title}>
      <ol className="flex min-w-0 flex-1 flex-col" style={columns}>
        {products.map((product, index) => {
          const content = (
            <>
              <span
                className="col-start-1 row-start-1 justify-self-end text-muted-foreground tabular-nums"
                data-top-rank=""
              >
                {index + 1}
              </span>
              <span
                className="col-start-2 @min-[20.75rem]:row-span-1 row-span-2 row-start-1 grid self-center"
                data-top-thumb=""
              >
                <ProductThumbnail
                  assetId={product.coverAssetId}
                  name={product.name}
                  size={32}
                />
              </span>
              <span
                className="col-start-3 @min-[20.75rem]:col-end-4 col-end-5 row-start-1 line-clamp-2 @min-[20.75rem]:line-clamp-none min-w-0 @min-[20.75rem]:truncate break-words"
                data-top-name=""
                title={product.name}
              >
                {product.name}
              </span>
              <span
                className="@min-[20.75rem]:col-start-4 col-start-3 @min-[20.75rem]:row-start-1 row-start-2 justify-self-start @min-[20.75rem]:justify-self-end font-semibold tabular-nums"
                data-top-value=""
              >
                <MoneyText text={formatBrlAmount(product.netSales)} />
              </span>
              <span
                className="@min-[20.75rem]:col-start-5 col-start-4 @min-[20.75rem]:row-start-1 row-start-2 justify-self-end text-muted-foreground tabular-nums"
                data-top-units=""
              >
                {unitsText(product.quantity)}
              </span>
              <span
                aria-hidden="true"
                className="col-start-3 @min-[20.75rem]:col-end-6 col-end-5 @min-[20.75rem]:row-start-2 row-start-3 block h-1.5 overflow-hidden rounded-full bg-muted"
                data-top-track=""
              >
                <span
                  className="block h-full rounded-full bg-chart-sales"
                  data-top-bar=""
                  style={{ width: `${barWidth(product.netSales, top)}%` }}
                />
              </span>
            </>
          );
          const row =
            "grid min-h-12 grid-cols-[1.25rem_auto_minmax(0,1fr)_auto] @min-[20.75rem]:grid-cols-[1.25rem_auto_minmax(0,1fr)_var(--top-value)_var(--top-units)] content-center items-center gap-x-2 gap-y-1 py-2";
          return (
            <li
              className={cn(
                "@container grid min-w-0 border-t first:border-t-0",
                spread && "flex-1"
              )}
              data-top-line=""
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

/** The icon of each step: the store has no destination in the menu; Produtos and Vender keep the icon they have there. */
const STEP_ICONS = [StoreIcon, TagIcon, ShoppingBagIcon] as const;

/** The box of a step's icon: the same 28 px in the three states, so the state moves nothing. */
const STEP_BOX = "grid size-7 shrink-0 place-items-center rounded-md border";

const STEP_BOX_STATE = {
  current: "border-mark bg-mark/10 text-mark-foreground dark:bg-mark/15",
  done: "border-transparent bg-primary/10 text-primary",
  todo: "text-muted-foreground",
} as const;

function stepState(isDone: boolean, isCurrent: boolean) {
  if (isDone) {
    return "done";
  }
  return isCurrent ? "current" : "todo";
}

/** The count beside the title: the ring and "N de 3", the figure always written. */
function StepsCount({ done }: { done: number }) {
  return (
    <span className="flex items-center gap-1.5 text-muted-foreground tabular-nums">
      <ProgressRing done={done} total={FIRST_STEPS_TOTAL} />
      {done} de {FIRST_STEPS_TOTAL}
    </span>
  );
}

type NextKind = ChecklistNext["kind"];

export const NEXT_STEP_SUPPORT: Record<NextKind, string> = {
  product: "Nome, preço e quantas unidades você tem. Só o nome é obrigatório.",
  sale: "Escolha o produto, o pagamento e confirme.",
  stock: "Diga quantas unidades você tem para poder vender.",
};

export const NEXT_STEP_ART: Record<NextKind, SkeletonArtKind> = {
  product: "products",
  sale: "sale",
  stock: "products",
};

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

function StepPreview({
  children,
  kind,
}: {
  children: ReactNode;
  kind: NextKind;
}) {
  const opened = useRef(kind);
  const changed = useRef<boolean>(false);
  if (kind !== opened.current) {
    changed.current = true;
  }
  const animate = changed.current;
  return (
    <div className="grid content-start gap-3" data-step-preview={kind}>
      <div
        className={cn(
          "grid gap-3",
          animate &&
            "motion-full:fade-in-0 motion-full:animate-in motion-full:duration-150"
        )}
        key={kind}
      >
        <SkeletonArt kind={NEXT_STEP_ART[kind]} />
        <p className="min-h-[2lh]" data-step-support="">
          {NEXT_STEP_SUPPORT[kind]}
        </p>
      </div>
      <div className="flex min-h-ctl-md flex-wrap items-center gap-x-2 gap-y-4">
        {children}
      </div>
    </div>
  );
}

function StepRow({
  done,
  index,
  isCurrent,
  support,
  withWays,
}: {
  done: boolean;
  index: number;
  isCurrent: boolean;
  support: string | null;
  withWays: boolean;
}) {
  const tall = withWays || support !== null;
  const line = tall ? "h-ctl-sm" : "";
  const state = stepState(done, isCurrent);
  const Icon = STEP_ICONS[index] ?? StoreIcon;
  return (
    <li
      aria-current={isCurrent ? "step" : undefined}
      className={cn(
        "flex gap-2.5 rounded-md px-2 py-1",
        tall ? "items-start" : "items-center",
        state === "done" && "bg-muted/50"
      )}
    >
      <span className={cn("flex items-center", line)}>
        <span
          aria-hidden="true"
          className={cn(STEP_BOX, STEP_BOX_STATE[state])}
          data-step-box={state}
        >
          {state === "done" ? (
            <CheckIcon className="size-4" />
          ) : (
            <Icon className="size-4" />
          )}
        </span>
      </span>
      <span
        className={cn(
          "flex flex-wrap items-center gap-x-3 gap-y-2",
          done && "text-muted-foreground"
        )}
      >
        <span className={cn("flex items-center", line)}>
          <span>
            {STEPS[index]}
            {done ? <span className="sr-only"> (feito)</span> : null}
          </span>
        </span>
        {support ? (
          <span
            className="basis-full text-muted-foreground"
            data-step-support=""
          >
            {support}
          </span>
        ) : null}
        {withWays ? <FirstProductWays /> : null}
      </span>
    </li>
  );
}

export function ChecklistBlock({ checklist }: { checklist: HomeChecklist }) {
  // the foot of the menu links here from any screen: the block comes after the reads, past the browser's own scroll
  useEffect(() => {
    if (window.location.hash === `#${FIRST_STEPS_ANCHOR}`) {
      document
        .getElementById(FIRST_STEPS_ANCHOR)
        ?.scrollIntoView({ block: "center" });
    }
  }, []);
  const wide = useMediaQuery(COLLAPSIBLE_QUERY);
  const next = checklistNext(checklist.firstProductId, checklist.hasStock);
  const link = checklistLink(next);
  const done = firstStepsDone(checklist);
  const current = currentFirstStep(done);
  const button = link ? (
    <a className={cn(buttonVariants(), "w-fit")} href={link.href}>
      {link.label}
    </a>
  ) : (
    <FirstProductWays />
  );
  return (
    <HomeBlock
      action={<StepsCount done={done.filter(Boolean).length} />}
      className="lg:col-span-2"
      id={FIRST_STEPS_ANCHOR}
      title="Primeiros passos"
    >
      <div className="grid gap-(--card-spacing) lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
        <ol className="grid gap-1">
          {STEPS.map((step, index) => (
            <StepRow
              done={done[index] === true}
              index={index}
              isCurrent={index === current}
              key={step}
              support={
                !wide && index === current ? NEXT_STEP_SUPPORT[next.kind] : null
              }
              withWays={!wide && index === 1 && next.kind === "product"}
            />
          ))}
        </ol>
        {wide ? (
          <StepPreview kind={next.kind}>{button}</StepPreview>
        ) : (
          link && button
        )}
      </div>
    </HomeBlock>
  );
}
