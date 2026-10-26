import ChevronRightIcon from "lucide-react/dist/esm/icons/chevron-right";
import PackageIcon from "lucide-react/dist/esm/icons/package";
import SmartphoneIcon from "lucide-react/dist/esm/icons/smartphone";
import TagIcon from "lucide-react/dist/esm/icons/tag";
import { cn } from "@/lib/utils";
import {
  type AttentionLine,
  attentionLines,
  type BalancesPage,
} from "./home-model";
import { HomeBlock } from "./home-parts";
import type { Block } from "./use-home";

/** The icon of a line, in a square: the warning tone for what blocks a figure or a sale, neutral for the stock. */
const LINE_ICON: Record<
  AttentionLine["id"],
  { icon: typeof TagIcon; tone: "neutral" | "warning" }
> = {
  device: { icon: SmartphoneIcon, tone: "warning" },
  "unknown-cost": { icon: TagIcon, tone: "warning" },
  "without-stock": { icon: PackageIcon, tone: "neutral" },
};

function LineIcon({ id }: { id: AttentionLine["id"] }) {
  const { icon: Icon, tone } = LINE_ICON[id];
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-9 shrink-0 place-items-center rounded-md",
        tone === "warning"
          ? "bg-[color-mix(in_oklab,var(--warning)_14%,var(--card))] text-warning"
          : "bg-muted text-foreground"
      )}
      data-attention-tone={tone}
    >
      <Icon className="size-[1.125rem]" />
    </span>
  );
}

/**
 * "Precisa de atenção" (AC-12 to AC-15): at most three lines by priority, each a link to where it is resolved, with its
 * icon in a square, what needs attention and the next step written under it (v7 § 3 item 8); the text wraps and the
 * arrow stays centered. The device line comes
 * from the local summary and shows without the stock's reads; the stock lines need the server, and when their read
 * fails they give way to one sentence (§ 5.2 (c)).
 */
export function AttentionBlock({
  offline = false,
  refused,
  soldWithoutCost,
  stock,
}: {
  /** No connection, for a role that reads the stock: its lines wait for the connection, said in one sentence. */
  offline?: boolean;
  refused: number;
  soldWithoutCost: number | null;
  stock: Block<{
    unknownCost: BalancesPage | null;
    withoutStock: BalancesPage;
  }>;
}) {
  const read = stock.status === "ready" ? stock.data : null;
  const lines = attentionLines({
    refused,
    soldWithoutCost,
    unknownCost: read?.unknownCost ?? null,
    withoutStock: read?.withoutStock ?? null,
  });
  const loading = stock.status === "loading";
  // without the stock's reads (a role that does not read it) nothing was checked: no "Nada precisa de atenção"
  if (lines.length === 0 && stock.status === "hidden" && !offline) {
    return null;
  }
  return (
    <HomeBlock id="home-attention" title="Precisa de atenção">
      {lines.length > 0 ? (
        <ul className="grid min-w-0">
          {lines.map((line) => (
            <li className="min-w-0 border-t first:border-t-0" key={line.id}>
              <a
                className="focus-ring flex min-h-[3.25rem] items-center gap-3 rounded-sm py-2 hover:bg-muted/60"
                href={line.href}
              >
                <LineIcon id={line.id} />
                <span
                  className="grid min-w-0 flex-1 gap-0.5"
                  data-attention-text=""
                >
                  <span className="font-medium">{line.text}</span>
                  <span className="text-muted-foreground text-xs">
                    {line.next}
                  </span>
                </span>
                <ChevronRightIcon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground"
                />
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {lines.length === 0 &&
      !loading &&
      stock.status !== "error" &&
      !offline ? (
        <p className="text-muted-foreground">Nada precisa de atenção agora.</p>
      ) : null}
      {loading ? (
        <p className="text-muted-foreground text-support" role="status">
          Conferindo o estoque…
        </p>
      ) : null}
      {offline ? (
        <p className="text-muted-foreground text-support">
          Avisos do estoque só com conexão.
        </p>
      ) : null}
      {stock.status === "error" ? (
        <p className="text-muted-foreground text-support">
          Avisos do estoque indisponíveis agora.
        </p>
      ) : null}
    </HomeBlock>
  );
}
