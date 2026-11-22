import { cn } from "@/lib/utils";

/** One row of the lower blocks: the cards of a pair stand side by side from 960 px of content and stretch to one height. */
function LowerRow({
  children,
  className,
  pair,
}: {
  children: (readonly [string, React.ReactNode])[];
  className: string;
  pair: boolean;
}) {
  return (
    <div
      className={cn("group/row grid min-w-0 gap-4", className)}
      {...(pair ? { "data-pair": "" } : {})}
    >
      {children.map(([key, node]) => (
        <div className="grid min-w-0" key={key}>
          {node}
        </div>
      ))}
    </div>
  );
}

const present = (cells: (readonly [string, React.ReactNode])[]) =>
  cells.filter(([, node]) => node !== null && node !== undefined);

/**
 * The blocks under the KPI cards, in pairs by the width of the content area (the container, not the window: the side
 * menu opened or closed moves it by about 230 px). The DOM is the reading order on every width: Vendas por dia, Mais
 * vendidos, Meta, Ritmo de vendas. From 960 px a row is a pair of one height: the chart (3/5) and the ranking (2/5);
 * then the goal with the rest and the map with the 30 rem it needs; a store with no goal has there a card with the way to
 * set one, as tall as the map. Below 960 px every block takes a row (the goal with none is a thin strip).
 */
export function LowerBlocks({
  chart,
  goal,
  ranking,
  rhythm,
}: {
  chart: React.ReactNode;
  goal: React.ReactNode;
  ranking: React.ReactNode;
  rhythm: React.ReactNode;
}) {
  const upper = present([
    ["chart", chart],
    ["ranking", ranking],
  ]);
  const lower = present([
    ["goal", goal],
    ["rhythm", rhythm],
  ]);
  return (
    <div className="@container/home min-w-0" data-home-lower="">
      <div className="grid min-w-0 gap-4">
        {upper.length > 0 ? (
          <LowerRow
            className={
              upper.length === 2
                ? "@min-[60rem]/home:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]"
                : ""
            }
            pair={upper.length === 2}
          >
            {upper}
          </LowerRow>
        ) : null}
        {lower.length > 0 ? (
          <LowerRow
            className={
              lower.length === 2
                ? "@min-[60rem]/home:grid-cols-[minmax(0,1fr)_30rem]"
                : ""
            }
            pair={lower.length === 2}
          >
            {lower}
          </LowerRow>
        ) : null}
      </div>
    </div>
  );
}
