import ChevronRightIcon from "lucide-react/dist/esm/icons/chevron-right";
import { attentionLines, type BalancesPage } from "./home-model";
import { HomeBlock } from "./home-parts";
import type { Block } from "./use-home";

/**
 * "Precisa de atenção" (AC-12 to AC-15): at most three lines by priority, each a link whose text wraps (two lines at 360 px
 * and below, the arrow centered) to where it is resolved. The device line comes
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
                className="focus-ring flex min-h-12 items-center gap-2 rounded-sm py-1 hover:bg-muted/60"
                href={line.href}
              >
                <span className="min-w-0 flex-1">{line.text}</span>
                <ChevronRightIcon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground"
                />
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {lines.length === 0 && !loading && stock.status !== "error" && !offline ? (
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
