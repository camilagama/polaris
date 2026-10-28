import CloudOffIcon from "lucide-react/dist/esm/icons/cloud-off";
import type { ReactNode, Ref } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { DialogBody, DialogFooter } from "@/ui/dialog";
import { FORM_ELEMENT_CLASS } from "@/ui/dialog-layout";

/** The id of the notice that says the import needs a connection: the buttons it keeps off point at it. */
export const IMPORT_OFFLINE_ID = "product-import-offline";

/** Said at the top of each step while there is no connection: the import never goes to the offline queue. */
export function ImportOfflineNotice({ detail }: { detail: string }) {
  return (
    <Alert id={IMPORT_OFFLINE_ID} variant="warning">
      <CloudOffIcon aria-hidden="true" />
      <AlertTitle>Sem internet.</AlertTitle>
      <AlertDescription>{detail}</AlertDescription>
    </Alert>
  );
}

export const OFFLINE_DETAIL =
  "Importar precisa de conexão. O arquivo que você escolheu fica aqui enquanto esta janela estiver aberta.";
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
