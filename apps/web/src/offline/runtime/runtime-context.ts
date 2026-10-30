import { createContext, useContext, useSyncExternalStore } from "react";
import type { OfflineRuntime, RuntimeSnapshot } from "./offline-runtime";

/**
 * The runtime of the page and the hooks that read it. Kept apart from the
 * provider (which talks to the server) so the components that only display the
 * runtime's state do not drag the network client along.
 */
export const RuntimeContext = createContext<OfflineRuntime | null>(null);

/** The runtime of the page, or null when the offline runtime is not enabled. */
export function useOfflineRuntime(): OfflineRuntime | null {
  return useContext(RuntimeContext);
}

const noSubscription = () => () => undefined;
const noSnapshot = (): RuntimeSnapshot | null => null;

/** The runtime's figures for display; null when the runtime is not enabled. */
export function useRuntimeSnapshot(): RuntimeSnapshot | null {
  const runtime = useOfflineRuntime();
  const read = runtime ? runtime.getSnapshot : noSnapshot;
  // the same reading for a static render of the screen
  return useSyncExternalStore(
    runtime ? runtime.subscribe : noSubscription,
    read,
    read
  );
}
