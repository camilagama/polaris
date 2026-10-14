import { useMemo } from "react";
import type { OfflineRuntime, RuntimeContext } from "./offline-runtime";
import { useOfflineRuntime, useRuntimeSnapshot } from "./runtime-context";

/**
 * What a screen needs to work from this device's collections instead of the
 * network: the runtime (to queue commands and tell the others the data changed)
 * and the stores it opened. It exists only while the runtime is ready AND holds
 * a complete snapshot of the organization, so a screen that gets `null` keeps
 * using the server exactly as before (the runtime is off by default).
 */
export interface LocalWorkspace {
  /** Goes up whenever the local rows may have changed: read them again. */
  dataVersion: number;
  online: boolean;
  runtime: OfflineRuntime;
  /** The stores and the lease at the moment of reading; call `runtime.context()` again when acting. */
  stores: RuntimeContext;
}

export function useLocalWorkspace(
  organizationId: string
): LocalWorkspace | null {
  const runtime = useOfflineRuntime();
  const snapshot = useRuntimeSnapshot();
  const phase = snapshot?.phase ?? "off";
  const bootstrapped = snapshot?.bootstrapped ?? false;
  const dataVersion = snapshot?.dataVersion ?? 0;
  const online = snapshot?.online ?? true;
  return useMemo(() => {
    if (!runtime || phase !== "ready" || !bootstrapped) {
      return null;
    }
    const stores = runtime.context();
    if (!stores || stores.organizationId !== organizationId) {
      return null;
    }
    return { dataVersion, online, runtime, stores };
    // dataVersion is part of the key on purpose: a new version means new rows to read.
  }, [runtime, phase, bootstrapped, dataVersion, online, organizationId]);
}
