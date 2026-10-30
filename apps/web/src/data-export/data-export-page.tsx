import { hasCapabilityForRole } from "@polaris/domain/authorization/capabilities";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
import { Checkbox } from "@/ui/checkbox";
import { Field, FieldError, FieldLabel, FieldSet } from "@/ui/field";
import {
  connectionControlProps,
  useConnectionNoticeForm,
} from "../app-shell/connection-required-notice";
import { ScreenTitle } from "../app-shell/screen-title";
import { useConnectionOnline } from "../lib/browser-connection";
import { useCurrentOrganization } from "../lib/current-organization";
import { orpcClient } from "../lib/orpc";
import { DataExportList } from "./data-export-list";
import {
  ALREADY_RUNNING_TEXT,
  type DataExportItem,
  DEFAULT_EXPORT_FORMATS,
  EXPORT_FORMAT_OPTIONS,
  EXPORT_SUPPORT_TEXT,
  type ExportFormat,
  exportFileHref,
  exportView,
  formatsProblem,
  LIMIT_REACHED_TEXT,
  listRefusal,
  NO_EXPORT_PERMISSION_TEXT,
  orderedFormats,
  REQUEST_DONE_TEXT,
  type RequestRefusal,
  requestRefusal,
} from "./data-export-model";

function Title() {
  return <ScreenTitle>Seus dados</ScreenTitle>;
}

const REQUEST_TITLE_ID = "data-export-request-title";
const FORMATS_ERROR_ID = "data-export-formats-error";
const BLOCKED_REASON_ID = "data-export-blocked-reason";

/**
 * Seus dados (corte exportar-meus-dados-na-configuracao): the owner asks for a copy of the store's data and downloads it
 * (ADR 0078). Only with `organization:export`; the server refuses the others anyway.
 */
export function DataExportPage() {
  const { organization, organizationId } = useCurrentOrganization();
  if (!hasCapabilityForRole(organization.role, "organization:export")) {
    return (
      <div className="grid gap-4 font-sans text-foreground text-sm antialiased">
        <Title />
        <Alert>
          <AlertDescription>{NO_EXPORT_PERMISSION_TEXT}</AlertDescription>
        </Alert>
      </div>
    );
  }
  return (
    <DataExportScreen
      key={organizationId}
      organizationId={organizationId}
      timeZone={organization.timezone}
    />
  );
}

/**
 * The list as the server gives it, read when the screen opens and on Atualizar only: the Workers Free plan counts each
 * call, and a copy takes up to an hour, so no timer and no read on focus or on the return of the connection.
 */
function useExportList(organizationId: string) {
  const [exports, setExports] = useState<DataExportItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const latestRead = useRef(0);

  const load = useCallback(async () => {
    latestRead.current += 1;
    const read = latestRead.current;
    setRefreshing(true);
    try {
      const answer = await orpcClient.dataExport.list({ organizationId });
      if (read === latestRead.current) {
        setExports(answer.exports);
        setLoadError(null);
      }
    } catch (error) {
      if (read === latestRead.current) {
        setLoadError(listRefusal(error));
      }
    } finally {
      if (read === latestRead.current) {
        setRefreshing(false);
      }
    }
  }, [organizationId]);

  useEffect(() => {
    load().catch(() => undefined);
    return () => {
      latestRead.current += 1;
    };
  }, [load]);

  // a copy the server just accepted: shown as it is (preparing) without reading the list again
  const add = useCallback((item: DataExportItem) => {
    setExports((current) => [
      item,
      ...(current ?? []).filter((other) => other.id !== item.id),
    ]);
  }, []);

  return { add, exports, load, loadError, refreshing };
}

type RequestOutcome =
  | { kind: "done" }
  | ({ kind: "refused" } & RequestRefusal)
  | null;

function FormatChoice({
  checked,
  disabled,
  label,
  onToggle,
  value,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onToggle: (value: ExportFormat, checked: boolean) => void;
  value: ExportFormat;
}) {
  const id = `data-export-format-${value}`;
  const handleChange = useCallback(
    (next: boolean) => onToggle(value, next),
    [onToggle, value]
  );
  return (
    <Field orientation="horizontal">
      <Checkbox
        checked={checked}
        disabled={disabled}
        id={id}
        onCheckedChange={handleChange}
      />
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
    </Field>
  );
}

/** Off with a reason (focusable, it says why): no connection, or a copy the server would refuse now. */
function requestControlProps(online: boolean, blocked: boolean) {
  if (!online) {
    return connectionControlProps(online);
  }
  return blocked
    ? { "aria-describedby": BLOCKED_REASON_ID, "aria-disabled": true as const }
    : {};
}

/** Whether the refusal is one that asking again now would only repeat (the button stays off until Atualizar). */
function refusedForNow(outcome: RequestOutcome): boolean {
  return (
    outcome?.kind === "refused" &&
    (outcome.text === LIMIT_REACHED_TEXT ||
      outcome.text === ALREADY_RUNNING_TEXT)
  );
}

