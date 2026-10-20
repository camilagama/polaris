/**
 * Operational alert signals (plan PR119, ADR 0095): what to watch, in which
 * event, over what window, at which threshold, how bad it is, whether it wakes
 * someone and where the procedure is. It is a registry of definitions, not an
 * alert: nothing here creates a rule in a service. When there is an
 * environment, whoever runs the alerts (ADR 0095) reads this list; a test
 * checks that every event named here is emitted by the code, so a signal never
 * points to an event that does not exist.
 *
 * Event and field names follow the canonical schema (ADR 0091, `fields.ts`);
 * the events carry no personal data (ADR 0089, redaction policy).
 */

export const alertSeverities = ["critical", "warning"] as const;

export type AlertSeverity = (typeof alertSeverities)[number];

/**
 * - `wake`: reaches a person at once (e-mail), day or night.
 * - `report`: only shows in the daily report; someone reads it the next morning.
 */
export type AlertNotify = "report" | "wake";

export type AlertThreshold =
  /** Fires when the events (after `where`) total at least `atLeast` in the window. */
  | { atLeast: number; kind: "count" }
  /** Fires when none of the events (after `where`) appears in the window: the heartbeat of a job. */
  | { kind: "absence" }
  /** Fires when the p95 of `durationMs` of a route is above its `p95Ms` in `criticalRoutes`, with at least `minSamples` requests. */
  | { kind: "p95Ms"; minSamples: number };

export interface AlertSignal {
  /** Lowercase identifier; also the heading of its procedure in `docs/runbooks/alertas.md` (`#<id>`). */
  readonly id: string;
  readonly notify: AlertNotify;
  readonly severity: AlertSeverity;
  /** Events the signal reads (any of them counts), spelled as the code emits them. */
  readonly source: {
    readonly events: readonly string[];
    /** The filter on the fields of those events, in the words of the Workers Logs query. */
    readonly where?: string;
  };
  readonly threshold: AlertThreshold;
  readonly title: string;
  readonly windowMinutes: number;
}

/**
 * The routes whose latency is watched, by the label the `http_request_timed`
 * event carries in `route` (a Hono pattern, or `/rpc/<procedure>` for oRPC),
 * with the p95 limit in milliseconds of wall-clock time. The limits are a
 * first guess with no measurement behind them: they are revised with the real
 * numbers in Phase 14 (ADR 0095).
 */
export const criticalRoutes = [
  { p95Ms: 1500, route: "/rpc/sale/confirm" },
  { p95Ms: 3000, route: "/rpc/sync/push" },
  { p95Ms: 2000, route: "/rpc/sync/pull" },
  { p95Ms: 3000, route: "/rpc/sync/bootstrapPage" },
  { p95Ms: 1500, route: "/api/auth/*" },
  { p95Ms: 8000, route: "/api/products/:productId/media" },
] as const satisfies readonly { p95Ms: number; route: string }[];

export type CriticalRoute = (typeof criticalRoutes)[number]["route"];

const criticalRouteLimits: ReadonlyMap<string, number> = new Map(
  criticalRoutes.map(({ p95Ms, route }) => [route, p95Ms])
);

/** True when the route is one of `criticalRoutes` (the only ones that emit `http_request_timed`). */
export function isCriticalRoute(route: string): route is CriticalRoute {
  return criticalRouteLimits.has(route);
}

