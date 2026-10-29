import { type ChangeEvent, useCallback } from "react";
import { FieldError } from "@/ui/field";
import { Input } from "@/ui/input";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/table";
import type {
  ReturnDraft,
  ReturnDraftErrors,
  ReturnLineDraft,
  ReturnTableRow,
} from "./sale-return-model";

/* When the card is narrower than 48rem (a phone, or a tablet with the sidebar open) each row is a card: the head row
   is read only by the screen reader, the item is the card's title and every cell shows its column name
   (`data-label`) beside the value (auditoria v5.1, rule 3). The table measures its own box (`@container`), not the
   window: from 760 px the sidebar takes 16rem, and seven columns do not fit in what is left. */
const CARD_ROW =
  "@max-3xl:grid @max-3xl:gap-1 @max-3xl:border-b @max-3xl:py-3 @max-3xl:hover:bg-transparent";
const CARD_CELL =
  "@max-3xl:grid @max-3xl:grid-cols-[minmax(7rem,45%)_minmax(0,1fr)] @max-3xl:items-center @max-3xl:gap-2 @max-3xl:whitespace-normal @max-3xl:px-0! @max-3xl:py-0.5 @max-3xl:before:text-muted-foreground @max-3xl:before:text-support @max-3xl:before:content-[attr(data-label)]";
const NUMBER_CELL = `${CARD_CELL} tabular-nums`;
/* the two fields of a card are one above the other: 12 px between them keeps their 44 px touch areas apart */
const INPUT_CELL = `${CARD_CELL} @max-3xl:py-1.5`;

interface QuantityInputProps {
  disabled: boolean;
  error: string | undefined;
  id: string;
  label: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  value: string;
}

function QuantityInput({
  disabled,
  error,
  id,
  label,
  onChange,
  value,
}: QuantityInputProps) {
  return (
    <div className="grid min-w-0 gap-1">
      <Input
        aria-describedby={error ? `${id}-error` : undefined}
        aria-invalid={error ? true : undefined}
        aria-label={label}
        autoComplete="off"
        className="w-20"
        disabled={disabled}
        id={id}
        inputMode="numeric"
        maxLength={10}
        onChange={onChange}
        value={value}
      />
      <FieldError className="whitespace-normal" id={`${id}-error`}>
        {error}
      </FieldError>
    </div>
  );
}

interface ReturnRowProps {
  disabled: boolean;
  draft: ReturnLineDraft | undefined;
  errors: { restocked?: string; returned?: string } | undefined;
  onRestocked: (position: number, text: string) => void;
  onReturned: (position: number, text: string) => void;
  row: ReturnTableRow;
}

function ReturnRow({
  disabled,
  draft,
  errors,
  onRestocked,
  onReturned,
  row,
}: ReturnRowProps) {
  const handleReturned = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onReturned(row.position, event.target.value),
    [onReturned, row.position]
  );
  const handleRestocked = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onRestocked(row.position, event.target.value),
    [onRestocked, row.position]
  );
  const prefix = `sale-return-${row.position}`;
  return (
    <TableRow className={CARD_ROW}>
      <th
        className="@max-3xl:px-0 px-3 @max-3xl:py-0 py-2.5 text-left align-middle font-medium [overflow-wrap:anywhere] first:pl-4"
        data-label="Item"
        scope="row"
      >
        {row.label}
      </th>
      <TableCell className={NUMBER_CELL} data-label="Vendido">
        {row.sold}
      </TableCell>
      <TableCell className={NUMBER_CELL} data-label="Já devolvido">
        {row.returned}
      </TableCell>
      <TableCell className={NUMBER_CELL} data-label="Já voltou ao estoque">
        {row.restocked}
      </TableCell>
      <TableCell className={NUMBER_CELL} data-label="Disponível">
        {row.available}
      </TableCell>
      <TableCell className={INPUT_CELL} data-label="Devolvido">
        {draft ? (
          <QuantityInput
            disabled={disabled}
            error={errors?.returned}
            id={`${prefix}-returned`}
            label={`Devolvido: ${row.label} (até ${row.available})`}
            onChange={handleReturned}
            value={draft.returned}
          />
        ) : (
          "—"
        )}
      </TableCell>
      <TableCell className={INPUT_CELL} data-label="Volta ao estoque">
        {draft ? (
          <QuantityInput
            disabled={disabled}
            error={errors?.restocked}
            id={`${prefix}-restocked`}
            label={`Volta ao estoque: ${row.label}`}
            onChange={handleRestocked}
            value={draft.restocked}
          />
        ) : (
          "—"
        )}
      </TableCell>
    </TableRow>
  );
}

interface ReturnTableProps {
  disabled: boolean;
  draft: ReturnDraft;
  errors: ReturnDraftErrors;
  onRestocked: (position: number, text: string) => void;
  onReturned: (position: number, text: string) => void;
  rows: readonly ReturnTableRow[];
}

export function ReturnTable({
  disabled,
  draft,
  errors,
  onRestocked,
  onReturned,
  rows,
}: ReturnTableProps) {
  return (
    <div className="@container grid gap-2">
      <Table className="@max-3xl:block @max-3xl:[&_tbody]:block">
        <TableCaption className="sr-only">
          Itens da venda e quantidades para devolver
        </TableCaption>
        <TableHeader className="@max-3xl:sr-only">
          <TableRow className="hover:bg-transparent">
            <TableHead scope="col">Item</TableHead>
            <TableHead scope="col">Vendido</TableHead>
            <TableHead scope="col">Já devolvido</TableHead>
            <TableHead scope="col">Já voltou ao estoque</TableHead>
            <TableHead scope="col">Disponível</TableHead>
            <TableHead scope="col">Devolvido</TableHead>
            <TableHead scope="col">Volta ao estoque</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <ReturnRow
              disabled={disabled}
              draft={draft.lines.find((line) => line.position === row.position)}
              errors={errors.lines[row.position]}
              key={row.position}
              onRestocked={onRestocked}
              onReturned={onReturned}
              row={row}
            />
          ))}
        </TableBody>
      </Table>
      <FieldError>{errors.items}</FieldError>
    </div>
  );
}
