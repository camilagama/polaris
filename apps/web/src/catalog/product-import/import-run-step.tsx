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
  busyPauseText,
  canSkipRow,
  estimateText,
  pauseText,
  progressTitle,
  progressValueText,
} from "./import-model";
import type { ImportPause } from "./use-product-import";

interface ImportRunStepProps {
  bodyRef: Ref<HTMLDivElement>;
  offline: ReactNode;
  /** "Continuar de onde parou": the same rows, with the same IDs. */
  onContinue: () => void;
  /** "Ver o resultado": what entered and what did not, the rows not sent among the latter. */
  onFinish: () => void;
  online: boolean;
  /** "Pular esta linha": the row the server never answered is left out (not confirmed) and the run goes on. */
  onSkip: () => void;
  onStop: () => void;
  /** When this run (or its continuation) started, and from which row: the pace of the estimate. */
  pace: { fromIndex: number; startedAt: number } | null;
  /** `null` while the run goes on. */
  pause: ImportPause | null;
  /** In the pause of the regime: when the run goes on by itself; `null` otherwise. */
  resumeAt: number | null;
  run: ImportRun;
  stopping: boolean;
  /** The store's time zone, for the hour the run goes on. */
  timeZone: string;
}

const SKIP_HELP_ID = "product-import-skip-help";
/** What "Pular esta linha" does, said before the click: the row is left as not confirmed, the import goes on. */
const SKIP_HELP =
  "A linha fica como não confirmada e a importação segue com a próxima.";

type RunFooterProps = { skippable: boolean } & Pick<
  ImportRunStepProps,
  | "onContinue"
  | "onFinish"
  | "onSkip"
  | "onStop"
  | "pause"
  | "resumeAt"
  | "stopping"
> & { offline: boolean };

/**
 * While rows go: "Parar depois desta linha" (the row on its way gets its answer, then the run stops); in the pause of
 * the regime no row is on its way, so it stops at once. No "try now" there: trying sooner prolongs the regime. On a
 * pause: the result, and continuing from where it stopped; after a row the server never answered, "Pular esta linha"
 * too. With no connection, what sends stays reachable, off, and reads why.
 */
function RunFooter({
  offline,
  onContinue,
  onFinish,
  onSkip,
  onStop,
  pause,
  resumeAt,
  skippable,
  stopping,
}: RunFooterProps) {
  if (pause === null && resumeAt !== null) {
    return (
      <Button
        aria-disabled={stopping || undefined}
        onClick={stopping ? undefined : onStop}
        type="button"
        variant="outline"
      >
        Parar a importação
      </Button>
    );
  }
  if (pause === null) {
    return (
      <Button
        aria-disabled={stopping || undefined}
        onClick={stopping ? undefined : onStop}
        type="button"
        variant="outline"
      >
        {stopping ? "Parando depois desta linha…" : "Parar depois desta linha"}
      </Button>
    );
  }
  const reason = offline ? IMPORT_OFFLINE_ID : undefined;
  return (
    <>
      <Button onClick={onFinish} type="button" variant="outline">
        Ver o resultado
      </Button>
      {skippable ? (
        <Button
          aria-describedby={reason ? `${reason} ${SKIP_HELP_ID}` : SKIP_HELP_ID}
          aria-disabled={offline || undefined}
          onClick={offline ? undefined : onSkip}
          type="button"
          variant="outline"
        >
          Pular esta linha
        </Button>
      ) : null}
      <Button
        aria-describedby={reason}
        aria-disabled={offline || undefined}
        onClick={offline ? undefined : onContinue}
        type="button"
      >
        Continuar de onde parou
      </Button>
    </>
  );
}

/**
 * Step 3: the rows answered of the rows sent, never a promised time; the time left only from the pace of this import,
 * its pauses included, said as an estimate. A row tried again after a failure of the server is no step back and no error: the count waits. The
 * connection gone stops the run after the row on its way, and says what entered and what is left.
 */
export function ImportRunStep({
  bodyRef,
  onContinue,
  onFinish,
  onSkip,
  onStop,
  offline,
  online,
  pace,
  pause,
  resumeAt,
  run,
  stopping,
  timeZone,
}: ImportRunStepProps) {
  const count = run.rows.length;
  const done = answeredCount(run);
  const summary = summarizeImport(run);
  const left = count - done;
  const skippable = pause !== null && canSkipRow(pause, run);
  const estimate =
    pause === null && resumeAt === null && pace !== null
      ? estimateText(done - pace.fromIndex, Date.now() - pace.startedAt, left)
      : null;
  const valueText = useCallback(
    () => progressValueText(done, count),
    [count, done]
  );
  return (
    <StepFrame
      bodyRef={bodyRef}
      footer={
        <RunFooter
          offline={!online}
          onContinue={onContinue}
          onFinish={onFinish}
          onSkip={onSkip}
          onStop={onStop}
          pause={pause}
          resumeAt={resumeAt}
          skippable={skippable}
          stopping={stopping}
        />
      }
      offline={offline}
    >
      <div aria-live="polite" className="grid gap-1" role="status">
        {pause === null && resumeAt !== null ? (
          <p className="font-medium">{busyPauseText(resumeAt, timeZone)}</p>
        ) : null}
        {pause === null && resumeAt === null ? (
          <p className="font-medium">{progressTitle(count)}</p>
        ) : null}
        {pause === null ? null : (
          <p className="font-medium">
            {pauseText(pause, summary.entered, left)}
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
          janela. Se fechar, abra a mesma planilha de novo: o que já entrou não
          é repetido.
        </p>
      ) : null}
      {skippable ? (
        <p className="text-muted-foreground text-support" id={SKIP_HELP_ID}>
          {SKIP_HELP}
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
