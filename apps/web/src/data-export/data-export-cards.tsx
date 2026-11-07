import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
import { Checkbox } from "@/ui/checkbox";
import { Field, FieldError, FieldLabel, FieldSet } from "@/ui/field";
import { connectionControlProps } from "../app-shell/connection-required-notice";
import { DataExportList } from "./data-export-list";
import {
  ALREADY_RUNNING_TEXT,
  type DataExportItem,
  DEFAULT_EXPORT_FORMATS,
  EXPORT_FORMAT_OPTIONS,
  EXPORT_SUPPORT_TEXT,
  type ExportFormat,
  exportView,
  formatsProblem,
  orderedFormats,
  REQUEST_DONE_TEXT,
  type RequestRefusal,
} from "./data-export-model";

const REQUEST_TITLE_ID = "data-export-request-title";
const FORMATS_ERROR_ID = "data-export-formats-error";
const BLOCKED_REASON_ID = "data-export-blocked-reason";

export interface DataExportCalls {
  list: () => Promise<readonly DataExportItem[]>;
  listRefusal: (error: unknown) => string;
  request: (formats: ExportFormat[]) => Promise<{ id: string }>;
  requestRefusal: (error: unknown) => RequestRefusal;
}

/**
 * The list as the server gives it, read when the screen opens and on Atualizar only: the Workers Free plan counts each
 * call, and a copy takes up to an hour, so no timer and no read on focus or on the return of the connection.
 */
function useExportList(calls: DataExportCalls) {
  const [exports, setExports] = useState<readonly DataExportItem[] | null>(
    null
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const latestRead = useRef(0);

  const load = useCallback(async (): Promise<boolean> => {
    latestRead.current += 1;
    const read = latestRead.current;
    setRefreshing(true);
    try {
      const answer = await calls.list();
      if (read !== latestRead.current) {
        return false;
      }
      setExports(answer);
      setLoadError(null);
      return true;
    } catch (error) {
      if (read === latestRead.current) {
        setLoadError(calls.listRefusal(error));
      }
      return false;
    } finally {
      if (read === latestRead.current) {
        setRefreshing(false);
      }
    }
  }, [calls]);

  useEffect(() => {
    load().catch(() => undefined);
    return () => {
      latestRead.current += 1;
    };
  }, [load]);

  const add = useCallback((item: DataExportItem) => {
    // a read sent before the request would answer without it and take it off the screen
    latestRead.current += 1;
    setRefreshing(false);
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

function requestControlProps(online: boolean, blocked: boolean) {
  if (!online) {
    return connectionControlProps(online);
  }
  return blocked
    ? { "aria-describedby": BLOCKED_REASON_ID, "aria-disabled": true as const }
    : {};
}

function refusedForNow(outcome: RequestOutcome): boolean {
  return outcome?.kind === "refused" && outcome.repeatsNow;
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
      {outcome?.kind === "done" ? (
        <p className="text-muted-foreground" role="status">
          {REQUEST_DONE_TEXT}
        </p>
      ) : null}
      {blockedText ? (
        <p className="text-muted-foreground" id={BLOCKED_REASON_ID}>
          {blockedText}
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
  online: boolean;
  outcome: RequestOutcome;
  preparing: boolean;
  request: DataExportCalls["request"];
  requestRefusal: DataExportCalls["requestRefusal"];
  setOutcome: (outcome: RequestOutcome) => void;
}

function RequestCard({
  add,
  online,
  outcome,
  preparing,
  request,
  requestRefusal,
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

  const send = useCallback(async () => {
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
      const { id } = await request(chosen);
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
  }, [add, blocked, formats, online, request, requestRefusal, setOutcome]);

  const handleRequest = useCallback(() => {
    send().catch(() => undefined);
  }, [send]);

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

function RequestClosedCard({ text }: { text: string }) {
  return (
    <Card aria-labelledby={REQUEST_TITLE_ID} role="region">
      <CardHeader>
        <CardTitle aria-level={3} id={REQUEST_TITLE_ID} role="heading">
          Pedir cópia
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p>{text}</p>
      </CardContent>
    </Card>
  );
}

export interface DataExportCardsProps {
  calls: DataExportCalls;
  fileHref: (exportId: string, ordinal: number) => string;
  online: boolean;
  requestClosedText?: string | null;
  timeZone: string;
}

export function DataExportCards({
  calls,
  fileHref,
  online,
  requestClosedText = null,
  timeZone,
}: DataExportCardsProps) {
  const list = useExportList(calls);
  const [outcome, setOutcome] = useState<RequestOutcome>(null);

  const now = Date.now();
  const preparing = (list.exports ?? []).some(
    (item) => exportView(item, now, timeZone).kind === "preparing"
  );

  const { load } = list;
  const refresh = useCallback(() => {
    load()
      .then((read) => {
        if (read) {
          setOutcome(null);
        }
      })
      .catch(() => undefined);
  }, [load]);

  return (
    <>
      {requestClosedText === null ? (
        <RequestCard
          add={list.add}
          online={online}
          outcome={outcome}
          preparing={preparing}
          request={calls.request}
          requestRefusal={calls.requestRefusal}
          setOutcome={setOutcome}
        />
      ) : (
        <RequestClosedCard text={requestClosedText} />
      )}
      <DataExportList
        exports={list.exports}
        fileHref={fileHref}
        loadError={list.loadError}
        now={now}
        online={online}
        onRefresh={refresh}
        refreshing={list.refreshing}
        timeZone={timeZone}
      />
    </>
  );
}
