import CircleAlertIcon from "lucide-react/dist/esm/icons/circle-alert";
import CircleCheckIcon from "lucide-react/dist/esm/icons/circle-check";
import CircleMinusIcon from "lucide-react/dist/esm/icons/circle-minus";
import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
import { useCallback, useState } from "react";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/table";

/**
 * The rows of a file in a table that holds in 320 px: three columns (the row of the file, the name, and the mark with
 * its reason under it), the text wrapping instead of the table scrolling sideways. The mark is a word with an icon,
 * never a color alone. Twenty rows at a time, then "Mostrar mais".
 */

export type RowMarkTone = "entered" | "left_out" | "problem" | "warning";

export interface ImportTableRow {
  label: string;
  name: string;
  reason: string | null;
  rowNumber: number;
  tone: RowMarkTone;
}

const PAGE = 20;

/** The mark wraps in two lines when the column is narrow (320 px), never cut at the edge of the table. */
const MARK =
  "h-auto min-h-5 max-w-full overflow-visible whitespace-normal rounded-xl py-0.5 text-left leading-tight";

const CELL = "whitespace-normal px-2 align-top [overflow-wrap:anywhere]";

function RowMark({ label, tone }: Pick<ImportTableRow, "label" | "tone">) {
  if (tone === "problem") {
    return (
      <Badge className={MARK} variant="destructive">
        <CircleAlertIcon aria-hidden="true" data-icon="inline-start" />
        {label}
      </Badge>
    );
  }
  if (tone === "warning") {
    return (
      <Badge className={MARK} variant="warning">
        <TriangleAlertIcon aria-hidden="true" data-icon="inline-start" />
        {label}
      </Badge>
    );
  }
  if (tone === "left_out") {
    return (
      <Badge className={MARK} variant="secondary">
        <CircleMinusIcon aria-hidden="true" data-icon="inline-start" />
        {label}
      </Badge>
    );
  }
  return (
    <Badge className={MARK}>
      <CircleCheckIcon aria-hidden="true" data-icon="inline-start" />
      {label}
    </Badge>
  );
}

interface ImportRowsTableProps {
  caption: string;
  /** The header of the third column: "Situação" in the preview, "Motivo" in the result. */
  markHeader: string;
  rows: readonly ImportTableRow[];
}

export function ImportRowsTable({
  caption,
  markHeader,
  rows,
}: ImportRowsTableProps) {
  const [shown, setShown] = useState(PAGE);
  const handleMore = useCallback(() => setShown((count) => count + PAGE), []);
  if (rows.length === 0) {
    return null;
  }
  const visible = rows.slice(0, shown);
  const left = rows.length - visible.length;
  return (
    <div className="grid min-w-0 gap-2">
      <Table className="table-fixed">
        <TableCaption className="sr-only">{caption}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead className="w-14 px-2 first:pl-2" scope="col">
              Linha
            </TableHead>
            <TableHead className="w-[38%] px-2" scope="col">
              Nome
            </TableHead>
            <TableHead className="px-2 last:pr-2" scope="col">
              {markHeader}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.map((row) => (
            <TableRow key={row.rowNumber}>
              <TableCell
                className={`${CELL} tabular-nums first:pl-2`}
                data-label="Linha"
              >
                {row.rowNumber}
              </TableCell>
              <TableCell className={CELL} data-label="Nome">
                {row.name === "" ? (
                  <span className="text-muted-foreground">(vazio)</span>
                ) : (
                  // a name that turns the text around stays inside its cell
                  <bdi>{row.name}</bdi>
                )}
              </TableCell>
              <TableCell
                className={`${CELL} last:pr-2`}
                data-label={markHeader}
              >
                <span className="grid justify-items-start gap-1">
                  <RowMark label={row.label} tone={row.tone} />
                  {row.reason ? (
                    <span className="text-muted-foreground text-support">
                      {row.reason}
                    </span>
                  ) : null}
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {left > 0 ? (
        <Button
          className="w-fit"
          onClick={handleMore}
          size="sm"
          type="button"
          variant="outline"
        >
          Mostrar mais {Math.min(left, PAGE)} de {left}
        </Button>
      ) : null}
    </div>
  );
}
