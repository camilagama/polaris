import CircleAlertIcon from "lucide-react/dist/esm/icons/circle-alert";
import PackagePlusIcon from "lucide-react/dist/esm/icons/package-plus";
import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  MASKED_MONEY,
  MASKED_SPOKEN,
  useHiddenValues,
} from "@/lib/hidden-values";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button, buttonVariants } from "@/ui/button";
import { Card, CardContent } from "@/ui/card";
import { FieldError } from "@/ui/field";
import { MoneyText } from "@/ui/hidden-values";
import { stockEntryHref } from "../inventory/stock-entry-link";
import { focusLater } from "../lib/focus";
import {
  type FeeLine,
  type FeePreview,
  formFieldKeys,
  isSubmitting,
  type SaleEvaluation,
  type SaleSummary,
  type SplitEvaluation,
  type SubmissionState,
  submitButtonLabel,
} from "./sale-form-model";
import type { SplitBalance } from "./sale-split-model";

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
  mono = false,
  tone = "normal",
  value,
}: {
  label: string;
  /** The value in Geist Mono (the receipt of the confirmed sale): wider than Geist, so the leader gives up its minimum to the value. */
  mono?: boolean;
  tone?: "discount" | "normal" | "total";
  value: ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <dt
        className={cn(
          "flex min-w-0 flex-1 items-baseline gap-2 after:flex-1 after:-translate-y-0.75 after:border-input after:border-b after:border-dotted after:content-['']",
          mono ? "after:min-w-0" : "after:min-w-4"
        )}
      >
        {label}
      </dt>
      <dd
        className={cn(
          "text-right font-medium tabular-nums",
          mono && "font-mono",
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
      className="relative h-0 overflow-x-clip border-input border-t border-dashed before:absolute before:-top-2 before:-left-2 before:size-4 before:rounded-full before:bg-background before:ring-1 before:ring-foreground/[0.08] after:absolute after:-top-2 after:-right-2 after:size-4 after:rounded-full after:bg-background after:ring-1 after:ring-foreground/[0.08]"
      data-receipt-perforation=""
    />
  );
}

const CURRENCY_PREFIX = /^R\$\s*/u;

/** A value in reais: "R$" small and set back, the number in tabular figures. */
export function Money({
  className,
  text,
}: {
  className?: string;
  /** As formatBrlAmount writes it: "R$ 1.234,56". */
  text: string;
}) {
  const [hidden] = useHiddenValues();
  if (hidden) {
    return (
      <>
        <span
          aria-hidden="true"
          className={cn("whitespace-nowrap tabular-nums", className)}
          data-masked-money=""
        >
          {MASKED_MONEY}
        </span>
        <span className="sr-only">{MASKED_SPOKEN}</span>
      </>
    );
  }
  const number = text.replace(CURRENCY_PREFIX, "");
  return (
    <span
      className={cn(
        "inline-flex items-baseline gap-1 whitespace-nowrap tabular-nums",
        className
      )}
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
      <MoneyText text={line.text} />
    </span>
  );
}

/** The amount fields of the parts: the live texts wait until the focus leaves them, so typing is not read out. */
const SPLIT_AMOUNT_ID = /^sale-part-[12]-amount$/;

/**
 * The text a live region reads: it follows `text`, but while the person types in an amount of a part it waits for the
 * focus to leave the field, so a screen reader hears each change once and not at every key.
 */
export function useSettledText(text: string): string {
  const [settled, setSettled] = useState(text);
  useEffect(() => {
    const typing = SPLIT_AMOUNT_ID.test(document.activeElement?.id ?? "");
    if (!typing) {
      setSettled(text);
      return;
    }
    const settle = () => setSettled(text);
    document.addEventListener("focusout", settle, { once: true });
    return () => document.removeEventListener("focusout", settle);
  }, [text]);
  return settled;
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

/**
 * The preview changes when the payment profile (or any value) does, and the person at the screen reader would not
 * hear it: its values sit in a live region that is in the tree before the content changes (P-4), like the total.
 */
export function FeePreviewDetails({ preview }: { preview: FeePreview | null }) {
  return (
    <section
      aria-labelledby={preview ? "sale-preview-title" : undefined}
      className="grid gap-2"
    >
      {preview ? (
        <>
          <h3 className="font-medium" id="sale-preview-title">
            Prévia de taxas e prazo
          </h3>
          <p className="text-muted-foreground text-support">
            O servidor recalcula ao confirmar.
          </p>
        </>
      ) : null}
      <div aria-atomic="true" aria-live="polite" className="grid">
        {preview ? (
          <dl className="grid gap-2 text-support">
            <DetailRow
              label="Perfil de pagamento"
              value={preview.profileText}
            />
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
        ) : null}
      </div>
    </section>
  );
}

/** What the live region of the parts reads once the person leaves an amount: each part's fee and term, then the sum. */
function partsSentence(split: SplitEvaluation): string {
  const parts = split.partPreviews.map((preview, index) =>
    preview === null
      ? null
      : `Parte ${index + 1}: taxa ${preview.processing.text}, ${preview.settlementText}.`
  );
  const total =
    split.feesTotal === null
      ? null
      : `Taxas das duas partes: ${split.feesTotal.text}.`;
  return [...parts, total].filter(Boolean).join(" ");
}

/**
 * The summary of a sale paid in two parts: a group per part (method and amount, then its profile, fee and term) and
 * the fees of both parts added up, unknown when either is. Typing in an amount changes these values at every key; the
 * live region reads them once the focus leaves the field.
 */
function SplitPaymentDetails({ split }: { split: SplitEvaluation }) {
  const announced = useSettledText(partsSentence(split));
  return (
    <section aria-labelledby="sale-parts-title" className="grid gap-3">
      <h3 className="font-medium" id="sale-parts-title">
        Pagamento em 2 partes
      </h3>
      {split.parts.map((part, index) => {
        const preview = split.partPreviews[index] ?? null;
        const ordinal = index + 1;
        return (
          <div className="grid gap-1.5" key={ordinal}>
            <dl className="grid">
              <LeaderRow
                label={`Parte ${ordinal} · ${part.methodText}`}
                value={
                  part.amountText === null ? (
                    "—"
                  ) : (
                    <MoneyText text={part.amountText} />
                  )
                }
              />
            </dl>
            {preview ? (
              <dl className="grid gap-1 text-support">
                <DetailRow
                  label="Perfil de pagamento"
                  value={preview.profileText}
                />
                <DetailRow
                  label="Taxa de processamento"
                  value={<FeeValue line={preview.processing} />}
                />
                {preview.anticipation.tone === "not_applicable" ? null : (
                  <DetailRow
                    label="Antecipação"
                    value={<FeeValue line={preview.anticipation} />}
                  />
                )}
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
            ) : null}
          </div>
        );
      })}
      {split.feesTotal === null ? null : (
        <dl className="grid">
          <LeaderRow
            label="Taxas das duas partes"
            value={<FeeValue line={split.feesTotal} />}
          />
        </dl>
      )}
      <p className="text-muted-foreground text-support">
        O servidor recalcula ao confirmar.
      </p>
      <p aria-atomic="true" aria-live="polite" className="sr-only">
        {announced}
      </p>
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
          {submission.failure.entry === null ? null : (
            <a
              className={cn(
                buttonVariants({ size: "sm", variant: "outline" }),
                "h-auto min-h-ctl-sm max-w-full whitespace-normal py-1.5 text-left"
              )}
              href={stockEntryHref(
                submission.failure.entry.variantId,
                submission.failure.entry.missing
              )}
            >
              <PackagePlusIcon aria-hidden="true" data-icon="inline-start" />
              Dar entrada no estoque
              <span className="sr-only">
                {" "}
                de {submission.failure.entry.label}
              </span>
            </a>
          )}
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
            {/* the safe button is the submit button below (the bar in one column): it comes first, the discard last */}
            <p className="text-foreground">
              Para repetir a mesma venda, toque em “Tentar novamente (seguro)”,
              abaixo. Repetir é seguro.
            </p>
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
    // In one column the notice sits far above the bar that was tapped: bring it to the person, unless something
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
      className="@[44rem]/sale:sticky @[44rem]/sale:top-4 min-w-0 @[44rem]/sale:self-start"
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
                  value={<MoneyText text={row.value} />}
                />
              ))}
            </dl>
          ) : (
            <p className="text-muted-foreground text-support">
              Os totais aparecem quando itens e ajustes estiverem válidos.
            </p>
          )}
          <FieldError>{errors[formFieldKeys.totals]}</FieldError>
          {/* only what was chosen: a typed date, the method, the profile (with the preview, its first line) */}
          <dl className="grid gap-2 text-support empty:hidden">
            {evaluation.occurredAtOverride === null ? null : (
              <DetailRow
                label="Data e hora da venda"
                value={evaluation.dateText}
              />
            )}
            {evaluation.methodChosen && !evaluation.split ? (
              <DetailRow label="Pagamento" value={evaluation.methodText} />
            ) : null}
            {evaluation.feePreview ||
            !evaluation.profileChosen ||
            evaluation.split ? null : (
              <DetailRow
                label="Perfil de pagamento"
                value={evaluation.profileText}
              />
            )}
          </dl>
          {evaluation.split ? (
            <SplitPaymentDetails split={evaluation.split} />
          ) : (
            <FeePreviewDetails preview={evaluation.feePreview} />
          )}
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
          {/* in one column the button lives in the bar fixed at the bottom (SubmitBar) */}
          <Button
            aria-busy={isSubmitting(submission) || undefined}
            className="@[44rem]/sale:inline-flex hidden w-full"
            disabled={isSubmitting(submission)}
            size="xl"
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
  /** The state of the parts of a split sale: "Falta R$ X" or "Passou R$ X" under the total while they do not close it. */
  balance: SplitBalance | null;
  offline: boolean;
  submission: SubmissionState;
  summary: SaleSummary | null;
}

