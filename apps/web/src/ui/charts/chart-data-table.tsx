import { cn } from "@/lib/utils";
import { MoneyText } from "../hidden-values";

interface ChartDataColumn {
  header: string;
  /** Right-aligned, for amounts and counts. */
  numeric?: boolean;
}

interface ChartDataRow {
  /** One text per column, in the order of `columns`. */
  cells: readonly string[];
  key: string;
}

export interface ChartDataTableProps {
  /** What the table is, said first by a screen reader ("Vendas por dia, do mais novo ao mais antigo."). */
  caption: string;
  columns: readonly ChartDataColumn[];
  /** The id the chart's `aria-details` points at. */
  id: string;
  rows: readonly ChartDataRow[];
  /** Shown on the screen, as the error state of a chart that did not open; false keeps it for assistive technology only. */
  visible?: boolean;
}

const align = (numeric: boolean | undefined) => numeric && "text-right";

/**
 * The day-by-day numbers of a chart as a real table: invisible on the screen (`sr-only`, out of the tab order) and
 * tied to the chart by the chart's `aria-details`, so the drawing is never the only source of a number for assistive
 * technology. When the chart does not open it is shown (`visible`) in its place. Every cell goes through the mask of
 * "Esconder valores": an amount is "R$ ••••" on the screen and "valor escondido" to a screen reader, never a digit.
 * Only plain text goes in the cells; the first column names the row (`th scope="row"`), so a screen reader says the day
 * before each value.
 */
export function ChartDataTable({
  caption,
  columns,
  id,
  rows,
  visible = false,
}: ChartDataTableProps) {
  return (
    <div
      className={cn(visible ? "w-full overflow-x-auto" : "sr-only")}
      data-chart-data-table={visible ? "visible" : "hidden"}
    >
      <table className="w-full caption-top text-sm" id={id}>
        <caption
          className={cn(
            "text-left",
            visible && "pb-2 text-muted-foreground text-support"
          )}
        >
          {caption}
        </caption>
        <thead className="[&_tr]:border-b">
          <tr>
            {columns.map((column) => (
              <th
                className={cn(
                  "h-9 px-2 font-medium text-muted-foreground text-xs",
                  align(column.numeric) || "text-left"
                )}
                key={column.header}
                scope="col"
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&_tr:last-child]:border-0">
          {rows.map((row) => (
            <tr className="border-b" key={row.key}>
              {row.cells.map((cell, index) =>
                index === 0 ? (
                  <th
                    className="px-2 py-2.5 text-left font-normal"
                    key={columns[index]?.header ?? index}
                    scope="row"
                  >
                    <MoneyText text={cell} />
                  </th>
                ) : (
                  <td
                    className={cn(
                      "px-2 py-2.5",
                      columns[index]?.numeric && "text-right tabular-nums"
                    )}
                    key={columns[index]?.header ?? index}
                  >
                    <MoneyText text={cell} />
                  </td>
                )
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