function RequestFeedback({
  blockedText,
  outcome,
}: {
  blockedText: string | null;
  outcome: RequestOutcome;
}) {
  return (
    <>
      {blockedText ? (
        <p className="text-muted-foreground" id={BLOCKED_REASON_ID}>
          {blockedText}
        </p>
      ) : null}
      {outcome?.kind === "done" ? (
        <p className="text-muted-foreground" role="status">
          {REQUEST_DONE_TEXT}
        </p>
      ) : null}
      {outcome?.kind === "refused" ? (
        <Alert
          className="w-full"
          id={refusedForNow(outcome) ? BLOCKED_REASON_ID : undefined}
          role="alert"
          variant="destructive"
        >
          <AlertDescription>{outcome.text}</AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

interface RequestCardProps {
  add: (item: DataExportItem) => void;
  /** The list shows a copy in preparation. */
  preparing: boolean;
  online: boolean;
  organizationId: string;
  outcome: RequestOutcome;
  setOutcome: (outcome: RequestOutcome) => void;
}

/** "Pedir cópia": the formats and one `dataExport.request` per tap, never sent again by the screen itself. */
function RequestCard({
  add,
  online,
  organizationId,
  outcome,
  preparing,
  setOutcome,
}: RequestCardProps) {
  const [formats, setFormats] = useState<ReadonlySet<ExportFormat>>(
    () => new Set(DEFAULT_EXPORT_FORMATS)
  );
  const [formatsError, setFormatsError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // a second click lands before React draws the disabled button
  const sendingRef = useRef(false);
  const refused = refusedForNow(outcome);
  // the server keeps one copy in flight: while the list shows one, asking again would only be refused
  const blockedText = preparing && !refused ? ALREADY_RUNNING_TEXT : null;
  const blocked = blockedText !== null || refused;

  const toggle = useCallback((value: ExportFormat, checked: boolean) => {
    setFormats((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(value);
      } else {
        next.delete(value);
      }
      return next;
    });
    setFormatsError(null);
  }, []);

  const request = useCallback(async () => {
    if (!online || sendingRef.current || blocked) {
      return;
    }
    const chosen = orderedFormats(formats);
    const problem = formatsProblem(chosen);
    setFormatsError(problem);
    if (problem) {
      return;
    }
    sendingRef.current = true;
    setSending(true);
    setOutcome(null);
    try {
      const { id } = await orpcClient.dataExport.request({
        formats: chosen,
        organizationId,
      });
      add({
        errorCode: null,
        expiresAt: null,
        files: [],
        formats: chosen,
        id,
        requestedAt: new Date().toISOString(),
        status: "requested",
      });
      setOutcome({ kind: "done" });
    } catch (error) {
      // never sent again from here: an unconfirmed request may exist, and Atualizar shows it
      setOutcome({ kind: "refused", ...requestRefusal(error) });
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [add, blocked, formats, online, organizationId, setOutcome]);

  const handleRequest = useCallback(() => {
    request().catch(() => undefined);
  }, [request]);

  return (
    <Card aria-labelledby={REQUEST_TITLE_ID} role="region">
      <CardHeader>
        <CardTitle aria-level={3} id={REQUEST_TITLE_ID} role="heading">
          Pedir cópia
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p className="text-muted-foreground">{EXPORT_SUPPORT_TEXT}</p>
        <FieldSet
          aria-describedby={formatsError ? FORMATS_ERROR_ID : undefined}
          className="gap-3"
        >
          <legend className="sr-only">Formatos</legend>
          {EXPORT_FORMAT_OPTIONS.map((option) => (
            <FormatChoice
              checked={formats.has(option.value)}
              disabled={sending}
              key={option.value}
              label={option.label}
              onToggle={toggle}
              value={option.value}
            />
          ))}
          <FieldError id={FORMATS_ERROR_ID}>{formatsError}</FieldError>
        </FieldSet>
        <div className="grid justify-items-start gap-3">
          <Button
            aria-busy={sending}
            className="max-sm:w-full"
            disabled={sending}
            onClick={handleRequest}
            {...requestControlProps(online, blocked)}
          >
            Pedir cópia dos dados
          </Button>
          <RequestFeedback blockedText={blockedText} outcome={outcome} />
        </div>
      </CardContent>
    </Card>
  );
}

function DataExportScreen({
  organizationId,
  timeZone,
}: {
  organizationId: string;
  timeZone: string;
}) {
  const online = useConnectionOnline();
  const list = useExportList(organizationId);
  const [outcome, setOutcome] = useState<RequestOutcome>(null);
  useConnectionNoticeForm(true);

  const now = Date.now();
  const preparing = (list.exports ?? []).some(
    (item) => exportView(item, now, timeZone).kind === "preparing"
  );

  const { load } = list;
  const refresh = useCallback(() => {
    setOutcome(null);
    load().catch(() => undefined);
  }, [load]);

  const fileHref = useCallback(
    (exportId: string, ordinal: number) =>
      exportFileHref(exportId, ordinal, organizationId),
    [organizationId]
  );

  return (
    <div className="grid gap-4 font-sans text-foreground text-sm antialiased">
      <Title />
      <RequestCard
        add={list.add}
        online={online}
        organizationId={organizationId}
        outcome={outcome}
        preparing={preparing}
        setOutcome={setOutcome}
      />
      <DataExportList
        exports={list.exports}
        fileHref={fileHref}
        loadError={list.loadError}
        now={now}
        onRefresh={refresh}
        online={online}
        refreshing={list.refreshing}
        timeZone={timeZone}
      />
    </div>
  );
}
