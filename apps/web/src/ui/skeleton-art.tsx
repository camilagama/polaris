import type { ReactElement } from "react";
import { cn } from "@/lib/utils";

export type SkeletonArtKind = "home" | "products" | "sale";

const WIDTH = 160;
const HEIGHT = 120;

/** The page behind the drawing and the boxes on it: `--muted` and `--card` with a hairline of `--border`, so a shape reads by its outline. */
const PAGE = "fill-muted stroke-border";
const CARD = "fill-card stroke-border";
const SHAPE = "fill-muted stroke-border";
const RULE = "stroke-border";
const ENTITY = "stroke-chart-sales";

function Bar({
  h = 4,
  w,
  x,
  y,
}: {
  h?: number;
  w: number;
  x: number;
  y: number;
}) {
  return (
    <rect
      className={SHAPE}
      height={h}
      rx={Math.min(3, h / 2)}
      width={w}
      x={x}
      y={y}
    />
  );
}

function Frame({ children }: { children: ReactElement | ReactElement[] }) {
  return (
    <>
      <rect
        className={PAGE}
        height={HEIGHT - 1}
        rx="8"
        width={WIDTH - 1}
        x=".5"
        y=".5"
      />
      {children}
    </>
  );
}

const PRODUCT_ROWS = [
  { name: 50, y: 38 },
  { name: 40, y: 62 },
  { name: 56, y: 86 },
] as const;

function Products() {
  return (
    <Frame>
      <rect className={CARD} height="100" rx="6" width="140" x="10" y="10" />
      <Bar h={10} w={90} x={18} y={18} />
      <Bar h={10} w={28} x={114} y={18} />
      {PRODUCT_ROWS.map((row, index) => (
        <g key={row.y}>
          <rect
            className={SHAPE}
            height="16"
            rx="3"
            width="16"
            x="18"
            y={row.y}
          />
          <Bar w={row.name} x={42} y={row.y + 3} />
          <Bar h={3} w={28} x={42} y={row.y + 10} />
          {index === 0 ? (
            <line
              className={ENTITY}
              strokeLinecap="round"
              strokeWidth="3"
              x1="116"
              x2="142"
              y1={row.y + 8}
              y2={row.y + 8}
            />
          ) : (
            <Bar h={5} w={26} x={116} y={row.y + 5} />
          )}
          {index < PRODUCT_ROWS.length - 1 ? (
            <line
              className={RULE}
              x1="18"
              x2="142"
              y1={row.y + 20}
              y2={row.y + 20}
            />
          ) : null}
        </g>
      ))}
    </Frame>
  );
}

const SALE_ITEMS = [34, 46] as const;
const SALE_METHODS = [18, 60, 102] as const;

function Sale() {
  return (
    <Frame>
      <rect className={CARD} height="100" rx="6" width="140" x="10" y="10" />
      <Bar h={10} w={124} x={18} y={18} />
      {SALE_ITEMS.map((y) => (
        <g key={y}>
          <Bar w={60} x={18} y={y} />
          <Bar w={14} x={100} y={y} />
          <Bar w={20} x={122} y={y} />
        </g>
      ))}
      <line className={RULE} x1="18" x2="142" y1="58" y2="58" />
      {SALE_METHODS.map((x) => (
        <Bar h={10} key={x} w={40} x={x} y={64} />
      ))}
      <Bar w={24} x={18} y={83} />
      <line
        className={ENTITY}
        strokeLinecap="round"
        strokeWidth="3"
        x1="104"
        x2="142"
        y1="85"
        y2="85"
      />
      <Bar h={12} w={124} x={18} y={92} />
    </Frame>
  );
}

const HOME_CARDS = [10, 59, 108] as const;

function Home() {
  return (
    <Frame>
      {HOME_CARDS.map((x) => (
        <g key={x}>
          <rect className={CARD} height="34" rx="6" width="42" x={x} y="10" />
          <Bar h={3} w={22} x={x + 6} y={17} />
          <Bar h={7} w={28} x={x + 6} y={25} />
        </g>
      ))}
      <rect className={CARD} height="58" rx="6" width="140" x="10" y="52" />
      <line className={RULE} x1="18" x2="142" y1="102" y2="102" />
      <line className={RULE} x1="18" x2="142" y1="84" y2="84" />
      <polyline
        className={ENTITY}
        fill="none"
        points="18,98 36,88 54,92 72,78 90,82 108,68 126,72 142,62"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </Frame>
  );
}

const DRAWINGS = { home: Home, products: Products, sale: Sale } as const;

/**
 * A drawing of the screen a step leads to, in inline SVG at 4:3: `--muted`, `--card` and `--border` for the shapes and
 * one line in the color of the entity (the sales green). It is decoration (`aria-hidden`, out of the tab order) that
 * never moves and has no loading skeleton's class: the sentence beside it says what the screen is for. Without a
 * sentence next to it the drawing is not used.
 */
export function SkeletonArt({
  className,
  kind,
}: {
  className?: string;
  kind: SkeletonArtKind;
}) {
  const Drawing = DRAWINGS[kind];
  return (
    <svg
      aria-hidden="true"
      className={cn("block h-auto w-full", className)}
      data-skeleton-art={kind}
      fill="none"
      focusable="false"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
    >
      <Drawing />
    </svg>
  );
}
