import { useEffect, useState } from "react";
import type { LogoutWorkspace } from "../offline/logout-guard";
import {
  useOfflineRuntime,
  useRuntimeSnapshot,
} from "../offline/runtime/runtime-context";
import type { QueueCounts, QueueState } from "./closure-model";

const NONE: QueueCounts = { pending: 0, rejected: 0, sending: 0 };

/** What the store's queue on this disk holds, opened only to be read, as "Sair" reads it. */
async function inspectQueue(
  workspaces: readonly LogoutWorkspace[],
  organizationId: string
): Promise<QueueCounts> {
  const counts = { ...NONE };
  try {
    for (const workspace of workspaces) {
      if (workspace.label !== organizationId) {
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: one namespace per store and person
      const queue = await workspace.outbox.snapshot();
      counts.pending += queue.pending;
      counts.rejected += queue.rejected;
      counts.sending += queue.sending;
    }
  } finally {
    await Promise.all(workspaces.map((workspace) => workspace.release?.()));
  }
  return counts;
}

/**
 * The queue of this device for the store, while `active`. A runtime that is ready counts it as it goes; one that is
 * not (the plan without offline, a failed start, an expired access) keeps its figures at zero with the queue still on
 * the disk, so the queue is opened and read once, the way "Sair" does it. No runtime at all (the build without
 * offline) holds no queue.
 */
export function useDeviceQueue(
  organizationId: string,
  active: boolean
): QueueState {
  const runtime = useOfflineRuntime();
  const snapshot = useRuntimeSnapshot();
  const phase = snapshot?.phase ?? null;
  const [inspected, setInspected] = useState<QueueState>({ kind: "unknown" });

  const inspect = Boolean(
    runtime &&
      active &&
      phase !== null &&
      phase !== "ready" &&
      phase !== "starting"
  );
  useEffect(() => {
    if (!(inspect && runtime)) {
      return;
    }
    let current = true;
    setInspected({ kind: "unknown" });
    runtime
      .logoutWorkspaces()
      .then((workspaces) => inspectQueue(workspaces, organizationId))
      .then((counts) => {
        if (current) {
          setInspected({ counts, kind: "counted" });
        }
      })
      .catch(() => {
        if (current) {
          setInspected({ kind: "unreadable" });
        }
      });
    return () => {
      current = false;
    };
  }, [inspect, organizationId, runtime]);

  if (!(runtime && snapshot)) {
    return { counts: NONE, kind: "counted" };
  }
  if (phase === "starting") {
    return { kind: "unknown" };
  }
  if (phase === "ready") {
    return { counts: snapshot.counts, kind: "counted" };
  }
  return inspected;
}
