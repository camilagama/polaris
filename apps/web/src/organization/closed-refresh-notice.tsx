import { useEffect, useRef } from "react";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import {
  PANEL_REFRESH_FAILED_TEXT,
  PANEL_REFRESH_RETRY,
  PANEL_REFRESHING,
} from "./closed-store-model";

export const OFFLINE_ID = "closed-store-offline";

export const offlineOff = (online: boolean) =>
  online
    ? {}
    : { "aria-describedby": OFFLINE_ID, "aria-disabled": true as const };

export const refreshButtonProps = (
  online: boolean,
  reading: boolean,
  onRefresh: () => void
) => ({
  onClick: reading ? undefined : onRefresh,
  ...offlineOff(online),
  ...(reading ? { "aria-disabled": true as const } : {}),
});

export function RefreshFailedNotice({
  online,
  onRefresh,
  reading,
}: {
  online: boolean;
  onRefresh: () => void;
  reading: boolean;
}) {
  const retry = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    retry.current?.focus();
  }, []);
  return (
    <Alert role="alert" variant="warning">
      <AlertDescription className="grid gap-3">
        <span>{PANEL_REFRESH_FAILED_TEXT}</span>
        <Button
          className="w-fit max-sm:w-full"
          ref={retry}
          variant="outline"
          {...refreshButtonProps(online, reading, onRefresh)}
        >
          {reading ? PANEL_REFRESHING : PANEL_REFRESH_RETRY}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
