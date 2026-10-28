import type { CategoryReadModel } from "@polaris/contracts";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { useConnectionOnline } from "../../lib/browser-connection";
import { useCurrentOrganization } from "../../lib/current-organization";
import { calendarDayInTimezone } from "../../lib/dates";
import { useLimitHelp } from "../../subscription/limit-help";
import { IMPORT_PICK_BUTTON_ID, ImportFileStep } from "./import-file-step";
import {
  ImportOfflineNotice,
  OFFLINE_DETAIL,
  OFFLINE_DETAIL_AFTER,
  OFFLINE_DETAIL_RUN,
} from "./import-frame";
import { ImportPreviewStep } from "./import-preview-step";
import { ImportResultStep } from "./import-result-step";
import { ImportRunStep } from "./import-run-step";
import { type ImportStep, useProductImport } from "./use-product-import";

/**
 * "Importar planilha" (corte 2.5): one dialog, four steps (the file, the preview, the import, the result), the whole
 * screen on a phone and the centred dialog from 760 px (`layout="form"`, with the step back of the phone, t408). Its
 * code and the reading of the CSV are a chunk of their own, loaded when the person opens the import and kept out of the
 * precache (there is no import offline). Esc and × keep the file and the preview while the page is open; nothing
 * closes the dialog while rows are on their way; after the result it closes for good.
 */

const STEP_NAMES: Record<ImportStep["kind"], string> = {
  file: "Passo 1 de 4 · Arquivo",
  paused: "Passo 3 de 4 · Importando",
  preview: "Passo 2 de 4 · Prévia",
  result: "Passo 4 de 4 · Resultado",
  running: "Passo 3 de 4 · Importando",
};

/** The file is kept on the first two steps; once rows went, what matters is where the import continues. */
const OFFLINE_DETAILS: Record<ImportStep["kind"], string> = {
  file: OFFLINE_DETAIL,
  paused: OFFLINE_DETAIL_RUN,
  preview: OFFLINE_DETAIL,
  result: OFFLINE_DETAIL_AFTER,
  running: OFFLINE_DETAIL_RUN,
};

export interface ProductImportDialogProps {
  categories: readonly CategoryReadModel[];
  /** Where the focus goes back when the dialog closes: the button that opened it, or `true` for the default. */
  finalFocus: () => HTMLElement | boolean;
  /** Closes the dialog (Esc, ×, the step back, "Cancelar"). */
  onClose: () => void;
  /** Rows entered: the screen reads its products again. */
  onEntered: () => void;
  /** "Ver os produtos": the dialog closes and the list says how many entered, and shows them. */
  onShowProducts: (entered: number) => void;
  open: boolean;
}

function firstFocus() {
  return document.getElementById(IMPORT_PICK_BUTTON_ID) ?? true;
}

export function ProductImportDialog({
  categories,
  finalFocus,
  onClose,
  onEntered,
  onShowProducts,
  open,
}: ProductImportDialogProps) {
  const { organization } = useCurrentOrganization();
  const online = useConnectionOnline();
  const [state, actions] = useProductImport({ categories, onEntered, online });
  const { step } = state;
  const busy = step.kind === "running";
  const [stopping, setStopping] = useState(false);
  const { help: resultLimitHelp, show: showLimitHelp } = useLimitHelp();
  const bodyRef = useRef<HTMLDivElement>(null);

  // each step starts at its top, read from there; the first one opens on "Escolher arquivo" (`initialFocus`)
  const stepKind = step.kind;
  useEffect(() => {
    setStopping(false);
    if (stepKind !== "file") {
      bodyRef.current?.focus();
    }
  }, [stepKind]);

  // the server stopped at the limit: the help reads the plan as it is now (corte 1.6)
  const limitAtResult = step.kind === "result" && step.limit;
  useEffect(() => {
    if (limitAtResult) {
      showLimitHelp("variants");
    }
  }, [limitAtResult, showLimitHelp]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!(next || busy)) {
        onClose();
      }
    },
    [busy, onClose]
  );
  // after the result the dialog closes for good: the next opening starts with a new file
  const done = step.kind === "result";
  const handleOpenChangeComplete = useCallback(
    (next: boolean) => {
      if (!next && done) {
        actions.reset();
      }
    },
    [actions, done]
  );
  const handleCancel = useCallback(() => {
    actions.reset();
    onClose();
  }, [actions, onClose]);
  const handleStop = useCallback(() => {
    setStopping(true);
    actions.stop();
  }, [actions]);

  const offline = online ? null : (
    <ImportOfflineNotice detail={OFFLINE_DETAILS[step.kind]} />
  );
  const today = calendarDayInTimezone(new Date(), organization.timezone);

  let body: ReactNode;
  if (step.kind === "file" || state.plan === null) {
    body = (
      <ImportFileStep
        bodyRef={bodyRef}
        fileName={state.file?.name ?? null}
        offline={offline}
        onCancel={handleCancel}
        onChoose={actions.chooseFile}
        online={online}
        onRead={actions.readFile}
        problem={state.fileProblem}
        reading={state.reading}
      />
    );
  } else if (step.kind === "preview" || state.run === null) {
    body = (
      <ImportPreviewStep
        bodyRef={bodyRef}
        limitHelp={state.limitHelp}
        offline={offline}
        onBack={actions.back}
        onConfirm={actions.confirm}
        online={online}
        plan={state.plan}
      />
    );
  } else if (step.kind === "result") {
    body = (
      <ImportResultStep
        bodyRef={bodyRef}
        limitHelp={resultLimitHelp}
        offline={offline}
        onAnother={actions.reset}
        onShowProducts={onShowProducts}
        plan={state.plan}
        run={state.run}
        sameDay={state.startedOn === today}
      />
    );
  } else {
    body = (
      <ImportRunStep
        bodyRef={bodyRef}
        offline={offline}
        onContinue={actions.continueRun}
        onFinish={actions.finish}
        online={online}
        onSkip={actions.skip}
        onStop={handleStop}
        pace={state.pace}
        pause={step.kind === "paused" ? step.pause : null}
        run={state.run}
        stopping={stopping}
      />
    );
  }

  return (
    <Dialog
      disablePointerDismissal
      onOpenChange={handleOpenChange}
      onOpenChangeComplete={handleOpenChangeComplete}
      open={open}
    >
      <DialogContent
        className="md:max-w-[40rem]"
        finalFocus={finalFocus}
        initialFocus={firstFocus}
        layout="form"
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle>Importar planilha</DialogTitle>
          <DialogDescription>{STEP_NAMES[step.kind]}</DialogDescription>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}
