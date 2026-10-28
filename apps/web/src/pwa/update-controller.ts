import type { BuildInfo } from "./sw";

/**
 * The browser side of the update cycle (plan PR61): notice that a new build is
 * waiting, ask a worker which build it serves, and make the waiting one take over
 * and reload once (the moment is the page's: `update-store.ts`).
 *
 * "Waiting" only counts as an update when the page is already controlled by a
 * worker: the very first installation is not an update to offer.
 */
export interface WorkerLike {
  addEventListener: (type: "statechange", listener: () => void) => void;
  postMessage: (message: unknown) => void;
  state: string;
}

export interface RegistrationLike {
  addEventListener: (type: "updatefound", listener: () => void) => void;
  installing: WorkerLike | null;
  removeEventListener: (type: "updatefound", listener: () => void) => void;
  waiting: WorkerLike | null;
}

export interface ContainerLike {
  addEventListener: (type: "controllerchange", listener: () => void) => void;
  controller: Pick<WorkerLike, "postMessage"> | null;
  removeEventListener: (type: "controllerchange", listener: () => void) => void;
}

/** Calls `onChange(true)` whenever a new build is waiting; returns the way to stop. */
export function watchForUpdate(
  registration: RegistrationLike,
  container: ContainerLike,
  onChange: (waiting: boolean) => void
): () => void {
  const report = () => {
    if (registration.waiting && container.controller) {
      onChange(true);
    }
  };
  const track = () => {
    const { installing } = registration;
    installing?.addEventListener("statechange", () => {
      if (installing.state === "installed") {
        report();
      }
    });
  };
  registration.addEventListener("updatefound", track);
  report();
  return () => registration.removeEventListener("updatefound", track);
}

/** How long a page waits for a worker to say which build it serves. */
const BUILD_INFO_TIMEOUT_MS = 2000;

function isBuildInfo(data: unknown): data is BuildInfo {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof (data as BuildInfo).id === "string"
  );
}

/**
 * Asks a worker which build it serves (`BUILD_INFO`, answered on a port of its own); null when it does not answer in
 * time (a worker older than the question).
 */
export function askBuildInfo(
  worker: Pick<WorkerLike, "postMessage"> | null,
  timeoutMs = BUILD_INFO_TIMEOUT_MS
): Promise<BuildInfo | null> {
  if (!worker || typeof MessageChannel === "undefined") {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      resolve(null);
    }, timeoutMs);
    channel.port1.onmessage = (event: MessageEvent) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(
        isBuildInfo(event.data)
          ? {
              activatedAt: event.data.activatedAt ?? null,
              id: event.data.id,
              publishedAt: event.data.publishedAt ?? null,
            }
          : null
      );
    };
    (worker as unknown as Worker).postMessage({ type: "BUILD_INFO" }, [
      channel.port2,
    ]);
  });
}

/** How long a page waits for the new worker to take over before it reloads on its own. */
export const TAKE_OVER_TIMEOUT_MS = 5000;

/**
 * Tells the waiting worker to take over and reloads the page once it has. The
 * reload happens at most once, however many `controllerchange` events arrive.
 *
 * With several tabs open the new worker may stay waiting (no `controllerchange`): so if
 * nothing happens within `TAKE_OVER_TIMEOUT_MS` the page reloads anyway, which loads the
 * new build from the network, and `onTimeout` tells the caller.
 * Only the page that asked listens: the `controllerchange` the other tabs get from it
 * reloads none of them (each one swaps at its own safe moment).
 */
export function takeOver(
  registration: Pick<RegistrationLike, "waiting">,
  container: ContainerLike,
  reload: () => void,
  onTimeout: () => void = () => undefined
): boolean {
  const { waiting } = registration;
  if (!waiting) {
    return false;
  }
  let reloaded = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reloadOnce = () => {
    if (reloaded) {
      return false;
    }
    reloaded = true;
    clearTimeout(timer);
    container.removeEventListener("controllerchange", onChange);
    reload();
    return true;
  };
  function onChange() {
    reloadOnce();
  }
  container.addEventListener("controllerchange", onChange);
  timer = setTimeout(() => {
    if (reloadOnce()) {
      onTimeout();
    }
  }, TAKE_OVER_TIMEOUT_MS);
  waiting.postMessage({ type: "SKIP_WAITING" });
  return true;
}
