/**
 * Which tab of this browser pulls on the scheduler's tick: the one holding the Web Lock of the store. A tab
 * asks for it while it can lead (its page is visible and its runtime is open) and lets it go otherwise, so
 * the lock passes to the next tab in line; the other tabs hear the leader's pull through the data channel.
 * One pull per tick per browser, however many tabs are open. Without Web Locks every tab is its own leader
 * (the tick of each tab, as before). Framework-free, with the lock manager and the page injected.
 */
interface LockManagerLike {
  request: (
    name: string,
    options: { signal: AbortSignal },
    callback: () => Promise<void>
  ) => Promise<unknown>;
}

export interface SyncLeadershipOptions {
  /** Whether this tab can pull now: a tab that cannot must not hold the lock the others wait for. */
  canLead: () => boolean;
  locks: LockManagerLike | undefined;
  name: string;
  /** Calls the listener whenever `canLead` may have changed; returns how to stop. */
  onChange: (listener: () => void) => () => void;
}

export interface SyncLeadership {
  isLeader: () => boolean;
  stop: () => void;
}

export function holdSyncLeadership(
  options: SyncLeadershipOptions
): SyncLeadership {
  const { locks, name } = options;
  if (typeof locks?.request !== "function") {
    return { isLeader: () => true, stop: () => undefined };
  }
  let leader = false;
  let stopped = false;
  // the request on its way or the lock held; aborting it gives up a request not yet granted
  let wanting: AbortController | null = null;
  let release: (() => void) | null = null;

  const want = () => {
    if (wanting || stopped) {
      return;
    }
    const controller = new AbortController();
    wanting = controller;
    locks
      .request(
        name,
        { signal: controller.signal },
        () =>
          new Promise<void>((resolve) => {
            if (controller.signal.aborted) {
              resolve(); // granted just as the page was hidden
              return;
            }
            leader = true;
            release = () => {
              leader = false;
              release = null;
              resolve();
            };
          })
      )
      // given up before it was granted (AbortError): nothing to undo
      .catch(() => undefined);
  };

  const letGo = () => {
    wanting?.abort();
    wanting = null;
    release?.();
  };

  const follow = () => {
    if (options.canLead()) {
      want();
    } else {
      letGo();
    }
  };

  follow();
  const stopListening = options.onChange(follow);
  return {
    isLeader: () => leader,
    stop: () => {
      stopped = true;
      stopListening();
      letGo();
    },
  };
}
