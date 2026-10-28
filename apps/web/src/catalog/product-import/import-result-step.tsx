import CircleAlertIcon from "lucide-react/dist/esm/icons/circle-alert";
import CircleCheckIcon from "lucide-react/dist/esm/icons/circle-check";
import DownloadIcon from "lucide-react/dist/esm/icons/download";
import { type ReactNode, type Ref, useCallback, useMemo } from "react";
import { Button } from "@/ui/button";
import { LimitHelp } from "../../subscription/limit-help";
import type { LimitHelpView } from "../../subscription/limit-help-model";
import {
  type FailedRowKind,
  failedImportCsv,
} from "../product-import-failed-csv";
import { type ImportRun, summarizeImport } from "../product-import-send";
import { downloadCsv, StepFrame } from "./import-frame";
import {
  FAILED_KIND_LABELS,
  failedCsvLabel,
  type ImportPlan,
  resultFailedRows,
  resultTexts,
  stockEntered,
  stockText,
} from "./import-model";
import {
  ImportRowsTable,
  type ImportTableRow,
  type RowMarkTone,
} from "./import-rows-table";

/** The mark of each row of the result: a row with no answer asks to be checked, it is no error. */
const RESULT_TONES: Record<FailedRowKind, RowMarkTone> = {
  error: "problem",
  exists: "left_out",
  not_entered: "left_out",
  unconfirmed: "warning",
};

const FAILED_FILE_NAME = "linhas-que-nao-entraram.csv";

interface ImportResultStepProps {
  bodyRef: Ref<HTMLDivElement>;
  /** The server stopped at the plan's limit: what goes with that sentence (corte 1.6). */
  limitHelp: LimitHelpView | null;
  offline: ReactNode;
  onAnother: () => void;
  /** "Ver os produtos", with how many entered: Produtos says it. */
  onShowProducts: (entered: number) => void;
  plan: ImportPlan;
  run: ImportRun | null;
  /** Whether the import started and ended on the same day of the store, on this device. */
  sameDay: boolean;
}

/**
 * Step 4: what entered, what did not and what already existed, said once in a status the screen reader reads; the
 * rows that did not enter, with the reason, and the CSV of them to fix and send again (written by the export's
 * `csvRow`, so a cell of the file never runs as a formula).
 */
export function ImportResultStep({
  bodyRef,
  limitHelp,
  onAnother,
  onShowProducts,
  offline,
  plan,
  run,
  sameDay,
}: ImportResultStepProps) {
  const entered = run ? summarizeImport(run).entered : 0;
  const texts = resultTexts(plan, run);
  const failed = useMemo(() => resultFailedRows(plan, run), [plan, run]);
  const rows = useMemo(
    () =>
      failed.map(
        (row): ImportTableRow => ({
          // a row with no answer is not confirmed, never an error: it may have entered
          label:
            FAILED_KIND_LABELS[
              row.kind === "exists" ? "not_entered" : row.kind
            ],
          name: row.source.name.trim(),
          reason: row.reason,
          rowNumber: row.rowNumber,
          tone: RESULT_TONES[row.kind],
        })
      ),
    [failed]
  );
  const handleShowProducts = useCallback(
    () => onShowProducts(entered),
    [entered, onShowProducts]
  );
  const handleDownload = useCallback(
    () => downloadCsv(FAILED_FILE_NAME, failedImportCsv(failed)),
    [failed]
  );
  const Icon = entered > 0 ? CircleCheckIcon : CircleAlertIcon;
  return (
    <StepFrame
      bodyRef={bodyRef}
      footer={
        <>
          <Button onClick={onAnother} type="button" variant="outline">
            Importar outro arquivo
          </Button>
          <Button onClick={handleShowProducts} type="button">
            Ver os produtos
          </Button>
        </>
      }
      offline={offline}
    >
      <div className="flex gap-2.5" role="status">
        <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
        <div className="grid gap-0.5">
          <p className="font-medium text-title">{texts.title}</p>
          {texts.notEntered ? <p>{texts.notEntered}</p> : null}
          {texts.existing ? <p>{texts.existing}</p> : null}
          {texts.unconfirmed ? <p>{texts.unconfirmed}</p> : null}
        </div>
      </div>
      {texts.limitReached ? <LimitHelp help={limitHelp} /> : null}
      {run && stockEntered(run) ? (
        <p className="text-muted-foreground text-support">
          {stockText(sameDay)}
        </p>
      ) : null}
      <ImportRowsTable
        caption="Linhas que não entraram"
        markHeader="Motivo"
        rows={rows}
      />
      {failed.length > 0 ? (
        <Button
          className="w-fit"
          onClick={handleDownload}
          type="button"
          variant="link"
        >
          <DownloadIcon aria-hidden="true" data-icon="inline-start" />
          {failedCsvLabel(failed)}
        </Button>
      ) : null}
    </StepFrame>
  );
}
