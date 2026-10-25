import type { BillingPlanView } from "@polaris/contracts";
import { LEGAL_PATHS } from "@polaris/domain/legal/legal-documents";
import CircleAlertIcon from "lucide-react/dist/esm/icons/circle-alert";
import type { ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/ui/card";
import { Progress } from "@/ui/progress";
import { Skeleton } from "@/ui/skeleton";
import {
  keptLine,
  type PlanHeadline,
  paymentLines,
  REFUND_RULE,
  type Refusal,
  refundPendingNotice,
  resubscribeLine,
  SUPPLIER_LINE,
  type UsageRow,
  usageRows,
} from "./subscription-model";

/** The heading of a card that names a section of the screen (the card title is a div, as in the registry). */
export function SectionTitle({
  children,
  id,
}: {
  children: ReactNode;
  id: string;
}) {
  return (
    <h2 className="m-0 text-section" id={id}>
      {children}
    </h2>
  );
}

function UsageBox({ row }: { row: UsageRow }) {
  const summary =
    row.limit === null
      ? `${row.label}: ${row.used}, sem limite`
      : `${row.label}: ${row.used} de ${row.limit}`;
  return (
    <div className="grid gap-1.5 rounded-lg border px-3 py-2.5">
      <p className="m-0 font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {row.label}
      </p>
      <p className="m-0 text-muted-foreground text-sm">
        <span className="font-semibold text-foreground tabular-nums">
          {row.used}
        </span>{" "}
        {row.limit === null ? "sem limite" : `de ${row.limit}`}
      </p>
      {row.limit === null ? null : (
        <Progress
          aria-label={summary}
          max={Math.max(row.limit, 1)}
          value={Math.min(row.used, Math.max(row.limit, 1))}
        />
      )}
    </div>
  );
}

/** The plan in force: the state's title and line, the use of each limit, how it pays and what the store keeps. */
export function PlanCard({
  children,
  headline,
  plan,
}: {
  /** What only some states have (the waiting for the provider), under the plan. */
  children?: ReactNode;
  headline: PlanHeadline;
  plan: BillingPlanView;
}) {
  const payment = paymentLines(plan);
  const resubscribe = resubscribeLine(plan);
  const kept = keptLine(plan.kept);
  const pending = refundPendingNotice(plan);
  const showUsage = plan.state !== "trial_setup";
  return (
    <Card aria-labelledby="subscription-plan-title" role="region">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <SectionTitle id="subscription-plan-title">
            {headline.title}
          </SectionTitle>
          {headline.badge ? (
            <Badge variant={headline.badge.tone}>{headline.badge.text}</Badge>
          ) : null}
        </div>
        {headline.support ? (
          <CardDescription>{headline.support}</CardDescription>
        ) : null}
      </CardHeader>
      {showUsage ? (
        <CardContent>
          <div className="grid gap-2 sm:grid-cols-3">
            {usageRows(plan).map((row) => (
              <UsageBox key={row.id} row={row} />
            ))}
          </div>
        </CardContent>
      ) : null}
      {pending ? (
        <CardContent>
          <Alert variant="warning">
            <AlertTitle>{pending.title}</AlertTitle>
            <AlertDescription>{pending.description}</AlertDescription>
          </Alert>
        </CardContent>
      ) : null}
      {payment ? (
        <CardContent className="grid gap-2 border-t pt-(--card-spacing)">
          <h3 className="m-0 font-medium text-sm">Pagamento</h3>
          <dl className="m-0 grid gap-x-6 gap-y-2 sm:grid-cols-3">
            {payment.map((line) => (
              <div className="grid gap-0.5" key={line.label}>
                <dt className="text-muted-foreground text-xs">{line.label}</dt>
                <dd className="m-0 font-medium tabular-nums">{line.value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      ) : null}
      {resubscribe || kept ? (
        <CardContent className="grid gap-1">
          {resubscribe ? (
            <p className="m-0 text-muted-foreground text-support">
              {resubscribe}
            </p>
          ) : null}
          {kept ? (
            <p className="m-0 text-muted-foreground text-support">{kept}</p>
          ) : null}
        </CardContent>
      ) : null}
      {children}
    </Card>
  );
}

/** The plan while it loads: the shapes of the card, and a line the screen reader reads. */
export function PlanLoading() {
  return (
    <Card aria-busy="true">
      <CardHeader>
        <p className="sr-only" role="status">
          Carregando a assinatura…
        </p>
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-56" />
      </CardHeader>
      <CardContent>
        <div className="grid gap-2 sm:grid-cols-3">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      </CardContent>
    </Card>
  );
}

/** The plan could not be read: what happened, and "Tentar novamente" when it may help. */
export function PlanLoadError({
  onRetry,
  refusal,
}: {
  onRetry: () => void;
  refusal: Refusal;
}) {
  return (
    <Alert variant="destructive">
      <CircleAlertIcon aria-hidden="true" />
      <AlertTitle>Não foi possível carregar a assinatura.</AlertTitle>
      <AlertDescription className="grid justify-items-start gap-2">
        {refusal.text}
        {refusal.retry ? (
          <Button onClick={onRetry} size="sm" type="button" variant="outline">
            Tentar novamente
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

/** The rule of the refund, the supplier, and the Terms and the Privacy Policy (AS-14). */
export function SubscriptionFooter() {
  const link =
    "touch-hit focus-ring rounded-sm underline decoration-input underline-offset-4 hover:decoration-foreground";
  return (
    <footer className="grid gap-1 text-muted-foreground text-support">
      <p className="m-0">
        {REFUND_RULE} {SUPPLIER_LINE}
      </p>
      <p className="m-0">
        <a
          className={link}
          href={LEGAL_PATHS.terms}
          rel="noopener noreferrer"
          target="_blank"
        >
          Termos de Uso
        </a>{" "}
        ·{" "}
        <a
          className={link}
          href={LEGAL_PATHS.privacy}
          rel="noopener noreferrer"
          target="_blank"
        >
          Política de Privacidade
        </a>
      </p>
    </footer>
  );
}
