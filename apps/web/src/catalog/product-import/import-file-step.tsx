import ChevronDownIcon from "lucide-react/dist/esm/icons/chevron-down";
import CircleAlertIcon from "lucide-react/dist/esm/icons/circle-alert";
import DownloadIcon from "lucide-react/dist/esm/icons/download";
import {
  type ChangeEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useRef,
} from "react";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import { IMPORT_MAX_ROWS } from "../product-import-csv";
import { downloadCsv, IMPORT_OFFLINE_ID, StepFrame } from "./import-frame";
import { importTemplateCsv } from "./import-model";

const FILE_NAME_ID = "product-import-file-name";
const FILE_HINT_ID = "product-import-file-hint";
export const IMPORT_PICK_BUTTON_ID = "product-import-pick";
const TEMPLATE_NAME = "modelo-importacao-produtos.csv";

interface ImportFileStepProps {
  bodyRef: Ref<HTMLDivElement>;
  fileName: string | null;
  offline: ReactNode;
  onCancel: () => void;
  onChoose: (file: File | null) => void;
  online: boolean;
  onRead: () => void;
  problem: string | null;
  reading: boolean;
}

function handleTemplate() {
  downloadCsv(TEMPLATE_NAME, importTemplateCsv());
}

/**
 * Step 1: the file, the template and how to save a spreadsheet as CSV. The native file control says "Choose file" in
 * the browser's language: the control is a button and the name of the file in Portuguese, and the input stays out of
 * the way (not focusable, not read), as in the images of a product.
 */
export function ImportFileStep({
  bodyRef,
  fileName,
  onCancel,
  onChoose,
  onRead,
  offline,
  online,
  problem,
  reading,
}: ImportFileStepProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const handlePick = useCallback(() => inputRef.current?.click(), []);
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onChoose(event.target.files?.[0] ?? null);
      // the same file chosen again (fixed and saved) is a change too
      event.target.value = "";
    },
    [onChoose]
  );
  const off = fileName === null || !online || reading;
  const offReason = online ? FILE_NAME_ID : IMPORT_OFFLINE_ID;
  return (
    <StepFrame
      bodyRef={bodyRef}
      footer={
        <>
          <Button onClick={onCancel} type="button" variant="outline">
            Cancelar
          </Button>
          <Button
            aria-describedby={off ? offReason : undefined}
            aria-disabled={off || undefined}
            onClick={off ? undefined : onRead}
            type="button"
          >
            {reading ? "Lendo o arquivo…" : "Ver a prévia"}
          </Button>
        </>
      }
      offline={offline}
    >
      <p>
        Cria produtos novos a partir de um arquivo CSV. Nada do que já existe
        muda ou some.
      </p>
      <div className="grid gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <Button
            aria-describedby={`${FILE_NAME_ID} ${FILE_HINT_ID}`}
            id={IMPORT_PICK_BUTTON_ID}
            onClick={handlePick}
            type="button"
            variant="outline"
          >
            Escolher arquivo
          </Button>
          <span
            className="min-w-0 text-muted-foreground text-support [overflow-wrap:anywhere]"
            id={FILE_NAME_ID}
            role="status"
          >
            {fileName === null ? (
              "Nenhum arquivo escolhido"
            ) : (
              <bdi>{fileName}</bdi>
            )}
          </span>
        </div>
        <p className="text-muted-foreground text-support" id={FILE_HINT_ID}>
          CSV, até {IMPORT_MAX_ROWS} linhas e 1 MB.
        </p>
        <input
          accept=".csv,text/csv"
          aria-hidden="true"
          aria-label="Escolher arquivo"
          className="sr-only"
          onChange={handleChange}
          ref={inputRef}
          tabIndex={-1}
          type="file"
        />
      </div>
      {problem ? (
        <Alert role="alert" variant="destructive">
          <CircleAlertIcon aria-hidden="true" />
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid justify-items-start gap-1">
        <Button onClick={handleTemplate} type="button" variant="link">
          <DownloadIcon aria-hidden="true" data-icon="inline-start" />
          Baixar o modelo (CSV)
        </Button>
        <Collapsible>
          <CollapsibleTrigger
            className="group/how"
            render={<Button type="button" variant="link" />}
          >
            <ChevronDownIcon
              aria-hidden="true"
              className="group-data-[panel-open]/how:rotate-180"
              data-icon="inline-start"
            />
            Como salvar a planilha como CSV
          </CollapsibleTrigger>
          <CollapsiblePanel className="grid gap-1 pt-1 pl-1 text-muted-foreground text-support">
            <p>No Excel: Arquivo &gt; Salvar como &gt; CSV UTF-8.</p>
            <p>No Google Planilhas: Arquivo &gt; Fazer download &gt; CSV.</p>
          </CollapsiblePanel>
        </Collapsible>
      </div>
      <p className="text-muted-foreground text-support">
        Colunas: Nome (obrigatória), Preço de tabela, Quantidade, Custo de cada
        unidade, Categoria, Descrição. Quantidade e custo vazios criam só o
        produto.
      </p>
    </StepFrame>
  );
}
