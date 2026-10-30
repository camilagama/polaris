import { hasCapabilityForRole } from "@polaris/domain/authorization/capabilities";
import { useCallback, useMemo } from "react";
import { Alert, AlertDescription } from "@/ui/alert";
import { useConnectionNoticeForm } from "../app-shell/connection-required-notice";
import { ScreenTitle } from "../app-shell/screen-title";
import { useConnectionOnline } from "../lib/browser-connection";
import { useCurrentOrganization } from "../lib/current-organization";
import { orpcClient } from "../lib/orpc";
import { CloseStoreSection } from "../organization/close-store-section";
import { type DataExportCalls, DataExportCards } from "./data-export-cards";
import {
  exportFileHref,
  listRefusal,
  NO_EXPORT_PERMISSION_TEXT,
  requestRefusal,
} from "./data-export-model";

function Title() {
  return <ScreenTitle>Seus dados</ScreenTitle>;
}

/**
 * Seus dados: the owner asks for a copy of the store's data and downloads it
 * (ADR 0078). Only with `organization:export`; the server refuses the others anyway.
 * At the end, "Encerrar a loja" for whoever holds `organization:close` (ADR 0081).
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

function DataExportScreen({
  organizationId,
  timeZone,
}: {
  organizationId: string;
  timeZone: string;
}) {
  const { organization } = useCurrentOrganization();
  const online = useConnectionOnline();
  useConnectionNoticeForm(true);

  const calls = useMemo<DataExportCalls>(
    () => ({
      list: async () =>
        (await orpcClient.dataExport.list({ organizationId })).exports,
      listRefusal,
      request: (formats) =>
        orpcClient.dataExport.request({ formats, organizationId }),
      requestRefusal,
    }),
    [organizationId]
  );

  const fileHref = useCallback(
    (exportId: string, ordinal: number) =>
      exportFileHref(exportId, ordinal, organizationId),
    [organizationId]
  );

  return (
    <div className="grid gap-4 font-sans text-foreground text-sm antialiased">
      <Title />
      <DataExportCards
        calls={calls}
        fileHref={fileHref}
        online={online}
        timeZone={timeZone}
      />
      {hasCapabilityForRole(organization.role, "organization:close") ? (
        <CloseStoreSection />
      ) : null}
    </div>
  );
}
