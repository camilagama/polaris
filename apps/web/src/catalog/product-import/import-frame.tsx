import CloudOffIcon from "lucide-react/dist/esm/icons/cloud-off";
import type { ReactNode, Ref } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { DialogBody, DialogFooter } from "@/ui/dialog";
import { FORM_ELEMENT_CLASS } from "@/ui/dialog-layout";
import type { ImportStep } from "./use-product-import";

/** The id of the notice that says the import needs a connection: the buttons it keeps off point at it. */
export const IMPORT_OFFLINE_ID = "product-import-offline";

/** Said at the top of each step while there is no connection: the import never goes to the offline queue. */
export function ImportOfflineNotice({ detail }: { detail: string }) {
  return (
    <Alert id={IMPORT_OFFLINE_ID} variant="warning">
      <CloudOffIcon aria-hidden="true" />
      <AlertTitle>Sem conexão.</AlertTitle>
      <AlertDescription>{detail}</AlertDescription>
    </Alert>
  );
}

export const OFFLINE_DETAIL =
  "Importar precisa de conexão. O arquivo que você escolheu fica aqui enquanto esta janela estiver aberta.";
/** During the import (step 3): the status says what entered and what is left; this says how it goes on. */
export const OFFLINE_DETAIL_RUN =
  "Importar precisa de conexão. Quando ela voltar, continue de onde parou.";
/** After the result there is no file to keep: only what the import needs. */
export const OFFLINE_DETAIL_AFTER = "Importar precisa de conexão.";

interface StepFrameProps {
  /** The top of the body, focused when the step starts: a screen reader reads the step from its beginning. */
  bodyRef: Ref<HTMLDivElement>;
  children: ReactNode;
  footer: ReactNode;
  offline: ReactNode;
}

/** One step of the dialog: the body that scrolls, with the offline notice on top, and the footer that stays. */
export function StepFrame({
  bodyRef,
  children,
  footer,
  offline,
}: StepFrameProps) {
  return (
    <div className={FORM_ELEMENT_CLASS}>
      <DialogBody>
        <div
          className="focus-ring grid min-w-0 gap-4 rounded-md"
          ref={bodyRef}
          tabIndex={-1}
        >
          {offline}
          {children}
        </div>
      </DialogBody>
      <DialogFooter>{footer}</DialogFooter>
    </div>
  );
}

export const IMPORT_STEP_COUNT = 4;
const SEGMENTS = [1, 2, 3, 4] as const;

const STEP_NUMBER: Record<ImportStep["kind"], number> = {
  file: 1,
  paused: 3,
  paused_busy: 3,
  preview: 2,
  result: 4,
  running: 3,
};

const STEP_NAME: Record<ImportStep["kind"], string> = {
  file: "Arquivo",
  paused: "Importando",
  paused_busy: "Importando",
  preview: "Prévia",
  result: "Resultado",
  running: "Importando",
};

/** The line the screen reader hears under the title: "Passo 2 de 4 · Prévia". */
export function importStepText(kind: ImportStep["kind"]): string {
  return `Passo ${STEP_NUMBER[kind]} de ${IMPORT_STEP_COUNT} · ${STEP_NAME[kind]}`;
}

/**
 * Four segments under the title: the done steps and the current one in ink, the rest muted. It is decoration
 * (`aria-hidden`): the line above already says the step. The place is always taken, so the dialog keeps its height from
 * one step to the next. The fill of the new step grows from the left only where the interface moves (`motion-full:`).
 */
export function ImportStepBar({ kind }: { kind: ImportStep["kind"] }) {
  const current = STEP_NUMBER[kind];
  return (
    <div
      aria-hidden="true"
      className="flex h-1 gap-1"
      data-slot="import-step-bar"
    >
      {SEGMENTS.map((number) => (
        <span
          className="relative h-full flex-1 overflow-hidden rounded-full bg-muted"
          key={number}
        >
          <span
            className="absolute inset-0 origin-left bg-foreground motion-full:transition-transform motion-full:duration-200 data-[filled=false]:scale-x-0"
            data-filled={number <= current}
          />
        </span>
      ))}
    </div>
  );
}

const BLOB_KEPT_MS = 60_000;

/** Saves a CSV made here as a file of the device: nothing goes to the server. */
export function downloadCsv(fileName: string, text: string): void {
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/csv;charset=utf-8" })
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  // the address of the blob goes away only well after the click: Safari reads it after the click returns
  window.setTimeout(() => URL.revokeObjectURL(url), BLOB_KEPT_MS);
}
