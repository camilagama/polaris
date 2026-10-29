import ChevronRightIcon from "lucide-react/dist/esm/icons/chevron-right";
import PackageIcon from "lucide-react/dist/esm/icons/package";
import SmartphoneIcon from "lucide-react/dist/esm/icons/smartphone";
import TagIcon from "lucide-react/dist/esm/icons/tag";
import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
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
 * "Precisa de ação" (AC-12 to AC-15), just under "Nova venda" and only when there is something to do: at most three
 * lines by priority, each a link to where it is resolved, with its icon in a square and what needs doing, with its
 * number; the cost line alone keeps its second line ("Informe para as próximas vendas."), the screen of the others says
 * what to do. The device line comes from the local summary and shows without the stock's reads. With nothing to do the
 * block is not there; what the check of the stock says (reading, no connection, failed) is `AttentionNotes`, under
 * the KPI cards.
 */
export function AttentionBlock({
  refused,
  soldWithoutCost,
  stock,
}: {
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
  if (lines.length === 0) {
    return null;
  }
  return (
    <HomeBlock
      id="home-attention"
      title={
        <span className="inline-flex items-center gap-2">
          <TriangleAlertIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-warning"
          />
          Precisa de ação
        </span>
      }
    >
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
                {line.next ? (
                  <span className="text-muted-foreground text-xs">
                    {line.next}
                  </span>
                ) : null}
              </span>
              <ChevronRightIcon
                aria-hidden="true"
                className="size-4 shrink-0 text-muted-foreground"
              />
            </a>
          </li>
        ))}
      </ul>
    </HomeBlock>
  );
}

/**
 * What the check of the stock says when it has no lines to show: a discreet line under the KPI cards. Reading, no
 * connection for a role that reads the stock, or failed (§ 5.2 (c)); nothing when it answered (the lines, or nothing to do).
 */
export function AttentionNotes({
  offline = false,
  stock,
}: {
  /** No connection, for a role that reads the stock: its lines wait for the connection, said in one sentence. */
  offline?: boolean;
  stock: Block<unknown>;
}) {
  if (stock.status === "loading") {
    return (
      <p className="text-muted-foreground text-support" role="status">
        Conferindo o estoque…
      </p>
    );
  }
  if (offline) {
    return (
      <p className="text-muted-foreground text-support">
        Avisos do estoque só com conexão.
      </p>
    );
  }
  if (stock.status === "error") {
    return (
      <p className="text-muted-foreground text-support">
        Avisos do estoque indisponíveis agora.
      </p>
    );
  }
  return null;
}
