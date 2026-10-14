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

/**
 * Tells the waiting worker to take over and reloads the page once it has. The
 * reload happens at most once, however many `controllerchange` events arrive.
 */
export function takeOver(
  registration: Pick<RegistrationLike, "waiting">,
  container: ContainerLike,
  reload: () => void
): boolean {
  const { waiting } = registration;
  if (!waiting) {
    return false;
  }
  let reloaded = false;
  const onChange = () => {
    if (reloaded) {
      return;
    }
    reloaded = true;
    container.removeEventListener("controllerchange", onChange);
    reload();
  };
  container.addEventListener("controllerchange", onChange);
  waiting.postMessage({ type: "SKIP_WAITING" });
  return true;
}
