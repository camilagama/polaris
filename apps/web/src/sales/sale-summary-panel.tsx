import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
import { type ReactNode, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Card, CardContent } from "@/ui/card";
import { FieldError } from "@/ui/field";
import { focusLater } from "../lib/focus";
import {
  type FeeLine,
  type FeePreview,
  formFieldKeys,
  isSubmitting,
  type SaleEvaluation,
  type SaleSummary,
  type SubmissionState,
  submitButtonLabel,
} from "./sale-form-model";

/* -------------------------------------------------------------------------- */
/* Receipt pieces (DESIGN.md v5.1: the summary is a receipt)                  */
/* -------------------------------------------------------------------------- */

/** An unknown cost or fee: explicit text, italic, dashed border, warning color. Never zero. */
function Unknown({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-sm border border-warning/60 border-dashed px-1.5 py-px font-medium text-warning text-xs italic">
      {children}
    </span>
  );
}

/** A row of the receipt: label, dotted leader, value. A `<div>` with `<dt>` and `<dd>` inside a `<dl>`. */
export function LeaderRow({
  label,
  tone = "normal",
  value,
}: {
  label: string;
  tone?: "discount" | "normal" | "total";
  value: ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="flex min-w-0 flex-1 items-baseline gap-2 after:min-w-4 after:flex-1 after:-translate-y-[3px] after:border-input after:border-b after:border-dotted after:content-['']">
        {label}
      </dt>
      <dd
        className={cn(
          "text-right font-medium tabular-nums",
          tone === "discount" && "text-warning"
        )}
      >
        {value}
      </dd>
    </div>
  );
}

/** The perforation before the total. */
export function Perforation() {
  return (
    <div
      aria-hidden="true"
      className="relative h-0 border-input border-t border-dashed before:absolute before:-top-2 before:-left-2 before:size-4 before:rounded-full before:bg-background before:ring-1 before:ring-foreground/[0.08] after:absolute after:-top-2 after:-right-2 after:size-4 after:rounded-full after:bg-background after:ring-1 after:ring-foreground/[0.08]"
    />
  );
}

const CURRENCY_PREFIX = /^R\$\s*/u;

/** A value in reais: "R$" small and set back, the number in tabular figures. */
function Money({
  className,
  text,
}: {
  className?: string;
  /** As formatBrlAmount writes it: "R$ 1.234,56". */
  text: string;
}) {
  const number = text.replace(CURRENCY_PREFIX, "");
  return (
    <span
      className={cn("inline-flex items-baseline gap-1 tabular-nums", className)}
    >
      <span className="font-medium text-muted-foreground text-xs">R$</span>
      <span>{number}</span>
    </span>
  );
}

export function FeeValue({ line }: { line: FeeLine }) {
  if (line.tone === "unknown") {
    return <Unknown>{line.text}</Unknown>;
  }
  return (
    <span
      className={cn(line.tone === "not_applicable" && "text-muted-foreground")}
    >
      {line.text}
    </span>
  );
}

const UNKNOWN_SETTLEMENT = "prazo desconhecido";

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="[overflow-wrap:anywhere]">{value}</dd>
    </div>
  );
}

