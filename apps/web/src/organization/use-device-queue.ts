import { useEffect, useState } from "react";
import type { LogoutWorkspace } from "../offline/logout-guard";
import { anyOutboxOnDisk } from "../offline/outbox/outbox-on-disk";
import {
  useOfflineRuntime,
  useRuntimeSnapshot,
} from "../offline/runtime/runtime-context";
import { type ClosedQueue, emptyKinds, kindOf } from "./closed-queue-model";
import type { QueueCounts, QueueState } from "./closure-model";

const NONE: QueueCounts = { pending: 0, rejected: 0, sending: 0 };

/**
 * No workspace at all is also what the runtime gives when it could not name the signed-in person: with a queue on
 * the disk, that is a queue nobody read, never an empty one.
 */
export async function readClosedQueueOnDisk(
  workspaces: readonly LogoutWorkspace[],
  organizationId: string,
  outboxOnDisk: () => Promise<boolean> = anyOutboxOnDisk
): Promise<ClosedQueue> {
  if (workspaces.length === 0) {
    return (await outboxOnDisk())
      ? { kind: "unreadable" }
      : { counts: { ...NONE }, kind: "counted", kinds: emptyKinds() };
  }
  const counts = { ...NONE };
  const kinds = emptyKinds();
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
      for (const command of queue.commands) {
        kinds[kindOf(command.type)] += 1;
      }
    }
  } finally {
    await Promise.all(workspaces.map((workspace) => workspace.release?.()));
  }
  return { counts, kind: "counted", kinds };
}

export async function readQueueOnDisk(
  workspaces: readonly LogoutWorkspace[],
  organizationId: string,
  outboxOnDisk: () => Promise<boolean> = anyOutboxOnDisk
): Promise<QueueState> {
  const queue = await readClosedQueueOnDisk(
    workspaces,
    organizationId,
    outboxOnDisk
  );
  return queue.kind === "counted"
    ? { counts: queue.counts, kind: "counted" }
    : queue;
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
      .then((state) => {
        if (current) {
          setInspected(state);
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
