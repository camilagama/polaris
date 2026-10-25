import {
  type ContainerLike,
  type RegistrationLike,
  takeOver,
  watchForTakeOver,
  watchForUpdate,
} from "./update-controller";
import {
  type ApplyOutcome,
  applyWhenSafe,
  idleWorkSource,
  NO_PENDING_WORK,
  offerFor,
  type PendingWork,
  type PendingWorkSource,
  type UpdateOffer,
} from "./update-model";

/**
 * The state of the update cycle for the screen (plan PR61): is a new build
 * waiting, what is queued, is an update being applied, and what to tell the
 * person. A small external store so React reads it with `useSyncExternalStore`
 * and tests can drive it without a browser.
 */
export interface UpdateSnapshot {
  applying: boolean;
  /** Why the last attempt did not update, in plain words; null when nothing to say. */
  message: string | null;
  offer: UpdateOffer;
  waiting: boolean;
  work: PendingWork;
}

export interface UpdateStore {
  /** A registration to watch for new builds. */
  attach: (registration: RegistrationLike) => void;
  getSnapshot: () => UpdateSnapshot;
  /** Re-reads the queue (the owner of the outbox calls this when it changes). */
  refreshWork: () => Promise<void>;
  /** The person asked to update: sends first when needed, applies only on an empty queue. */
  requestUpdate: () => Promise<ApplyOutcome | null>;
  setWorkSource: (source: PendingWorkSource) => void;
  subscribe: (listener: () => void) => () => void;
}

interface UpdateStoreOptions {
  container: ContainerLike;
  reload: () => void;
}

const DEFERRED_MESSAGES = {
  queue_not_empty:
    "A atualização fica para depois: ainda há operações na fila. Ela é aplicada quando a fila estiver vazia.",
  sync_failed:
    "Não foi possível enviar as operações agora (sem conexão?). A atualização fica para depois, e nada foi perdido.",
} as const;

export function createUpdateStore({
  container,
  reload,
}: UpdateStoreOptions): UpdateStore {
  let registration: RegistrationLike | null = null;
  let source: PendingWorkSource = idleWorkSource;
  let state = {
    applying: false,
    message: null as string | null,
    waiting: false,
    work: NO_PENDING_WORK,
  };
  let snapshot = snapshotOf(state);
  const listeners = new Set<() => void>();

  function snapshotOf(value: typeof state): UpdateSnapshot {
    return { ...value, offer: offerFor(value.waiting, value.work) };
  }
  function set(next: Partial<typeof state>) {
    state = { ...state, ...next };
    snapshot = snapshotOf(state);
    for (const listener of listeners) {
      listener();
    }
  }
  async function refreshWork() {
    try {
      set({ work: await source.read() });
    } catch {
      // the queue could not be read: keep what is shown, never claim it is empty
    }
  }

  let followed = false;
  /**
   * Another tab applied the update. This one follows (reloads) when it has nothing queued: the outbox is
   * durable, but a tab with work waiting keeps the page it has (the files it asks for are still in the
   * previous build's cache) until its own queue is empty and the person updates, as the model says.
   */
  async function followOtherTab() {
    if (snapshot.applying) {
      return; // this tab asked for it: `takeOver` reloads
    }
    try {
      const { pending, rejected, sending } = await source.read();
      if (pending + sending + rejected > 0) {
        return;
      }
    } catch {
      return; // the queue could not be read: never claim it is empty
    }
    if (!followed) {
      followed = true;
      reload();
    }
  }
  watchForTakeOver(container, () => {
    followOtherTab().catch(() => undefined);
  });

  return {
    attach(next) {
      registration = next;
      watchForUpdate(next, container, (waiting) => {
        set({ message: null, waiting });
        refreshWork().catch(() => undefined);
      });
    },
    getSnapshot: () => snapshot,
    refreshWork,
    async requestUpdate() {
      const current = registration;
      if (!(current && state.waiting) || state.applying) {
        return null;
      }
      set({ applying: true, message: null });
      const outcome = await applyWhenSafe(source, () => {
        const asked = takeOver(current, container, reload, () =>
          set({ applying: false })
        );
        if (!asked) {
          // nothing waits any more: another tab already activated it
          reload();
          set({ applying: false });
        }
      });
      if (outcome.status === "deferred") {
        set({ applying: false, message: DEFERRED_MESSAGES[outcome.reason] });
        await refreshWork();
      }
      return outcome;
    },
    setWorkSource(next) {
      source = next;
      refreshWork().catch(() => undefined);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
