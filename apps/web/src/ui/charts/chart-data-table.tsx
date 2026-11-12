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
  /** Indexes into `cells` of the amounts below zero; they are drawn in the destructive color, masked or not. */
  negativeCells?: readonly number[];
}

export interface ChartDataTableProps {
  /** What the table is, said first by a screen reader ("Vendas por dia, do mais novo ao mais antigo."). */
  caption: string;
  columns: readonly ChartDataColumn[];
  /** A line that closes the table, across every column ("Depois de hoje: despesas R$ 120,00"); it goes through the mask too. */
  footer?: string | undefined;
  /** The id the chart's `aria-details` points at. */
  id: string;
  rows: readonly ChartDataRow[];
  /** Shown on the screen, as the error state of a chart that did not open; false keeps it for assistive technology only. */
  visible?: boolean;
}

/* A shown table of more than three columns would be wider than a phone: below 48rem of its own box (`@container`) each row
   becomes a card, with the first cell as its title and the name of each column (`data-label`) beside its value. The head
   row stays for the screen reader. The invisible table keeps its table layout: a screen reader drops the table semantics
   of a `table` turned into blocks. Nothing scrolls sideways. */
const STACK_TABLE =
  "@max-3xl:block @max-3xl:[&_tbody]:block @max-3xl:[&_tfoot]:block @max-3xl:[&_tfoot_tr]:block";
const STACK_HEAD =
  "@max-3xl:absolute @max-3xl:left-0 @max-3xl:h-px @max-3xl:w-full @max-3xl:overflow-hidden @max-3xl:[clip-path:inset(50%)] @max-3xl:[&_tr]:block @max-3xl:[&_th]:block @max-3xl:[&_th]:h-auto @max-3xl:[&_th]:whitespace-normal @max-3xl:[&_th]:p-0";
const STACK_ROW = "@max-3xl:grid @max-3xl:gap-1 @max-3xl:py-3";
const STACK_TITLE = "@max-3xl:px-0 @max-3xl:py-0 @max-3xl:text-base";
const STACK_CELL =
  "@max-3xl:grid @max-3xl:grid-cols-[minmax(7rem,45%)_minmax(0,1fr)] @max-3xl:items-center @max-3xl:gap-2 @max-[14rem]:grid-cols-1 @max-[14rem]:gap-0 @max-3xl:px-0 @max-3xl:py-0.5 @max-3xl:text-left @max-3xl:before:text-muted-foreground @max-3xl:before:text-support @max-3xl:before:content-[attr(data-label)]";
const STACK_FOOT =
  "@max-3xl:block @max-3xl:px-0 @max-3xl:py-3 @max-3xl:text-left";
const MAX_SIDE_BY_SIDE_COLUMNS = 3;

const align = (numeric: boolean | undefined) => numeric && "text-right";

/* one pixel tall and clipped, as `sr-only` is, but as wide as the clip itself (`w-full`) instead of one pixel: the table
   inside keeps its columns and its text wraps inside the cell, so nothing in it is wider than the clip; it is out of the
   flow, so it adds no gap */
const HIDDEN =
  "absolute left-0 h-px w-full overflow-hidden [clip-path:inset(50%)]";

/* an automatic table layout never goes below the widest word of each column, so five columns made a table wider than a
   phone and every box of it past the screen; a fixed layout holds the table to the width of its wrapper and the text
   breaks inside the cell */
const HIDDEN_TABLE =
  "table-fixed [overflow-wrap:anywhere] [&_td]:px-0 [&_th]:px-0";

/**
 * The day-by-day numbers of a chart as a real table: invisible on the screen (clipped to one pixel, out of the tab order) and
 * tied to the chart by the chart's `aria-details`, so the drawing is never the only source of a number for assistive
 * technology. When the chart does not open it is shown (`visible`) in its place. Every cell goes through the mask of
 * "Esconder valores": an amount is "R$ ••••" on the screen and "valor escondido" to a screen reader, never a digit.
 * Only plain text goes in the cells; the first column names the row (`th scope="row"`), so a screen reader says the day
 * before each value.
 */
export function ChartDataTable({
  caption,
  columns,
  footer,
  id,
  rows,
  visible = false,
}: ChartDataTableProps) {
  const stacked = visible && columns.length > MAX_SIDE_BY_SIDE_COLUMNS;
  return (
    <div
      className={cn(visible ? "w-full overflow-x-auto" : HIDDEN, "@container")}
      data-chart-data-table={visible ? "visible" : "hidden"}
    >
      <table
        className={cn(
          "w-full caption-top text-sm",
          !visible && HIDDEN_TABLE,
          stacked && STACK_TABLE
        )}
        id={id}
      >
        <caption
          className={cn(
            "text-left",
            visible && "pb-2 text-muted-foreground text-support"
          )}
        >
          {caption}
        </caption>
        <thead className={cn("[&_tr]:border-b", stacked && STACK_HEAD)}>
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
            <tr className={cn("border-b", stacked && STACK_ROW)} key={row.key}>
              {row.cells.map((cell, index) =>
                index === 0 ? (
                  <th
                    className={cn(
                      "px-2 py-2.5 text-left font-normal",
                      stacked && STACK_TITLE
                    )}
                    key={columns[index]?.header ?? index}
                    scope="row"
                  >
                    <MoneyText text={cell} />
                  </th>
                ) : (
                  <td
                    className={cn(
                      "px-2 py-2.5",
                      columns[index]?.numeric && "text-right tabular-nums",
                      row.negativeCells?.includes(index) && "text-destructive",
                      stacked && STACK_CELL
                    )}
                    data-label={columns[index]?.header}
                    key={columns[index]?.header ?? index}
                  >
                    <MoneyText text={cell} />
                  </td>
                )
              )}
            </tr>
          ))}
        </tbody>
        {footer ? (
          <tfoot>
            <tr>
              <td
                className={cn(
                  "px-2 py-2.5 text-right tabular-nums",
                  stacked && STACK_FOOT
                )}
                colSpan={columns.length}
              >
                <MoneyText text={footer} />
              </td>
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}
