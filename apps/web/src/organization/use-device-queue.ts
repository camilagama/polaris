import { useEffect, useState } from "react";
import type { LogoutWorkspace } from "../offline/logout-guard";
import {
  useOfflineRuntime,
  useRuntimeSnapshot,
} from "../offline/runtime/runtime-context";
import type { QueueCounts, QueueState } from "./closure-model";

const NONE: QueueCounts = { pending: 0, rejected: 0, sending: 0 };

async function readQueueOnDisk(
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

export function useDeviceQueue(
  organizationId: string,
  active: boolean
): QueueState {
  const runtime = useOfflineRuntime();
  const snapshot = useRuntimeSnapshot();
  const phase = snapshot?.phase ?? null;
  const [inspected, setInspected] = useState<QueueState>({ kind: "unknown" });

  const countsOnlyOnDisk = Boolean(
    runtime &&
      active &&
      phase !== null &&
      phase !== "ready" &&
      phase !== "starting"
  );
  useEffect(() => {
    if (!(countsOnlyOnDisk && runtime)) {
      return;
    }
    let current = true;
    setInspected({ kind: "unknown" });
    runtime
      .logoutWorkspaces()
      .then((workspaces) => readQueueOnDisk(workspaces, organizationId))
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
  }, [countsOnlyOnDisk, organizationId, runtime]);

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
