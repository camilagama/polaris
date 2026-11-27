import { hasCapabilityForRole } from "@polaris/domain/authorization/capabilities";
import { useCallback, useMemo } from "react";
import { Alert, AlertDescription } from "@/ui/alert";
import { useConnectionNoticeForm } from "../app-shell/connection-required-notice";
import { ScreenTitle, TitleLine } from "../app-shell/screen-title";
import { useConnectionOnline } from "../lib/browser-connection";
import { useCurrentOrganization } from "../lib/current-organization";
import { orpcClient } from "../lib/orpc";
import { readErrorMessage } from "../lib/rpc-error";
import { useIsMobile } from "../lib/use-mobile";
import { CloseStoreSection } from "../organization/close-store-section";
import {
  type EmailPreferenceCalls,
  EmailPreferenceCard,
} from "../settings/email-preference-card";
import { type DataExportCalls, DataExportCards } from "./data-export-cards";
import {
  exportFileHref,
  listRefusal,
  NO_EXPORT_PERMISSION_TEXT,
  requestRefusal,
} from "./data-export-model";

function Title() {
  const phone = useIsMobile();
  return (
    <TitleLine tabNamesIt={!phone}>
      <ScreenTitle>Seus dados</ScreenTitle>
    </TitleLine>
  );
}

/**
 * Seus dados: the owner asks for a copy of the store's data and downloads it
 * (ADR 0078), below the card of the e-mails the person receives (ADR 0106). Only with `organization:export`; the server
 * refuses the others anyway.
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

  const emailCalls = useMemo<EmailPreferenceCalls>(
    () => ({
      read: () => orpcClient.account.emailPreference({ organizationId }),
      readRefusal: (error) =>
        readErrorMessage(error, "as preferências de e-mail"),
      setTips: (on) => orpcClient.account.setTips({ on, organizationId }),
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
      <EmailPreferenceCard calls={emailCalls} online={online} />
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
