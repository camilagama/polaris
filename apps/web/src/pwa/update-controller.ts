/**
 * The browser side of the update cycle (plan PR61): notice that a new build is
 * waiting and, when the person asks, make it take over and reload once.
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
  controller: unknown;
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

/** How long a page waits for the new worker to take over before it reloads on its own. */
export const TAKE_OVER_TIMEOUT_MS = 5000;

/**
 * Tells the waiting worker to take over and reloads the page once it has. The
 * reload happens at most once, however many `controllerchange` events arrive.
 *
 * With several tabs open the new worker may stay waiting (no `controllerchange`, and the
 * button grey forever): so if nothing happens within `TAKE_OVER_TIMEOUT_MS` the page
 * reloads anyway, which loads the new build from the network, and `onTimeout` lets the
 * caller enable the button again (a reload that does not happen must not leave it dead).
 * It also reloads at once when there is no waiting worker any more: another tab has
 * already taken it over, and this page only has to load what that tab activated.
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

/**
 * Calls `onTakenOver` when another tab made a new worker take over (the page's controller changed
 * without this page having asked): the files under this tab are now those of the new build.
 * Returns the way to stop. Only a page that already had a controller listens: the first installation
 * does not change it.
 */
export function watchForTakeOver(
  container: ContainerLike,
  onTakenOver: () => void
): () => void {
  if (!container.controller) {
    return () => undefined;
  }
  container.addEventListener("controllerchange", onTakenOver);
  return () => container.removeEventListener("controllerchange", onTakenOver);
}