function FeePreviewDetails({ preview }: { preview: FeePreview | null }) {
  return (
    <section aria-labelledby="sale-preview-title" className="grid gap-2">
      <h3 className="font-medium" id="sale-preview-title">
        Prévia de taxas e prazo
      </h3>
      <p className="text-muted-foreground text-support">
        O servidor recalcula ao confirmar.
      </p>
      {preview ? (
        <dl className="grid gap-2 text-support">
          <DetailRow label="Perfil de pagamento" value={preview.profileText} />
          <DetailRow
            label="Regra"
            value={
              preview.ruleMatched ? (
                preview.ruleText
              ) : (
                <Unknown>{preview.ruleText}</Unknown>
              )
            }
          />
          <DetailRow
            label="Taxa de processamento"
            value={<FeeValue line={preview.processing} />}
          />
          <DetailRow
            label="Antecipação"
            value={<FeeValue line={preview.anticipation} />}
          />
          <DetailRow
            label="Prazo"
            value={
              preview.settlementText.startsWith(UNKNOWN_SETTLEMENT) ? (
                <Unknown>{preview.settlementText}</Unknown>
              ) : (
                preview.settlementText
              )
            }
          />
        </dl>
      ) : (
        <p className="text-muted-foreground text-support">
          Complete itens, pagamento e perfil para ver a prévia.
        </p>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Failure                                                                    */
/* -------------------------------------------------------------------------- */

interface FailureNoticeProps {
  onDiscardCancel: () => void;
  onDiscardConfirm: () => void;
  onDiscardRequest: () => void;
  /** Keeps a locked sale on this device as the same sale (only when it can carry it). */
  onKeepOnDevice: (() => void) | undefined;
  onRefresh: () => void;
  submission: SubmissionState;
}

/** Shows a failed or locked submission and the actions allowed for it. */
function FailureNotice({
  onDiscardCancel,
  onDiscardConfirm,
  onDiscardRequest,
  onKeepOnDevice,
  onRefresh,
  submission,
}: FailureNoticeProps) {
  if (submission.phase === "failed") {
    return (
      <Alert variant="destructive">
        <TriangleAlertIcon aria-hidden="true" />
        <AlertDescription className="grid min-w-0 justify-items-start gap-2">
          <p className="mb-0!">{submission.failure.message}</p>
          {submission.failure.refreshData ? (
            <Button
              className="h-auto min-h-ctl-sm max-w-full whitespace-normal py-1.5 text-left"
              onClick={onRefresh}
              size="sm"
              type="button"
              variant="outline"
            >
              Atualizar dados e revisar a venda
            </Button>
          ) : null}
        </AlertDescription>
      </Alert>
    );
  }
  if (submission.phase !== "locked") {
    return null;
  }
  return (
    <Alert variant="destructive">
      <TriangleAlertIcon aria-hidden="true" />
      <AlertDescription className="grid min-w-0 justify-items-start gap-2 [&_p]:mb-0!">
        <p>{submission.failure.message}</p>
        {submission.confirmingDiscard ? (
          <>
            <p>
              <strong>Esta venda pode já ter sido registrada.</strong> Se você
              descartá-la e digitar a venda de novo, ela pode ficar duplicada.
              Descarte só se tiver verificado que ela não foi registrada.
            </p>
            <div className="flex min-w-0 flex-wrap gap-2">
              <Button
                className="h-auto min-h-ctl-sm max-w-full whitespace-normal py-1.5 text-left"
                onClick={onDiscardConfirm}
                size="sm"
                type="button"
                variant="destructive"
              >
                Sim, descartar e começar outra
              </Button>
              <Button
                className="h-auto min-h-ctl-sm max-w-full whitespace-normal py-1.5 text-left"
                onClick={onDiscardCancel}
                size="sm"
                type="button"
                variant="outline"
              >
                Voltar
              </Button>
            </div>
          </>
        ) : (
          <>
            {onKeepOnDevice ? (
              <>
                <p className="text-foreground">
                  Sem resposta do servidor, a venda pode ser guardada neste
                  aparelho como a mesma venda: se o servidor já a registrou, ele
                  a reconhece quando o aparelho enviar e nada é duplicado.
                </p>
                <Button
                  className="h-auto min-h-ctl-sm max-w-full whitespace-normal py-1.5 text-left"
                  onClick={onKeepOnDevice}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Guardar esta venda neste aparelho
                </Button>
              </>
            ) : null}
            <Button
              className="h-auto min-h-ctl-sm max-w-full whitespace-normal py-1.5 text-left"
              onClick={onDiscardRequest}
              size="sm"
              type="button"
              variant="outline"
            >
              Descartar esta venda e começar outra
            </Button>
          </>
        )}
      </AlertDescription>
    </Alert>
  );
}

/* -------------------------------------------------------------------------- */
/* Summary                                                                    */
/* -------------------------------------------------------------------------- */

const offlineNote = "Fica guardada aqui e vai quando a conexão voltar.";
const onlineNote = "Vale depois que o servidor confirmar.";

interface SummaryPanelProps {
  errors: Record<string, string>;
  evaluation: SaleEvaluation;
  offline: boolean;
  onDiscardCancel: () => void;
  onDiscardConfirm: () => void;
  onDiscardRequest: () => void;
  onKeepOnDevice: (() => void) | undefined;
  onRefresh: () => void;
  showRequired: boolean;
  submission: SubmissionState;
  summary: SaleSummary | null;
}

export function SummaryPanel({
  errors,
  evaluation,
  offline,
  onDiscardCancel,
  onDiscardConfirm,
  onDiscardRequest,
  onKeepOnDevice,
  onRefresh,
  showRequired,
  submission,
  summary,
}: SummaryPanelProps) {
  const errorCount = Object.keys(errors).length;
  const failureRef = useRef<HTMLDivElement>(null);
  const failed = submission.phase === "failed" || submission.phase === "locked";
  useEffect(() => {
    // Below 900 px the notice sits far above the bar that was tapped: bring it to the person, unless something
    // else took the focus meanwhile (the session notice of a 401, a field).
    if (!failed) {
      return;
    }
    focusLater(() => {
      const active = document.activeElement;
      if (
        active === document.body ||
        active?.getAttribute("type") === "submit"
      ) {
        failureRef.current?.focus();
      }
    });
  }, [failed]);
  const rows = summary?.rows.filter((row) => row.tone !== "total") ?? [];
  const total = summary?.rows.find((row) => row.tone === "total");
  return (
    <aside
      aria-labelledby="sale-summary-title"
      className="min-w-0 min-[900px]:sticky min-[900px]:top-4 min-[900px]:self-start"
    >
      <Card className="gap-0 py-0">
        <CardContent className="grid gap-3 py-(--card-spacing)">
          <h2 className="text-section" id="sale-summary-title">
            Resumo
          </h2>
          {summary ? (
            <dl className="grid gap-2">
              {rows.map((row) => (
                <LeaderRow
                  key={row.key}
                  label={row.label}
                  tone={row.tone}
                  value={row.value}
                />
              ))}
              {rows.length === 1 ? (
                <LeaderRow label="Ajustes" value="nenhum" />
              ) : null}
            </dl>
          ) : (
            <p className="text-muted-foreground text-support">
              Os totais aparecem quando itens e ajustes estiverem válidos.
            </p>
          )}
          <FieldError>{errors[formFieldKeys.totals]}</FieldError>
          <dl className="grid gap-2 text-support">
            <DetailRow
              label="Data e hora da venda"
              value={evaluation.dateText}
            />
            <DetailRow label="Pagamento" value={evaluation.methodText} />
            {/* with the preview, the profile is its first line */}
            {evaluation.feePreview ? null : (
              <DetailRow
                label="Perfil de pagamento"
                value={evaluation.profileText}
              />
            )}
          </dl>
          <FeePreviewDetails preview={evaluation.feePreview} />
        </CardContent>
        {total ? (
          <>
            <Perforation />
            <CardContent className="py-(--card-spacing)">
              <dl aria-atomic="true" aria-live="polite">
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="font-medium text-muted-foreground">
                    {total.label}
                  </dt>
                  <dd>
                    <Money
                      className="font-semibold text-value-lg tracking-[-0.035em]"
                      text={total.value}
                    />
                  </dd>
                </div>
              </dl>
            </CardContent>
          </>
        ) : null}
        <CardContent className="grid gap-3 border-border border-t py-(--card-spacing)">
          {showRequired && errorCount > 0 ? (
            <Alert variant="destructive">
              <TriangleAlertIcon aria-hidden="true" />
              <AlertDescription>
                Corrija {errorCount} {errorCount === 1 ? "campo" : "campos"}{" "}
                antes de confirmar a venda.
              </AlertDescription>
            </Alert>
          ) : null}
          <div
            className="grid rounded-lg outline-none empty:hidden focus-visible:ring-[3px] focus-visible:ring-ring/30"
            ref={failureRef}
            tabIndex={-1}
          >
            <FailureNotice
              onDiscardCancel={onDiscardCancel}
              onDiscardConfirm={onDiscardConfirm}
              onDiscardRequest={onDiscardRequest}
              onKeepOnDevice={onKeepOnDevice}
              onRefresh={onRefresh}
              submission={submission}
            />
          </div>
          {/* below 900 px the button lives in the bar fixed at the bottom (SubmitBar) */}
          <Button
            aria-busy={isSubmitting(submission) || undefined}
            className="w-full max-[899.98px]:hidden"
            disabled={isSubmitting(submission)}
            size="lg"
            type="submit"
          >
            {submitButtonLabel(submission, offline)}
          </Button>
          <p className="text-muted-foreground text-support">
            {offline ? offlineNote : onlineNote}
          </p>
        </CardContent>
      </Card>
    </aside>
  );
}

interface SubmitBarProps {
  offline: boolean;
  submission: SubmissionState;
  summary: SaleSummary | null;
}

/**
 * The total and the button at the bottom of the screen below 900 px. It is sticky inside the form, not fixed to the
 * window: it never covers a field of the form with the keyboard open, and it rests at the end of the form.
 */
export function SubmitBar({ offline, submission, summary }: SubmitBarProps) {
  return (
    <div className="sticky bottom-0 z-10 flex items-center justify-between gap-3 border-border border-t bg-background/95 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] min-[900px]:hidden">
      <div className="grid min-w-0 shrink-0">
        <span className="text-muted-foreground text-xs">Total devido</span>
        {summary ? (
          <Money
            className="font-semibold text-value-md"
            text={summary.rows.find((row) => row.tone === "total")?.value ?? ""}
          />
        ) : (
          <span className="text-muted-foreground text-support">—</span>
        )}
      </div>
      <Button
        aria-busy={isSubmitting(submission) || undefined}
        className="h-auto min-h-ctl-lg min-w-0 shrink whitespace-normal py-1.5"
        disabled={isSubmitting(submission)}
        size="lg"
        type="submit"
      >
        {submitButtonLabel(submission, offline)}
      </Button>
    </div>
  );
}
