import { offlineCopyNotice } from "./dashboard-model";

interface OfflineCopyNoticeProps {
  /** When the server read the figures on screen (`generatedAt`). */
  generatedAt: string;
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
  timezone,
  waitingOperations,
}: OfflineCopyNoticeProps) {
  const { pending, summary } = offlineCopyNotice(
    generatedAt,
    timezone,
    waitingOperations
  );
  return (
    <div className="categories-message is-warning" role="status">
      <p className="dashboard-copy-notice">{summary}</p>
      {pending ? <p className="dashboard-copy-notice">{pending}</p> : null}
    </div>
  );
}