export const alertSignals = [
  {
    id: "http-5xx",
    notify: "wake",
    severity: "critical",
    source: {
      events: ["server_error"],
      where: "httpStatus >= 500",
    },
    threshold: { atLeast: 5, kind: "count" },
    title: "Respostas 5xx",
    windowMinutes: 15,
  },
  {
    id: "latencia-p95",
    notify: "report",
    severity: "warning",
    source: {
      events: ["http_request_timed"],
      where: 'route in criticalRoutes and outcome != "rejected"',
    },
    threshold: { kind: "p95Ms", minSamples: 20 },
    title: "Latência p95 em rota crítica",
    windowMinutes: 30,
  },
  {
    id: "dlq",
    notify: "report",
    severity: "warning",
    source: {
      events: [
        "queue_dead_letter_recorded",
        "queue_dead_letter_not_recorded",
        "queue_dead_letter_send_failed",
        "outbox_events_exhausted",
      ],
    },
    threshold: { atLeast: 3, kind: "count" },
    title: "DLQ crescendo",
    windowMinutes: 60,
  },
  {
    id: "outbox-parado",
    notify: "wake",
    severity: "critical",
    source: {
      events: ["scheduled_job_run"],
      where: 'job = "outbox.dispatch" and outcome = "success"',
    },
    threshold: { kind: "absence" },
    title: "Outbox parado (o despachante não conclui)",
    windowMinutes: 180,
  },
  {
    id: "outbox-falhando",
    notify: "report",
    severity: "warning",
    source: {
      events: ["outbox_send_failed", "outbox_event_unsendable"],
    },
    threshold: { atLeast: 1, kind: "count" },
    title: "Envio do outbox à fila falhando",
    windowMinutes: 120,
  },
  {
    id: "cobranca-reconcile",
    notify: "wake",
    severity: "critical",
    source: {
      events: [
        "billing_maintenance_incomplete",
        "billing_sweep_failed",
        "billing_event_retry_failed",
        "billing_grant_sweep_failed",
        "billing_webhook_processing_failed",
      ],
    },
    threshold: { atLeast: 3, kind: "count" },
    title: "Falha de reconcile da cobrança",
    windowMinutes: 180,
  },
  {
    id: "erros-de-banco",
    notify: "wake",
    severity: "critical",
    source: {
      events: [
        "server_error",
        "scheduler_state_unavailable",
        "queue_ledger_unavailable",
      ],
      where: "sqlState exists, or the event is not server_error",
    },
    threshold: { atLeast: 3, kind: "count" },
    title: "Erros de banco",
    windowMinutes: 15,
  },
  {
    id: "agendador-falhando",
    notify: "report",
    severity: "warning",
    source: {
      events: [
        "scheduled_job_claim_failed",
        "scheduled_job_record_failed",
        "scheduled_job_handler_missing",
        "scheduled_job_run",
      ],
      where: 'outcome = "failure"',
    },
    threshold: { atLeast: 2, kind: "count" },
    title: "Jobs agendados falhando",
    windowMinutes: 180,
  },
  {
    id: "r2-e-midia",
    notify: "report",
    severity: "warning",
    source: {
      events: [
        "media_removed_asset_failed",
        "media_removed_asset_not_finalized",
        "media_removed_reconciliation_incomplete",
        "catalog_media_read_failed",
      ],
    },
    threshold: { atLeast: 1, kind: "count" },
    title: "Falha do R2 ou da mídia",
    windowMinutes: 60,
  },
  {
    id: "cota-de-transformacao",
    notify: "report",
    severity: "warning",
    source: {
      events: ["media_transform_quota_exceeded"],
      where: 'errorCode = "9422"',
    },
    threshold: { atLeast: 1, kind: "count" },
    title: "Cota de transformações do Images esgotada (9422)",
    windowMinutes: 60,
  },
  {
    id: "rejeicao-no-sync",
    notify: "report",
    severity: "warning",
    source: {
      events: ["sync_push_command_rejected"],
      where:
        'reason in ("session_changed", "lease_invalid", "authorization_revoked")',
    },
    threshold: { atLeast: 10, kind: "count" },
    title: "Pico de rejeição no sync offline",
    windowMinutes: 15,
  },
  {
    id: "registro-de-acesso",
    notify: "wake",
    severity: "critical",
    source: {
      events: ["auth_access_log_write_failed"],
    },
    threshold: { atLeast: 3, kind: "count" },
    title: "Falha ao gravar o registro de acesso",
    windowMinutes: 15,
  },
  {
    id: "apagamento-automatico",
    notify: "wake",
    severity: "critical",
    source: {
      events: ["closure_auto_purge_volume_high"],
    },
    threshold: { atLeast: 1, kind: "count" },
    title:
      "Mais de 5 lojas encerradas entraram no apagamento automático em um dia",
    windowMinutes: 1440,
  },
  {
    id: "loja-encerrada-parada",
    notify: "report",
    severity: "warning",
    source: {
      events: ["closure_purge_overdue"],
    },
    threshold: { atLeast: 1, kind: "count" },
    title:
      "Loja encerrada parada: sem apagamento 30 dias depois de D, purge preso ou aviso sem entregar",
    windowMinutes: 1440,
  },
] as const satisfies readonly AlertSignal[];

export type AlertSignalId = (typeof alertSignals)[number]["id"];

/** Every event name the registry reads, once each. */
export function alertSourceEvents(): string[] {
  return [
    ...new Set(alertSignals.flatMap((signal) => signal.source.events)),
  ].sort();
}
