import CircleAlertIcon from "lucide-react/dist/esm/icons/circle-alert";
import { type ReactNode, type Ref, useCallback } from "react";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Progress } from "@/ui/progress";
import type { ImportRun } from "../product-import-send";
import { summarizeImport } from "../product-import-send";
import { IMPORT_OFFLINE_ID, StepFrame } from "./import-frame";
import {
  answeredCount,
  enteredAndLeft,
  estimateText,
  progressTitle,
  progressValueText,
} from "./import-model";
import type { ImportPause } from "./use-product-import";

/** What a pause says before "N produtos entraram; M faltam.". */
function pauseLead(pause: ImportPause): string {
  switch (pause.kind) {
    case "offline":
      return "Sem internet.";
    case "stopped":
      return "Importação parada.";
    case "interrupted":
      return "O servidor não respondeu.";
    case "rate_limited":
      return "O envio está ocupado agora. Espere um minuto e continue.";
    default:
      return pause.message;
  }
}

interface ImportRunStepProps {
  bodyRef: Ref<HTMLDivElement>;
  offline: ReactNode;
  /** "Continuar de onde parou": the same rows, with the same IDs. */
  onContinue: () => void;
  /** "Ver o resultado": what entered and what did not, the rows not sent among the latter. */
  onFinish: () => void;
  online: boolean;
  onStop: () => void;
  /** When this run (or its continuation) started, and from which row: the pace of the estimate. */
  pace: { fromIndex: number; startedAt: number } | null;
  /** `null` while the run goes on. */
  pause: ImportPause | null;
  run: ImportRun;
  stopping: boolean;
}

/**
 * Step 3: the rows answered of the rows sent, never a promised time; an estimate only from the pace of this import,
 * said as one. A row tried again after a failure of the server is no step back and no error: the count waits. The
 * connection gone stops the run after the row on its way, and says what entered and what is left.
 */
export function ImportRunStep({
  bodyRef,
  onContinue,
  onFinish,
  onStop,
  offline,
  online,
  pace,
  pause,
  run,
  stopping,
}: ImportRunStepProps) {
  const count = run.rows.length;
  const done = answeredCount(run);
  const summary = summarizeImport(run);
  const left = count - done;
  const estimate =
    pause === null && pace !== null
      ? estimateText(done - pace.fromIndex, Date.now() - pace.startedAt, left)
      : null;
  const continueOff = !online;
  const valueText = useCallback(
    () => progressValueText(done, count),
    [count, done]
  );
  return (
    <StepFrame
      bodyRef={bodyRef}
      footer={
        pause === null ? (
          <Button
            aria-disabled={stopping || undefined}
            onClick={stopping ? undefined : onStop}
            type="button"
            variant="outline"
          >
            {stopping
              ? "Parando depois desta linha…"
              : "Parar depois desta linha"}
          </Button>
        ) : (
          <>
            <Button onClick={onFinish} type="button" variant="outline">
              Ver o resultado
            </Button>
            <Button
              aria-describedby={continueOff ? IMPORT_OFFLINE_ID : undefined}
              aria-disabled={continueOff || undefined}
              onClick={continueOff ? undefined : onContinue}
              type="button"
            >
              Continuar de onde parou
            </Button>
          </>
        )
      }
      offline={offline}
    >
      <div aria-live="polite" className="grid gap-1" role="status">
        {pause === null ? (
          <p className="font-medium">{progressTitle(count)}</p>
        ) : (
          <p className="font-medium">
            {pauseLead(pause)} {enteredAndLeft(summary.entered, left)}
          </p>
        )}
      </div>
      <Progress
        aria-label="Progresso da importação"
        getAriaValueText={valueText}
        max={count}
        value={done}
      >
        <span className="text-muted-foreground text-support tabular-nums">
          {done} de {count}
        </span>
      </Progress>
      {estimate ? (
        <p className="text-muted-foreground text-support">{estimate}</p>
      ) : null}
      {pause === null ? (
        <p className="text-muted-foreground text-support">
          Você pode continuar usando o Polaris em outra aba. Não feche esta
          janela.
        </p>
      ) : null}
      {pause?.kind === "refused" ? (
        <Alert role="alert" variant="destructive">
          <CircleAlertIcon aria-hidden="true" />
          <AlertDescription>
            O que entrou fica. Confira antes de continuar.
          </AlertDescription>
        </Alert>
      ) : null}
    </StepFrame>
  );
}
