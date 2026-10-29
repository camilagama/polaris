import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
import { type ReactNode, type Ref, useMemo, useState } from "react";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";
import { LimitHelp } from "../../subscription/limit-help";
import type { LimitHelpView } from "../../subscription/limit-help-model";
import { IMPORT_OFFLINE_ID, StepFrame } from "./import-frame";
import {
  hasOpeningStock,
  headerNotes,
  type ImportPlan,
  importButtonLabel,
  importDurationText,
  noCategoryText,
  nothingToImportText,
  overLimitText,
  previewCounts,
  previewTableRows,
  type RowSituation,
  SITUATION_LABELS,
  splitAdviceText,
  type TableRow,
} from "./import-model";
import {
  ImportRowsTable,
  type ImportTableRow,
  type RowMarkTone,
} from "./import-rows-table";

const NOTHING_TO_IMPORT_ID = "product-import-nothing";

const TONES: Record<RowSituation, RowMarkTone> = {
  enters: "entered",
  error: "problem",
  exists: "left_out",
  no_category: "warning",
  over_limit: "left_out",
};

type Filter = "all" | "error" | "exists" | "no_category" | "over_limit";

const FILTERS: ReadonlyArray<readonly [Filter, string]> = [
  ["all", "Todas"],
  ["error", "Com erro"],
  ["exists", "Já existem"],
  ["no_category", "Sem categoria"],
  ["over_limit", "Fora do limite"],
];

function tableRow(row: TableRow): ImportTableRow {
  return {
    label: SITUATION_LABELS[row.situation],
    name: row.name,
    reason: row.reason,
    rowNumber: row.rowNumber,
    tone: TONES[row.situation],
  };
}

/** The filters with rows, and the first one with a problem to start on (the rows that need a look first). */
function filtersOf(rows: readonly TableRow[]) {
  const counts = new Map<Filter, number>([["all", rows.length]]);
  for (const row of rows) {
    if (row.situation !== "enters") {
      counts.set(row.situation, (counts.get(row.situation) ?? 0) + 1);
    }
  }
  const shown = FILTERS.filter(([filter]) => (counts.get(filter) ?? 0) > 0);
  const first = shown.find(([filter]) => filter !== "all")?.[0] ?? "all";
  return { counts, first, shown };
}

interface ImportPreviewStepProps {
  bodyRef: Ref<HTMLDivElement>;
  limitHelp: LimitHelpView | null;
  offline: ReactNode;
  onBack: () => void;
  onConfirm: () => void;
  online: boolean;
  plan: ImportPlan;
}

/** Step 2: what enters, what does not and why, before anything is written (AC-3); the plan's room (AC-6). */
export function ImportPreviewStep({
  bodyRef,
  limitHelp,
  onBack,
  onConfirm,
  offline,
  online,
  plan,
}: ImportPreviewStepProps) {
  const rows = useMemo(() => previewTableRows(plan), [plan]);
  const { counts, first, shown } = useMemo(() => filtersOf(rows), [rows]);
  const [filter, setFilter] = useState<Filter>(first);
  const limit = overLimitText(plan);
  const noCategory = noCategoryText(plan);
  const notes = headerNotes(plan);
  const count = plan.toSend.length;
  const off = count === 0 || !online;
  let offReason: string | undefined;
  if (!online) {
    offReason = IMPORT_OFFLINE_ID;
  } else if (count === 0) {
    offReason = NOTHING_TO_IMPORT_ID;
  }
  const [total, ...groups] = previewCounts(plan);
  const splitAdvice = splitAdviceText(count);
  return (
    <StepFrame
      bodyRef={bodyRef}
      footer={
        <>
          <Button onClick={onBack} type="button" variant="outline">
            Voltar
          </Button>
          <Button
            aria-describedby={off ? offReason : undefined}
            aria-disabled={off || undefined}
            onClick={off ? undefined : onConfirm}
            type="button"
          >
            {importButtonLabel(count)}
          </Button>
        </>
      }
      offline={offline}
    >
      <div className="grid gap-1">
        <p className="font-medium">{total}</p>
        <ul className="grid gap-0.5 pl-1">
          {groups.map((line) => (
            <li className="flex items-baseline gap-2" key={line}>
              <span aria-hidden="true">·</span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </div>
      {count === 0 ? (
        <p className="text-muted-foreground" id={NOTHING_TO_IMPORT_ID}>
          {nothingToImportText(plan)}
        </p>
      ) : (
        <p className="text-muted-foreground text-support">
          {importDurationText(count)}
        </p>
      )}
      {splitAdvice ? (
        <Alert variant="warning">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertDescription>{splitAdvice}</AlertDescription>
        </Alert>
      ) : null}
      {limit ? (
        <Alert variant="warning">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertDescription>
            {limit}
            <LimitHelp help={limitHelp} />
          </AlertDescription>
        </Alert>
      ) : null}
      {hasOpeningStock(plan.toSend) ? (
        <p className="text-muted-foreground text-support">
          O estoque informado é de abertura, com a data de hoje. Linha com
          quantidade e sem custo entra com custo desconhecido.
        </p>
      ) : null}
      {noCategory ? (
        <p className="text-muted-foreground text-support">{noCategory}</p>
      ) : null}
      {notes.length > 0 ? (
        <ul className="grid gap-0.5 text-muted-foreground text-support">
          {notes.map((note, index) => (
            // two columns of the same name say the same note: the place in the list tells them apart
            <li key={`${index}:${note}`}>{note}</li>
          ))}
        </ul>
      ) : null}
      <Tabs onValueChange={setFilter} value={filter}>
        <TabsList
          aria-label="Linhas do arquivo"
          className="h-auto w-full flex-wrap justify-start gap-x-1 gap-y-4"
        >
          {shown.map(([value, label]) => (
            <TabsTrigger
              className="h-ctl-md flex-none"
              key={value}
              value={value}
            >
              {label} ({counts.get(value) ?? 0})
            </TabsTrigger>
          ))}
        </TabsList>
        {shown.map(([value, label]) => (
          <TabsContent key={value} value={value}>
            <ImportRowsTable
              caption={`Linhas do arquivo: ${label}`}
              markHeader="Situação"
              rows={rows
                .filter((row) => value === "all" || row.situation === value)
                .map(tableRow)}
            />
          </TabsContent>
        ))}
      </Tabs>
    </StepFrame>
  );
}
