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
 * menu opened or closed moves it by about 230 px). The DOM is the reading order on every width: Meta, Vendas por dia,
 * Ritmo de vendas, Mais vendidos. From 960 px a row is a pair of one height: Meta (1/3) and the chart (2/3); then the map
 * with the 30 rem it needs and the ranking with the rest. A store with no goal has a thin strip in the place of the card,
 * and the chart takes the row under it. Below 960 px every block takes a row.
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
    ["goal", goal],
    ["chart", chart],
  ]);
  const lower = present([
    ["rhythm", rhythm],
    ["ranking", ranking],
  ]);
  return (
    <div className="@container/home min-w-0" data-home-lower="">
      <div className="grid min-w-0 gap-4">
        {upper.length > 0 ? (
          <LowerRow
            className={
              upper.length === 2
                ? "@min-[60rem]/home:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] @min-[60rem]/home:has-data-[goal-strip]:grid-cols-1"
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
                ? "@min-[60rem]/home:grid-cols-[30rem_minmax(0,1fr)]"
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