/**
 * The total and the button at the bottom of the screen in one column (the sale container under 44 rem). It is sticky
 * inside the form, not fixed to the window: it never covers a field of the form with the keyboard open, and it rests at
 * the end of the form. Its background is opaque (U-19): a translucent one let an error behind it show through and read
 * as noise; what takes the focus inside the form keeps a `scroll-margin-bottom` for it (styles/index.css), so a
 * focused field or error scrolls above it.
 */
export function SubmitBar({
  balance,
  offline,
  submission,
  summary,
}: SubmitBarProps) {
  return (
    <div
      className="sticky bottom-[var(--app-bottom-bar,0rem)] z-10 flex @[44rem]/sale:hidden items-center justify-between gap-3 border-border border-t bg-background py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      data-submit-bar=""
    >
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
        {balance === null || balance.kind === "closed" ? null : (
          <span
            className="flex items-center gap-1 font-medium text-support text-warning"
            data-split-bar-balance=""
          >
            <CircleAlertIcon aria-hidden="true" className="size-3.5 shrink-0" />
            {balance.text}
          </span>
        )}
      </div>
      <Button
        aria-busy={isSubmitting(submission) || undefined}
        className="h-auto min-h-ctl-xl min-w-0 shrink whitespace-normal py-1.5"
        disabled={isSubmitting(submission)}
        size="xl"
        type="submit"
      >
        {submitButtonLabel(submission, offline)}
      </Button>
    </div>
  );
}
