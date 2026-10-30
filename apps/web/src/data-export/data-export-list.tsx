import { type MouseEvent, useCallback } from "react";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button, buttonVariants } from "@/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
import { connectionControlProps } from "../app-shell/connection-required-notice";
import {
  type DataExportItem,
  type ExportView,
  exportView,
  NO_EXPORTS_TEXT,
} from "./data-export-model";

export interface DataExportListProps {
  /** Null until the first read answered. */
  exports: readonly DataExportItem[] | null;
  /** The address of a file: the store's route, or the closed store's (`/api/closed-exports/...`). */
  fileHref: (exportId: string, ordinal: number) => string;
  /** A failed read, already as text. */
  loadError: string | null;
  /** The instant "pronta" and "expirada" are judged at. */
  now: number;
  online: boolean;
  /** Reads the list again: the only way it changes besides opening the screen (no timer, no read on focus). */
  onRefresh: () => void;
  refreshing: boolean;
  /** The store's time zone, for the dates. */
  timeZone: string;
}

const TITLE_ID = "data-export-list-title";

function stopOffline(event: MouseEvent<HTMLAnchorElement>) {
  event.preventDefault();
}

function ExportEntry({
  fileHref,
  online,
  view,
}: {
  fileHref: DataExportListProps["fileHref"];
  online: boolean;
  view: ExportView;
}) {
  return (
    <li
      className="grid min-w-0 gap-2 border-border border-t py-3 [overflow-wrap:anywhere] first:border-t-0 first:pt-0 last:pb-0"
      data-export-state={view.kind}
    >
      <div className="grid gap-0.5">
        <p className="font-medium">{view.requested}</p>
        <p className="text-muted-foreground text-support">{view.formats}</p>
      </div>
      <p>{view.text}</p>
      {view.files.length > 0 ? (
        <ul className="flex flex-wrap gap-3">
          {view.files.map((file) => (
            <li className="min-w-0 max-w-full" key={file.ordinal}>
              <a
                className={cn(
                  buttonVariants({ variant: "outline" }),
                  "h-auto min-h-ctl-md max-w-full whitespace-normal py-1.5 text-left [overflow-wrap:anywhere]"
                )}
                href={fileHref(view.id, file.ordinal)}
                onClick={online ? undefined : stopOffline}
                {...connectionControlProps(online)}
              >
                {file.label}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * "Suas cópias": the copies the server lists, each with what is true of it now, and a link per file to the route that
 * streams it (the screen never reads a file into the tab). Used by Configurações and, with the closed store's route,
 * by the panel of a closed store.
 */
export function DataExportList({
  exports,
  fileHref,
  loadError,
  now,
  onRefresh,
  online,
  refreshing,
  timeZone,
}: DataExportListProps) {
  const handleRefresh = useCallback(() => {
    if (online && !refreshing) {
      onRefresh();
    }
  }, [online, onRefresh, refreshing]);
  return (
    <Card aria-labelledby={TITLE_ID} role="region">
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle aria-level={3} id={TITLE_ID} role="heading">
          Suas cópias
        </CardTitle>
        <Button
          aria-busy={refreshing}
          disabled={refreshing}
          onClick={handleRefresh}
          size="sm"
          variant="outline"
          {...connectionControlProps(online)}
        >
          Atualizar
        </Button>
      </CardHeader>
      <CardContent className="grid min-w-0 gap-3">
        {loadError ? (
          <Alert role="alert" variant="destructive">
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        ) : null}
        {exports !== null && exports.length === 0 ? (
          <p className="text-muted-foreground">{NO_EXPORTS_TEXT}</p>
        ) : null}
        {exports !== null && exports.length > 0 ? (
          <ul className="grid min-w-0">
            {exports.map((item) => (
              <ExportEntry
                fileHref={fileHref}
                key={item.id}
                online={online}
                view={exportView(item, now, timeZone)}
              />
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
