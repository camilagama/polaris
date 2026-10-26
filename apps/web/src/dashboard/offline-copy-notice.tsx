import CloudOffIcon from "lucide-react/dist/esm/icons/cloud-off";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { StaleCopyNotice } from "../app-shell/read-wait";
import { copyShownText } from "../lib/read-wait-text";
import { offlineCopyNotice } from "./dashboard-model";

interface OfflineCopyNoticeProps {
  /** When the server read the figures on screen (`generatedAt`). */
  generatedAt: string;
  /**
   * The tab has a connection, and every try of the read failed (paliativo dos 1102): "Não foi possível atualizar
   * agora", with what the copy shows and "Tentar novamente".
   */
  online?: { onRetry: () => void } | undefined;
  timezone: string | null;
  /** Operations kept on this device that are not in the figures. */
  waitingOperations: number;
}

/**
 * Shown when the figures are this device's copy of the last confirmed result
 * because the server could not answer. It says how old they are and that work
 * done since, or not yet sent from this device, is not in them: pending work is
 * only ever mentioned here, never added to the numbers.
 */
export function OfflineCopyNotice({
  generatedAt,
  online,
  timezone,
  waitingOperations,
}: OfflineCopyNoticeProps) {
  const { pending, summary } = offlineCopyNotice(
    generatedAt,
    timezone,
    waitingOperations
  );
  if (online) {
    return (
      <StaleCopyNotice
        onRetry={online.onRetry}
        shown={copyShownText(generatedAt, timezone, new Date())}
      >
        {pending ? <p>{pending}</p> : null}
      </StaleCopyNotice>
    );
  }
  return (
    <Alert variant="warning">
      <CloudOffIcon aria-hidden="true" />
      <AlertTitle>Não foi possível falar com o servidor.</AlertTitle>
      <AlertDescription>
        <p>{summary}</p>
        {pending ? <p>{pending}</p> : null}
      </AlertDescription>
    </Alert>
  );
}
